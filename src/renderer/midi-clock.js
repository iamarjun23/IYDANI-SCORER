// MIDI beat clock — the app and the keyboard counting the SAME bar.
//
// A digital piano has its own metronome, and until now the two ran in
// unrelated worlds: press the metronome on the keyboard and it counted its
// tempo, press the one in the toolbar and it counted ours, and nothing made
// them agree. What connects them is MIDI beat clock — 24 pulses to the quarter
// note (`PPQ`), plus Start / Continue / Stop — which the same cable that
// already carries the notes carries in both directions.
//
// Which end leads is a real choice, not a detail, so both directions exist and
// `state.midiSync` picks one:
//
//   'off'     nothing is sent and arriving clock is ignored.
//   'follow'  the KEYBOARD leads. Its pulses set our tempo and our beat, and
//             its Start/Stop switch our metronome on and off — press the
//             metronome on the piano and the app falls in beside it.
//   'drive'   the APP leads. Playback and the toolbar metronome send Start and
//             a pulse train, so the keyboard's own metronome runs at our tempo
//             and starts on our downbeat. (A keyboard only obeys this once ITS
//             sync is set to external — that switch is on the instrument, and
//             nothing sent over MIDI can throw it for you.)
//
// MIDI carries no audio, so the keyboard's click cannot travel down the wire.
// In 'follow' the sound you hear is the APP's metronome voice, laid on the
// beats the keyboard is counting — one click, ours, in the keyboard's time.
//
// The one thing the wire can fail to carry is WHERE the bar begins: a keyboard
// that free-runs its clock sends an exact tempo and no downbeat at all. That is
// not recoverable by any arithmetic here, so the player settles it with one tap
// on the keyboard's own click — see clockAlign() at the foot of the follower.
//
// This module is PURE: no DOM, no WebMidi, no AudioContext, no state. It
// answers "given these bytes, what beat is due and when", and the wiring in
// midi-input.js / metronome.js / playback.js turns that into sound. That is
// what lets tests/midi-clock.test.mjs drive the whole thing without a device —
// which matters more here than usual, because the failure mode of a clock is
// not an exception, it is music that drifts.

// Pulses per quarter note. Fixed by the MIDI spec; the whole scheme rests on
// both ends counting to the same number.
export const PPQ = 24;

// Six clocks to a sixteenth — what a Song Position Pointer counts in.
const PULSES_PER_16TH = PPQ / 4;

// Pulses of warning before a beat, until the caller measures its audio path
// and says otherwise. Six is a sixteenth note — 125 ms at 120 bpm, which
// covers an ordinary output latency with room to spare.
const DEFAULT_LEAD = 6;

// ---------- following an external clock ----------

// How much of each new pulse interval to believe. Clock jitter over USB is a
// millisecond or two either way, and a period taken from a single interval
// would make the reported tempo flicker by several bpm; averaging the whole
// history instead would take a real ritardando half a minute to notice. 0.12
// settles inside a beat and rides out the jitter.
const SMOOTHING = 0.12;

// Intervals outside this are not tempo, they are a gap — a device paused, a
// port stalled, a tab backgrounded — and folding one into the average would
// drag the tempo somewhere the player never went. The window spans 8-1250 bpm,
// wider than any instrument and narrow enough to reject a stall.
const MIN_PULSE_MS = 20 / 24;
const MAX_PULSE_MS = 300;

// No pulse for this long means the master has gone — unplugged, switched off,
// or simply stopped without sending Stop. Two beats at the slowest tempo the
// app allows (20 bpm) is 6 s; 2 s is long enough that no ordinary tempo trips
// it and short enough that a vanished clock does not leave the app counting on
// alone.
export const CLOCK_IDLE_MS = 2000;

export function newClockFollower() {
  return {
    running: false,
    // Pulses since the last Start, so `pulse / PPQ` is the beat number and the
    // count survives a Continue.
    pulse: 0,
    lastMs: null,
    period: null,
    // Whether this device has ever sent Start/Stop/Continue. Some keyboards
    // free-run their clock and announce nothing, so a follower that waited for
    // a Start would sit silent beside a piano that is plainly ticking — see
    // clockPulse().
    sawTransport: false,
    pulses: 0,
    // The last beat handed out, so a beat is announced exactly once however
    // the lead moves underneath it. -1 means none yet, and the next one due is
    // beat 0.
    announced: -1,
    // How many pulses of warning to give, set by the caller from the output
    // latency it has to cover — see setClockLead(). One pulse (the old fixed
    // value) is 21 ms at 120 bpm, which is less than the latency on most audio
    // paths, so the click could only ever be scheduled late.
    lead: DEFAULT_LEAD,
  };
}

// A beat has to be announced far enough ahead that the sound can be SCHEDULED
// for it rather than started when the message lands. How far is a property of
// the audio path, not of the music, so the caller measures it and sets this;
// see audio.js's outputLatency() and the note in midi-input.js.
//
// Bounded at half a beat because the whole scheme rests on the tempo estimate
// still being true when the beat arrives: a lead longer than that would be
// predicting across a bar of rubato.
export function setClockLead(f, pulses) {
  const n = Math.round(Number(pulses) || 0);
  f.lead = Math.max(1, Math.min(PPQ / 2, n));
  return f.lead;
}

// bpm from a smoothed pulse interval. Null in, null out: nothing is guessed
// before two pulses have been seen.
export function bpmFromPeriod(periodMs) {
  if (!(periodMs > 0)) return null;
  return 60000 / (periodMs * PPQ);
}

function trackPeriod(f, ms) {
  const prev = f.lastMs;
  f.lastMs = ms;
  if (prev == null) return;
  const dt = ms - prev;
  if (!(dt >= MIN_PULSE_MS && dt <= MAX_PULSE_MS)) return;
  f.period = f.period == null ? dt : f.period + (dt - f.period) * SMOOTHING;
}

// One 0xF8, at `ms` on the performance.now() clock. Returns the beat that is
// DUE — `{ beat, atMs, bpm }` — or null on the other 23 pulses of the beat.
//
// A beat is announced ONE PULSE EARLY, timed at `ms + period`, rather than at
// the moment its own pulse lands. Everything that sounds in this app is laid
// down ahead on the audio clock precisely because a sound started the instant
// a callback runs is as late as the frame it landed in; a click slaved to an
// external clock has no more right to that wobble than one of our own. One
// pulse is 21 ms at 120 bpm — ample lead. The exception is the downbeat
// straight after a Start, which nothing precedes: it is timed at `ms` and
// takes whatever lead the audio path can give it.
export function clockPulse(f, ms) {
  trackPeriod(f, ms);
  f.pulses += 1;

  // A device that sends clock but never a Start is still plainly running, and
  // the whole point of 'follow' is that pressing the metronome ON THE PIANO
  // brings the app with it. So a clock arriving out of nowhere is believed
  // after one full beat of it — long enough that a stray pulse proves nothing,
  // short enough to catch the very next bar.
  if (!f.running && !f.sawTransport && f.pulses > PPQ) {
    f.running = true;
    f.pulse = 0;
    f.announced = -1;
  }
  if (!f.running) return null;

  const at = f.pulse;
  f.pulse += 1;
  const bpm = bpmFromPeriod(f.period);

  // The next beat not yet handed out, and how many pulses are left before it.
  // Phrased as "is the next beat within the lead" rather than "is this pulse
  // the one N before a boundary", because the lead MOVES: it is recomputed
  // from the measured latency and the current tempo, and a rule keyed to one
  // exact pulse would silently skip a beat whenever the lead grew past it, or
  // hand the same one out twice when it shrank.
  const next = f.announced + 1;
  const remain = next * PPQ - at;
  if (remain > f.lead) return null;

  // More than a beat overdue means the count has been left far behind — the
  // lead was cut hard, or pulses were dropped. Announcing the backlog one per
  // pulse would replay it 24x too fast, so the count resyncs to where the
  // master actually is and carries on.
  if (remain < -PPQ) {
    f.announced = Math.floor(at / PPQ);
    return null;
  }

  f.announced = next;
  // Timed by the pulses actually remaining, not by the nominal lead, so a beat
  // announced early and one announced late are both timed correctly.
  return { beat: next, atMs: ms + remain * (f.period || 0), bpm };
}

// 0xFA — start from the top. The count restarts at beat 0, and the tempo
// estimate is kept: it is a property of the device, not of this pass.
export function clockStart(f) {
  f.sawTransport = true;
  f.running = true;
  f.pulse = 0;
  f.announced = -1;
  f.lastMs = null;
  return { beat: 0 };
}

// 0xFB — carry on from where the count stood.
export function clockContinue(f) {
  f.sawTransport = true;
  f.running = true;
  f.lastMs = null;
  // The next beat due is the next boundary at or after where the count stands,
  // so resuming part-way through a beat does not re-announce the one already
  // half gone.
  f.announced = Math.ceil(f.pulse / PPQ) - 1;
  return { beat: Math.floor(f.pulse / PPQ) };
}

// 0xFC. The count is left where it stopped, so a Continue can resume it.
export function clockStop(f) {
  f.sawTransport = true;
  f.running = false;
  f.lastMs = null;
}

// 0xF2 — Song Position Pointer, counted in sixteenths. Only meaningful while
// stopped, which is when a sequencer sends it.
export function clockSongPosition(f, sixteenths) {
  const n = Math.max(0, Math.round(Number(sixteenths) || 0));
  f.pulse = n * PULSES_PER_16TH;
  f.announced = Math.ceil(f.pulse / PPQ) - 1;
  return { beat: Math.floor(f.pulse / PPQ) };
}

// Has the master gone quiet? The wiring polls this, so a clock that stops
// without sending Stop — a cable pulled, an instrument switched off — does not
// leave the app waiting for a beat that will never come.
export function clockIdle(f, ms) {
  return f.running && f.lastMs != null && ms - f.lastMs > CLOCK_IDLE_MS;
}

// ---------- when the wire carries no clock at all ----------
//
// Most digital pianos never transmit beat clock. Their metronome is an
// internal affair: it makes a sound in the room and says nothing down the
// cable, and no amount of decoding can recover a pulse train that was never
// sent. For those instruments 'follow' has nothing to follow, and the app's
// metronome counts on beside the piano in its own time — which is exactly what
// "it isn't syncing" means in the field.
//
// What is still available is the click ITSELF, in the room, and a player who
// can hear it. Tapping along with the piano's metronome gives both of the
// things the wire was going to carry: the interval between taps is the TEMPO,
// and the last tap is the DOWNBEAT. That is not a lesser version of clock
// sync, it is the same two facts arriving by ear.
//
// The cost, stated plainly: two free-running crystals, so the two clicks can
// drift apart over a long stretch — a tap or two later puts them back. Tap
// jitter is the real limit, and it does not accumulate.

// A gap longer than this ends the run: it is somebody starting again, not a
// tempo of 20 bpm. 2.5s is slower than any tempo the app will play and short
// enough that an abandoned tap does not poison the next attempt.
export const TAP_TIMEOUT_MS = 2500;

export function newTapTempo() {
  return { last: null, period: null, count: 0 };
}

// One tap, at `ms` on the performance.now() clock. Returns what is known so
// far: `{ count, atMs, period, bpm, nextMs }`, with period/bpm/nextMs null
// until a second tap has given an interval to measure.
//
// The period is a RUNNING MEAN over the current run rather than the last
// interval alone. One interval is a single human reaction and wobbles by tens
// of milliseconds; the mean of four is steady enough to hold a bar, and
// because a run ends at TAP_TIMEOUT_MS it cannot average across two different
// tempi.
export function tapTempo(t, ms) {
  const dt = t.last == null ? null : ms - t.last;
  if (dt == null || !(dt > 0) || dt > TAP_TIMEOUT_MS) {
    // A first tap, or the first of a new run. It is still a downbeat — it just
    // has no tempo behind it yet.
    t.last = ms;
    t.period = null;
    t.count = 1;
    return { count: 1, atMs: ms, period: null, bpm: null, nextMs: null };
  }
  t.last = ms;
  t.count += 1;
  const n = t.count - 1;                       // intervals seen in this run
  t.period = t.period == null ? dt : t.period + (dt - t.period) / n;
  return {
    count: t.count,
    atMs: ms,
    period: t.period,
    bpm: 60000 / t.period,
    // The next beat is one period after the tap, which is where the count is
    // anchored — the tap itself is already in the past by the time it is
    // handled, and a beat cannot be scheduled backwards.
    nextMs: ms + t.period,
  };
}

// A run that has gone quiet. The wiring asks so the dock can stop offering a
// half-finished tap as if it were a tempo.
export function tapStale(t, ms) {
  return t.last == null || ms - t.last > TAP_TIMEOUT_MS;
}

// ---------- driving an external clock ----------
//
// The sender lays pulses down AHEAD on the audio clock, in the same windowed
// pump and off the same beat grid as the notes and the clicks, so the pulse
// train cannot drift against the music it is timing. It keeps no clock of its
// own: anchorClockSender() hands it the origin the transport is already using.

export function newClockSender() {
  return { when: null, pulse: 0 };
}

export function anchorClockSender(s, at) {
  s.when = at;
  s.pulse = 0;
}

export function clockSenderRunning(s) {
  return s.when != null;
}

export function stopClockSender(s) {
  s.when = null;
  s.pulse = 0;
}

// Lay down every pulse falling inside [now, now + ahead). `beatSecs()` is
// called per pulse, not once per window, so a tempo change reaches the device
// within one window exactly as it reaches the notes.
//
// A window that opens long after the last one closed — the tab was in the
// background, the machine slept — must NOT be filled in: those pulses are late
// by definition, and firing hundreds at once would send the instrument racing
// through the bars it missed. The grid jumps to the present instead, which is
// the same re-anchoring the standalone metronome does.
export function pumpClockOut(s, now, ahead, beatSecs, emit) {
  if (s.when == null) return 0;
  if (s.when < now - 0.25) s.when = now;
  let sent = 0;
  // Bounded, so a beatSecs() that has gone to zero cannot spin here forever.
  while (s.when < now + ahead && sent < 4096) {
    emit(s.when, s.pulse);
    s.pulse += 1;
    s.when += beatSecs() / PPQ;
    sent += 1;
  }
  return sent;
}

// ---------- where the master's BAR begins ----------
//
// A keyboard that free-runs its clock sends a perfect tempo and no downbeat.
// The pulses are right, but WHICH of every 24 of them starts a beat is not on
// the wire at all, so the count gets anchored wherever the app happened to
// start believing it — up to a whole beat away from the click the player can
// actually hear. Tempo locked, phase arbitrary; two clicks a third of a beat
// apart is exactly what "it isn't syncing" sounds like.
//
// Nothing in MIDI can settle it, so the player does: a tap on the keyboard's
// own click says "a beat is HERE". Because the tempo is already locked, one
// tap holds for as long as the device keeps counting — this is a phase
// correction, not a tap-tempo that has to be repeated.
//
// Only the PHASE moves. The count is shifted by less than one beat, so the
// tempo estimate, the running state and the announced-beat bookkeeping all
// carry straight over. Returns the beat the count now stands on, or null when
// there is no running clock to align to.
export function clockAlign(f, atMs) {
  if (!f.running || !(f.period > 0) || f.lastMs == null) return null;
  // The pulse index falling at atMs. f.lastMs is the arrival time of pulse
  // f.pulse - 1, since clockPulse() advances the count past the pulse it just
  // handled, so the index runs forward from there.
  const k = (f.pulse - 1) + Math.round((atMs - f.lastMs) / f.period);
  // Only the remainder matters: the whole beats before the tap are already
  // counted correctly, and it is where the boundary falls inside the beat that
  // is wrong.
  const r = ((k % PPQ) + PPQ) % PPQ;
  let p = f.pulse - r;
  if (p < 0) p += PPQ;
  f.pulse = p;
  // The next beat due is the next boundary at or after where the count now
  // stands — the same rule Continue resumes by, so a tap part-way through a
  // beat does not re-announce the one already half gone.
  f.announced = Math.ceil(f.pulse / PPQ) - 1;
  return { beat: Math.floor(f.pulse / PPQ) };
}
