// MIDI beat clock — src/renderer/midi-clock.js.
//
// Worth its own suite because the failure mode of a clock is not an exception.
// A pulse counted one short, a beat announced at the wrong instant, a period
// poisoned by one stalled window: none of them throw, and all of them come out
// as music that will not sit still — which is exactly the class of bug the
// rest of this app schedules ahead on the audio clock to avoid. The module is
// pure, so all of it is reachable here with no device, no browser and no
// AudioContext.

import assert from 'node:assert/strict';
import {
  PPQ, CLOCK_IDLE_MS,
  newClockFollower, clockPulse, clockStart, clockContinue, clockStop,
  clockSongPosition, clockIdle, bpmFromPeriod, setClockLead, clockAlign,
  TAP_TIMEOUT_MS, newTapTempo, tapTempo, tapStale,
  newClockSender, anchorClockSender, clockSenderRunning, stopClockSender, pumpClockOut,
} from '../src/renderer/midi-clock.js';

assert.equal(PPQ, 24, 'the MIDI spec fixes this; both ends count to the same number');

// ---------- tempo from a pulse interval ----------

// 120 bpm is a half-second beat, so 24 pulses of 20.8333ms.
const P120 = 500 / PPQ;
assert.ok(Math.abs(bpmFromPeriod(P120) - 120) < 1e-9);
assert.equal(bpmFromPeriod(null), null, 'nothing is guessed before a period exists');
assert.equal(bpmFromPeriod(0), null, 'and a zero interval is not an infinite tempo');

// ---------- a started clock announces one beat per 24 pulses ----------

{
  const f = newClockFollower();
  clockStart(f);

  const beats = [];
  for (let i = 0; i < PPQ * 4; i++) {
    const due = clockPulse(f, i * P120);
    if (due) beats.push(due);
  }

  // 96 pulses is four beats' worth, and five announcements: the downbeat, and
  // then one on the last pulse before each of beats 1-4. The final one is the
  // lead in action — beat 4's own pulse has not arrived yet.
  assert.deepEqual(beats.map(b => b.beat), [0, 1, 2, 3, 4],
    'beats in order, none repeated and none skipped');

  // Beat 0 is timed at its own pulse — nothing precedes a downbeat straight
  // after a Start, so there is nothing to announce it from.
  assert.equal(beats[0].atMs, 0);

  // Every later beat is announced ONE PULSE EARLY and timed a period on, which
  // with a steady master lands exactly on the beat: pulse 23 sits at 23P and
  // beat 1 falls at 24P. That lead is what lets the click be scheduled ahead
  // on the audio clock instead of started in the callback that received it.
  assert.ok(Math.abs(beats[1].atMs - PPQ * P120) < 1e-6,
    'beat 1 is predicted at exactly its true time');
  assert.ok(Math.abs(beats[2].atMs - 2 * PPQ * P120) < 1e-6);
  assert.ok(Math.abs(beats[3].atMs - 3 * PPQ * P120) < 1e-6);

  for (const b of beats.slice(1)) {
    assert.ok(Math.abs(b.bpm - 120) < 0.5, `tempo reads back as 120, got ${b.bpm}`);
  }
}

// ---------- the lead: how far ahead a beat is announced ----------
//
// This is what makes a followed click SCHEDULABLE instead of merely prompt. A
// beat announced on the pulse before it gives 21 ms of warning at 120 bpm,
// which is less than the output latency on most audio paths — so the click
// could only ever be scheduled late, and against the keyboard's own metronome
// that is an audible flam. The caller measures its latency and sizes the lead;
// see relead() in midi-input.js.

{
  const f = newClockFollower();
  assert.ok(f.lead >= 1 && f.lead <= PPQ / 2, 'a follower starts with a usable lead');

  assert.equal(setClockLead(f, 0), 1, 'a beat is never announced on its own pulse');
  assert.equal(setClockLead(f, 999), PPQ / 2,
    'and never more than half a beat ahead — past that the tempo estimate is a guess');
  assert.equal(setClockLead(f, 6), 6);
}

// Whatever the lead, every beat is announced exactly once and at its true time.
for (const lead of [1, 3, 6, 12]) {
  const f = newClockFollower();
  setClockLead(f, lead);
  clockStart(f);

  const beats = [];
  for (let i = 0; i < PPQ * 4; i++) {
    const due = clockPulse(f, i * P120);
    if (due) beats.push(due);
  }

  const seen = beats.map(b => b.beat);
  assert.deepEqual(seen, [...new Set(seen)], `lead ${lead}: no beat announced twice`);
  assert.deepEqual(seen, seen.slice().sort((a, b) => a - b), `lead ${lead}: in order`);
  assert.deepEqual(seen, seen.map((_, i) => i), `lead ${lead}: none skipped`);

  for (const b of beats.slice(1)) {
    assert.ok(Math.abs(b.atMs - b.beat * PPQ * P120) < 1e-6,
      `lead ${lead}: beat ${b.beat} is timed at its true moment, not at the lead's nominal one`);
  }
  // The warning actually given is the lead, in real milliseconds.
  const announcedAt = (PPQ - lead) * P120;
  assert.ok(Math.abs(beats[1].atMs - announcedAt - lead * P120) < 1e-6,
    `lead ${lead}: beat 1 arrives ${lead} pulses before it is due`);
}

// The lead MOVES — it is recomputed from the measured latency and the tempo,
// both of which change under the count. Growing it must not skip the beat it
// steps over, and shrinking it must not hand the same beat out twice. This is
// why the rule is "is the next beat within the lead" and not "is this pulse
// the one N before a boundary".
{
  const f = newClockFollower();
  setClockLead(f, 2);
  clockStart(f);

  const beats = [];
  for (let i = 0; i < PPQ * 4; i++) {
    // Jump the lead right past the boundary the old rule was keyed to, then
    // pull it back in again, repeatedly.
    if (i === 17) setClockLead(f, 10);
    if (i === 30) setClockLead(f, 1);
    if (i === 60) setClockLead(f, 12);
    const due = clockPulse(f, i * P120);
    if (due) beats.push(due.beat);
  }
  assert.deepEqual(beats, [0, 1, 2, 3, 4],
    'every beat survives the lead moving underneath it, exactly once each');
}

// ---------- the tempo estimate rides out jitter but follows a real change ----------

{
  const f = newClockFollower();
  clockStart(f);
  let t = 0;
  // A steady 120 with a millisecond of jitter either way — USB, not rubato.
  const jit = [0.9, -0.7, 0.4, -1.1, 0.2, 0.8, -0.5];
  let last = null;
  for (let i = 0; i < PPQ * 8; i++) {
    const due = clockPulse(f, t);
    if (due) last = due;
    t += P120 + jit[i % jit.length];
  }
  assert.ok(Math.abs(last.bpm - 120) < 3,
    `jitter must not move the reported tempo, got ${last.bpm}`);

  // Now the player really does speed up, to 160.
  const P160 = (60000 / 160) / PPQ;
  for (let i = 0; i < PPQ * 8; i++) {
    const due = clockPulse(f, t);
    if (due) last = due;
    t += P160;
  }
  assert.ok(Math.abs(last.bpm - 160) < 2,
    `a real tempo change must be followed within a few beats, got ${last.bpm}`);
}

// ---------- a stall is a gap, not a tempo ----------

{
  const f = newClockFollower();
  clockStart(f);
  let t = 0;
  for (let i = 0; i < PPQ * 2; i++) { clockPulse(f, t); t += P120; }
  const before = f.period;

  // The tab was backgrounded for four seconds. Folding that into the average
  // would report a tempo of about half a bpm and drag the app's own tempo
  // field down with it.
  t += 4000;
  clockPulse(f, t);
  assert.equal(f.period, before, 'an interval outside the sane window is discarded whole');
}

// ---------- a device that never sends Start is still plainly running ----------

{
  const f = newClockFollower();
  let beats = 0;
  for (let i = 0; i < PPQ; i++) {
    if (clockPulse(f, i * P120)) beats++;
  }
  assert.equal(beats, 0, 'one beat of unannounced clock proves nothing yet');
  assert.equal(f.running, false);

  const due = clockPulse(f, PPQ * P120);
  assert.equal(f.running, true, 'past a full beat of it, the master is believed');
  assert.ok(due && due.beat === 0, 'and the count opens on a downbeat');
}

// A device that DOES announce itself is never auto-run behind its own Stop.
{
  const f = newClockFollower();
  clockStart(f);
  clockStop(f);
  let beats = 0;
  for (let i = 0; i < PPQ * 3; i++) {
    if (clockPulse(f, i * P120)) beats++;
  }
  assert.equal(beats, 0, 'clock after an explicit Stop counts nothing');
  assert.equal(f.running, false);
}

// ---------- Stop, Continue and Song Position ----------

{
  const f = newClockFollower();
  clockStart(f);
  let t = 0;
  for (let i = 0; i < PPQ * 2; i++) { clockPulse(f, t); t += P120; }

  clockStop(f);
  assert.equal(f.running, false);

  // Continue resumes the COUNT — a Start would restart it, and the two are
  // different buttons on the instrument for a reason.
  const at = clockContinue(f);
  assert.equal(at.beat, 2, 'two full beats had gone by');
  assert.equal(f.running, true);

  // Song Position is counted in sixteenths: 16 of them is four quarter notes.
  clockStop(f);
  const moved = clockSongPosition(f, 16);
  assert.equal(moved.beat, 4);
  assert.equal(f.pulse, 16 * (PPQ / 4));

  // Start throws all of that away and returns to the top.
  assert.equal(clockStart(f).beat, 0);
  assert.equal(f.pulse, 0);
}

// ---------- a master that vanishes without saying Stop ----------

{
  const f = newClockFollower();
  clockStart(f);
  clockPulse(f, 1000);
  assert.equal(clockIdle(f, 1000 + CLOCK_IDLE_MS - 1), false);
  assert.equal(clockIdle(f, 1000 + CLOCK_IDLE_MS + 1), true,
    'a cable pulled mid-count must not leave the app waiting on a beat forever');

  clockStop(f);
  assert.equal(clockIdle(f, 1e9), false, 'a stopped clock is not an idle one');
}

// ---------- driving: the outgoing pulse train ----------

const SEC120 = 0.5;
const beat120 = () => SEC120;

{
  const s = newClockSender();
  assert.equal(clockSenderRunning(s), false);
  // Nothing goes out before an anchor: the train has no clock of its own and
  // must not invent an origin the transport did not give it.
  assert.equal(pumpClockOut(s, 0, 0.15, beat120, () => {
    throw new Error('an unanchored sender must emit nothing');
  }), 0);

  anchorClockSender(s, 1.0);
  assert.equal(clockSenderRunning(s), true);

  const sent = [];
  const emit = (at, n) => sent.push({ at, n });

  // The window is [0.95, 1.10) and the anchor is at 1.0, so 100 ms of it holds
  // pulses — five of them, at 20.833 ms apart. Windowed exactly as the notes
  // and the clicks are, so the train cannot drift against the music it times.
  pumpClockOut(s, 0.95, 0.15, beat120, emit);
  assert.deepEqual(sent.map(p => p.n), [0, 1, 2, 3, 4],
    'every pulse inside the window and none outside it');
  assert.equal(sent[0].at, 1.0, 'the first pulse lands on the anchor');
  assert.ok(Math.abs(sent[1].at - (1.0 + SEC120 / PPQ)) < 1e-9);

  // Run a whole beat out and check the count: 24 pulses to the quarter, with
  // pulse 24 falling exactly one beat after the anchor.
  const all = [];
  for (let w = 0; w < 40; w++) pumpClockOut(s, 0.95 + w * 0.05, 0.15, beat120, (at, n) => all.push({ at, n }));
  const beatPulse = all.find(p => p.n === PPQ);
  assert.ok(beatPulse, 'the train reaches the next beat');
  assert.ok(Math.abs(beatPulse.at - (1.0 + SEC120)) < 1e-9,
    'pulse 24 is one beat after pulse 0 — that is the whole contract');
}

// A tempo change reaches the device inside one window, because beatSecs() is
// read per pulse rather than once per window.
{
  const s = newClockSender();
  anchorClockSender(s, 0);
  let secs = 0.5;
  const gaps = [];
  let prev = null;
  const emit = at => { if (prev != null) gaps.push(at - prev); prev = at; };
  pumpClockOut(s, 0, 0.1, () => secs, emit);
  const slow = gaps.length;
  secs = 0.25;                       // 120 -> 240 bpm, mid-score
  pumpClockOut(s, 0.1, 0.1, () => secs, emit);
  assert.ok(gaps.length - slow > slow,
    'twice the tempo puts more than twice as many pulses in the same window');
  assert.ok(Math.abs(gaps[gaps.length - 1] - 0.25 / PPQ) < 1e-9,
    'and the last gap is the NEW tempo, not the old one');
}

// A window that opens long after the last one closed must not be filled in.
{
  const s = newClockSender();
  anchorClockSender(s, 0);
  pumpClockOut(s, 0, 0.15, beat120, () => {});
  // The machine slept for a minute. Sending the pulses it missed would race
  // the instrument through every bar it sat out.
  const late = [];
  pumpClockOut(s, 60, 0.15, beat120, at => late.push(at));
  assert.ok(late.length < 10, `a stale grid jumps to the present, got ${late.length} pulses`);
  assert.ok(late[0] >= 60, 'and starts from now, not from where it left off');

  stopClockSender(s);
  assert.equal(clockSenderRunning(s), false);
  assert.equal(pumpClockOut(s, 60, 0.15, beat120, () => {
    throw new Error('a stopped sender must emit nothing');
  }), 0);
}

// A tempo that has gone to zero must not spin the pump forever. beatSeconds()
// in config.js guards against this upstream, but the loop that consumes it is
// the one that would hang.
{
  const s = newClockSender();
  anchorClockSender(s, 0);
  let n = 0;
  pumpClockOut(s, 0, 0.15, () => 0, () => { n++; });
  assert.ok(n > 0 && n <= 4096, `the pump is bounded, emitted ${n}`);
}

// ---------- the player saying where the bar begins ----------
//
// A free-running device sends a perfect tempo and no bar position at all, so
// the count is anchored wherever the app started believing it — up to a whole
// beat away from the click the player can hear. clockAlign() moves that phase
// and NOTHING else.
{
  const f = newClockFollower();
  // Free-run: no Start, so the count is believed after one beat of pulses and
  // beat 0 lands wherever that happened to be.
  let t = 0;
  for (let i = 0; i < PPQ * 2; i++, t += P120) clockPulse(f, t);

  const tempo = f.period;
  const beforeRunning = f.running;

  // The player taps 3.5 pulses after the last one. The nearest pulse to the
  // tap becomes a beat boundary.
  const tapAt = f.lastMs + 3.5 * P120;
  const at = clockAlign(f, tapAt);
  assert.ok(at, 'a running clock can be aligned');
  assert.equal(f.running, beforeRunning, 'aligning is not a transport message');
  assert.equal(f.period, tempo, 'and it must not touch the tempo estimate');

  // From here on every announced beat sits on the tapped grid, within the half
  // pulse the tap could not resolve.
  const beats = [];
  for (let i = 0; i < PPQ * 4; i++, t += P120) {
    const due = clockPulse(f, t);
    if (due) beats.push(due.atMs);
  }
  assert.ok(beats.length >= 3, `beats must keep coming after a tap, got ${beats.length}`);
  for (const b of beats) {
    const off = (((b - tapAt) % 500) + 500) % 500;
    assert.ok(Math.min(off, 500 - off) <= P120 / 2 + 1e-6,
      `a beat landed off the tapped downbeat by ${Math.min(off, 500 - off)}ms`);
  }
  // No beat is handed out twice, which is what f.announced is for.
  for (let i = 1; i < beats.length; i++) {
    assert.ok(beats[i] - beats[i - 1] > 1, 'a beat was announced twice');
  }
}

// Nothing to align against is not an error, it is a no-op: the button is only
// offered while a master is running, but a stopped clock must not be shifted
// into a phase it will not resume from.
{
  const f = newClockFollower();
  assert.equal(clockAlign(f, 0), null, 'a clock that never ran cannot be aligned');
  clockStart(f);
  assert.equal(clockAlign(f, 0), null, 'nor one with no measured period yet');
  clockStop(f);
  assert.equal(clockAlign(f, 0), null, 'nor a stopped one');
}

// ---------- when the wire carries no clock at all ----------
//
// Most digital pianos transmit none. The click is still in the room and the
// player can still hear it, so the two facts the wire was going to carry — the
// tempo and the downbeat — arrive by ear instead.
{
  const t = newTapTempo();
  assert.equal(tapStale(t, 0), true, 'nothing tapped yet is stale by definition');

  const first = tapTempo(t, 1000);
  assert.equal(first.count, 1);
  assert.equal(first.bpm, null, 'one tap has no interval in it, so no tempo');
  assert.equal(first.nextMs, null, 'and nothing to anchor a count on');
  assert.equal(tapStale(t, 1000), false, 'but a run has begun');

  const second = tapTempo(t, 1500);
  assert.equal(second.count, 2);
  assert.ok(Math.abs(second.bpm - 120) < 1e-9, 'half a second between taps is 120 bpm');
  assert.equal(second.nextMs, 2000, 'the next beat is one period after the tap');

  // A wobbly third tap moves the estimate by a FRACTION of its error, because
  // the period is the mean of the run and not the last interval alone. One
  // interval is a single human reaction; four of them hold a bar.
  const third = tapTempo(t, 2100);          // 600ms — 100ms late
  assert.ok(third.period > 500 && third.period < 600,
    `a late tap must pull the mean, not become it — got ${third.period}`);
  assert.ok(Math.abs(third.period - 550) < 1e-9, 'mean of 500 and 600');
}

// A gap longer than the timeout is somebody starting again, not a tempo of
// 20 bpm. Averaging across it would carry the abandoned attempt into the new
// one.
{
  const t = newTapTempo();
  tapTempo(t, 0);
  tapTempo(t, 500);
  const after = tapTempo(t, 500 + TAP_TIMEOUT_MS + 1);
  assert.equal(after.count, 1, 'a stale gap starts the run over');
  assert.equal(after.bpm, null, 'with no tempo carried across it');
  assert.equal(tapStale(t, 500 + TAP_TIMEOUT_MS + 1), false, 'and the new run is live');
}

// A tap that lands on the same millisecond, or before the last one, is not an
// interval — 60000/0 is Infinity and would poison every beat scheduled after
// it, exactly the way beatSeconds() guards against in config.js.
{
  const t = newTapTempo();
  tapTempo(t, 1000);
  const same = tapTempo(t, 1000);
  assert.equal(same.bpm, null, 'a zero interval is not an infinite tempo');
  assert.equal(same.count, 1, 'it starts the run instead');
}

console.log('midi-clock: ok');
