// The metronome.
//
// It counts the METRE, not just a pulse: the accent falls on every group start
// the time signature declares, so a 3+2+2 ticks loud on beats 1, 4 and 6 and
// the division line always gets one. Accenting the downbeat alone would make an
// additive metre sound exactly like a plain seven, which is the whole thing the
// formula exists to say.
//
// It runs in two situations and they are NOT two implementations:
//
//   during playback  playback.js owns the beat grid and calls clickForBeat()
//                    from inside its own scheduling pump, so the clicks come
//                    off the very same accumulation as the notes — same
//                    origin, same beatSeconds(), read at the same moment.
//                    They cannot drift apart because there is nothing for them
//                    to drift against.
//   on its own       the loop below runs the same grid from the moment the
//                    button was pressed.
//
// Both lay their sound down AHEAD on the audio clock rather than starting it
// when a timer fires: a click started by a timer lands several milliseconds
// late depending on what the main thread was doing, and a click that wanders
// is worse than no click at all. It is what the player counts against.
//
// Everything is built on audio.js's context — see audioCtx(). This module used
// to create a SECOND AudioContext, which is why the metronome would not play
// with the music: two contexts have unrelated clocks, so no amount of correct
// arithmetic on either could line them up.

import { state } from './state.js';
import { beatSeconds as tempoBeat } from './config.js';
import { beatsPerBox, isGroupStart } from './timesig.js';
import { onMetronomeTick, stopMetronomeEntry } from './score.js';
import { audioCtx, audioNow } from './audio.js';
import { clockSink, sendClockAt, sendClockStart, sendClockStop } from './midi-out.js';
import {
  newClockSender, anchorClockSender, clockSenderRunning, stopClockSender, pumpClockOut,
} from './midi-clock.js';

// Matched to playback.js — the two transports have to lay their sound down the
// same way or they will not agree at the same bpm.
const TICK_MS = 25;
const SCHEDULE_AHEAD = 0.15;
const LEAD_IN = 0.08;

let timer = null;
let noiseBuf = null;

// The standalone loop's grid. Module-level rather than closed over inside
// startMetronome() because changing the METRE has to be able to reset it —
// see onTalaChanged().
let beat = 0;
let when = null;      // null = the grid needs anchoring to the clock

// Where the count is to be RE-anchored, on the audio clock, when somebody
// outside this module knows better than "a moment from now". That is the tap
// path: a player matching a keyboard's own metronome by ear has just said
// where the next beat is, and dropping that on the floor and anchoring at
// now + LEAD_IN would be the app deciding it knew better. Consumed once —
// after that the grid runs on its own accumulation like any other.
let nextAnchor = null;

// The tapped grid itself, KEPT. A downbeat placed by hand has to survive the
// metronome button being pressed twice: the tempo has not changed, so the bar
// is still where the player put it, and re-anchoring at `now + LEAD_IN` threw
// it away silently — measured at a third of a beat out, with the dock still
// reporting the bar as lined up. So the origin and the beat it was placed at
// are remembered, and a restart PROJECTS that same grid forward instead of
// starting a new one.
//
// It is only valid while the tempo it was measured at still stands: a grid is
// an origin AND a spacing, and half of one is not a bar. anchorHeld() is the
// one question, so the dock cannot claim an alignment the pump would not use.
let anchorAt = null;
let anchorPer = null;

export function anchorHeld() {
  return anchorAt != null && anchorPer > 0 && Math.abs(beatSeconds() - anchorPer) < 1e-9;
}

// Forget it. Called where the grid stops meaning anything — a different
// device, or an external master taking the bar back.
export function clearMetronomeAnchor() {
  anchorAt = null;
  anchorPer = null;
}

// The pulse train this loop sends out when the APP is leading. Module-level
// for the same reason the grid is: switching sync on or off mid-count has to
// be able to start and stop it. See midi-clock.js.
const sender = newClockSender();

// Where the voices are built: the live context, straight to the speakers —
// except for the length of one renderClicks() call, which points every voice
// below at an OFFLINE context so the MP3 gets the very clicks the editor plays
// rather than a second set written to resemble them.
let offline = null;
const audio = () => offline || audioCtx();

// One beat, in seconds — the same guarded answer the transport schedules by,
// so the click and the note cannot be laid on two different tempi.
export function beatSeconds() {
  return tempoBeat(state.bpm);
}

// How many beats to a division, from the METRE. Guarded for the same reason:
// `beat % 0` is NaN, and a NaN beat position is never a group start, so the
// accent would silently never fire again.
export function beatsPerCycle() {
  const b = Math.round(Number(beatsPerBox()) || 0);
  return b > 0 ? b : 1;
}

function noise() {
  const a = audio();
  if (!noiseBuf) {
    noiseBuf = a.createBuffer(1, a.sampleRate * 0.2, a.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = a.createBufferSource();
  src.buffer = noiseBuf;
  return src;
}

// ---- voice building blocks ----
//
// Every preset is built from two primitives: a pitched `tone` and a bandpassed
// noise `hit`. Both use a percussive envelope — a 2ms attack, then exponential
// decay to silence — which is what makes a click read as a strike rather than
// a beep. The first beat of each box is an ACCENT: louder, and a little
// brighter so it stands out even at low volume.

const ACCENT_GAIN = 2.3;
const ACCENT_PITCH = 1.22;

// Clicks already laid on the clock but not yet sounded. Stopping the transport
// has to silence these too — up to SCHEDULE_AHEAD of them are queued at any
// moment, and without this they keep ticking after the button goes dark.
//
// The click bus deliberately does NOT go through audio.js's master limiter:
// the accent is meant to be louder than the music, and pushing it through the
// music's limiter would make every accent duck the note under it.
const pending = new Set();

function track(node) {
  if (offline) return node;      // a render has no transport to stop
  pending.add(node);
  node.addEventListener?.('ended', () => pending.delete(node), { once: true });
  return node;
}

export function stopScheduledClicks() {
  pending.forEach(n => { try { n.stop(); } catch { /* already finished */ } });
  pending.clear();
}

// Every voice below takes the audio-clock time it should sound at, rather than
// reading `currentTime` for itself, so a whole window of clicks can be laid
// down in advance.
function shape(node, t, peak, decay) {
  const a = audio();
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  node.connect(g).connect(a.destination);
}

function tone(freq, { type = 'sine', peak = 0.3, decay = 0.06, sweepTo = 0, at = null } = {}) {
  const a = audio();
  const t = at == null ? a.currentTime : Math.max(at, a.currentTime);
  const o = a.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (sweepTo) o.frequency.exponentialRampToValueAtTime(sweepTo, t + decay);
  shape(o, t, peak, decay);
  o.start(t);
  o.stop(t + decay + 0.02);
  track(o);
}

function hit(freq, { q = 6, peak = 0.4, decay = 0.04, at = null } = {}) {
  const a = audio();
  const t = at == null ? a.currentTime : Math.max(at, a.currentTime);
  const src = noise();
  const bp = a.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = freq;
  bp.Q.value = q;
  src.connect(bp);
  shape(bp, t, peak, decay);
  src.start(t);
  src.stop(t + decay + 0.02);
  track(src);
}

// A struck bell: a fundamental and the two inharmonic partials that make it a
// bell and not a beep, each dying sooner than the one below it.
function bell(freq, at, peak) {
  tone(freq, { peak, decay: 0.42, at });
  tone(freq * 2.76, { peak: peak * 0.3, decay: 0.18, at });
  tone(freq * 5.4, { peak: peak * 0.12, decay: 0.07, at });
}

// ---- sound presets ----
// Each takes the accent flag — `g` scales loudness, `f` pitch — and `at`, the
// audio-clock time the click is due. Every voice a preset builds must be given
// `at`, or that layer of the click drifts away from the rest of it. `down` is
// the first beat of the cycle, for the voices that mark the bar differently
// from a group start inside it.
//
// state.metroSound is an INDEX into this table, so the first entry is what a
// new session opens on.

const SOUNDS = [
  {
    id: 'keyboard', name: 'Keyboard',
    // What a digital piano's own metronome does: a bell on the first beat of
    // the bar and a dry click on the rest. A group start inside the bar gets
    // the click, accented — a bell on each would make 4+2 sound like two bars.
    play: (g, f, at, down) => {
      if (down) {
        bell(2093, at, 0.26);
        hit(3000, { q: 2, peak: 0.14, decay: 0.01, at });
        return;
      }
      hit(3000 * f, { q: 2, peak: 0.16 * g, decay: 0.01, at });
      tone(1570 * f, { type: 'triangle', peak: 0.2 * g, decay: 0.03, at });
    },
  },
  {
    id: 'click', name: 'Click',
    // Triangle rather than square — same clarity without the buzzy edge.
    play: (g, f, at) => {
      hit(4200 * f, { q: 1.2, peak: 0.10 * g, decay: 0.008, at });
      tone(1250 * f, { type: 'triangle', peak: 0.22 * g, decay: 0.04, at });
    },
  },
  {
    id: 'woodblock', name: 'Woodblock',
    play: (g, f, at) => {
      hit(1150 * f, { q: 14, peak: 0.45 * g, decay: 0.03, at });
      tone(940 * f, { type: 'triangle', peak: 0.18 * g, decay: 0.055, sweepTo: 780 * f, at });
    },
  },
  {
    id: 'cowbell', name: 'Cowbell',
    // The classic two detuned tones, decayed shorter so it does not ring over
    // the next beat at fast tempi.
    play: (g, f, at) => {
      tone(560 * f, { type: 'triangle', peak: 0.16 * g, decay: 0.13, at });
      tone(845 * f, { type: 'triangle', peak: 0.11 * g, decay: 0.11, at });
    },
  },
  {
    id: 'tabla', name: 'Tabla',
    // Accent is the low bass stroke (dha), the off-beats the higher rim (na) —
    // the way a real accompanist marks the cycle.
    play: (g, f, at) => (f > 1
      ? (tone(195, { peak: 0.55, decay: 0.24, sweepTo: 85, at }), hit(280, { q: 3, peak: 0.22, decay: 0.04, at }))
      : (tone(430, { peak: 0.20, decay: 0.09, sweepTo: 390, at }), hit(1600, { q: 5, peak: 0.14, decay: 0.03, at }))),
  },
  {
    id: 'beep', name: 'Beep',
    play: (g, f, at) => tone(900 * f, { peak: 0.24 * g, decay: 0.07, at }),
  },
  {
    id: 'tick', name: 'Tick',
    // Dry and tiny — a wristwatch tick for when anything pitched is a distraction.
    play: (g, f, at) => hit(5200 * f, { q: 1.6, peak: 0.30 * g, decay: 0.012, at }),
  },
  {
    id: 'rim', name: 'Rim',
    play: (g, f, at) => {
      hit(2400 * f, { q: 3, peak: 0.28 * g, decay: 0.018, at });
      tone(1800 * f, { type: 'triangle', peak: 0.10 * g, decay: 0.025, at });
    },
  },
  {
    id: 'mechanical', name: 'Mechanical',
    // A wind-up pendulum: a wooden tock, and the small bell such a metronome
    // rings on the bar.
    play: (g, f, at, down) => {
      hit(900 * f, { q: 4, peak: 0.4 * g, decay: 0.022, at });
      tone(820 * f, { type: 'triangle', peak: 0.16 * g, decay: 0.03, sweepTo: 600 * f, at });
      hit(2600, { q: 3, peak: 0.08 * g, decay: 0.008, at });
      if (down) bell(2637, at, 0.14);
    },
  },
  {
    id: 'digital', name: 'Digital',
    // A quartz practice metronome: one short square beep, an octave up on the bar.
    play: (g, f, at, down) => tone(down ? 1760 : 880 * f,
      { type: 'square', peak: 0.07 * g, decay: 0.05, at }),
  },
  {
    id: 'clave', name: 'Clave',
    play: (g, f, at) => {
      tone(2400 * f, { peak: 0.2 * g, decay: 0.045, at });
      hit(2400 * f, { q: 16, peak: 0.3 * g, decay: 0.012, at });
    },
  },
  {
    id: 'sticks', name: 'Sticks',
    // A drummer's count-in.
    play: (g, f, at) => {
      hit(1800 * f, { q: 3, peak: 0.5 * g, decay: 0.02, at });
      hit(5200, { q: 1.5, peak: 0.08 * g, decay: 0.008, at });
      tone(1650 * f, { type: 'triangle', peak: 0.07 * g, decay: 0.025, sweepTo: 1300 * f, at });
    },
  },
  {
    id: 'hihat', name: 'Hi-hat',
    // Closed on the beat, a little open on the accent.
    play: (g, f, at) => hit(8500, { q: 0.8, peak: 0.2 * g, decay: f > 1 ? 0.09 : 0.03, at }),
  },
];

function currentSound() {
  const i = Math.max(0, Math.min(SOUNDS.length - 1, state.metroSound || 0));
  return SOUNDS[i];
}

function click(accent, at = null, down = accent) {
  currentSound().play(accent ? ACCENT_GAIN : 1, accent ? ACCENT_PITCH : 1, at, down);
}

// Beat `beat` of the score, due at audio-clock time `at`. THE one place a beat
// number becomes a sound, so the standalone loop and playback cannot accent
// differently — whether a beat is accented is a question about the metre, and
// it gets the same answer whoever is asking.
export function clickForBeat(beat, at) {
  const n = beatsPerCycle();
  const pos = ((beat % n) + n) % n;
  click(isGroupStart(pos), at, pos === 0);
}

// The count for an OFFLINE render — MP3 export. Beat k at k * `beat` seconds
// for as long as there is music, which is the grid startPlay() runs: beat 0 on
// the first note, and no ticking on over the silence after the last one.
// Through clickForBeat(), so the file accents exactly as the editor does.
export function renderClicks(ctx, beat, seconds) {
  offline = ctx;
  try {
    for (let k = 0; k * beat < seconds - 1e-6; k += 1) clickForBeat(k, k * beat);
  } finally {
    offline = null;
  }
}

// One beat, sounded and counted. TWO things happen on a beat and they belong
// together: the click, and the entry hook metro fill writes its rests off.
// This loop and the external-clock follower in midi-input.js both go through
// here, so a beat counted by the keyboard fills the staff exactly as a beat
// counted by this loop does.
//
// The hook belongs to the moment the click is HEARD, not to the moment it was
// scheduled — everything here is laid down a window in advance.
export function emitBeat(beat, at) {
  clickForBeat(beat, at);
  setTimeout(onMetronomeTick, Math.max(0, (at - audioNow()) * 1000));
}

// Is an external master counting for us? Both halves matter: the player has to
// have asked to follow AND a clock has to actually be running, so a keyboard
// that sends nothing leaves the app counting for itself rather than silent.
export function followingClock() {
  return state.midiSync === 'follow' && state.midiClockRunning;
}

// ---------- driving the keyboard's metronome ----------

// Begin (or restart) the outgoing pulse train on the beat grid's own origin,
// so the instrument's downbeat is our downbeat rather than merely our tempo.
function startDriving(at) {
  sendClockStart(at);
  anchorClockSender(sender, at);
}

export function stopDriving() {
  if (!clockSenderRunning(sender)) return;
  stopClockSender(sender);
  sendClockStop();
}

// Lay this window's pulses down beside this window's clicks, off the same
// grid. Called from the pump rather than from a clock of its own — a second
// timer would be a second opinion about where the beat is.
function driveClock(now, ahead, anchor) {
  if (!clockSink()) return stopDriving();
  if (!clockSenderRunning(sender)) startDriving(anchor);
  pumpClockOut(sender, now, ahead, beatSeconds, sendClockAt);
}

function setBtnState(on) {
  const btn = document.getElementById('metroBtn');
  if (!btn) return;
  btn.classList.toggle('on', on);
  btn.title = `Metronome — ${currentSound().name}`;
}

export function setMetronomeSound(id) {
  const i = SOUNDS.findIndex(s => s.id === id);
  if (i < 0) return;
  state.metroSound = i;
  setBtnState(state.metroOn);
  click(true);   // preview the accent, so the choice is audible right away
}

// Fill the toolbar dropdown from SOUNDS, so adding a preset above is the only
// edit needed.
export function installMetronomeSounds() {
  const sel = document.getElementById('metroSound');
  if (!sel) return;
  sel.innerHTML = SOUNDS.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  sel.value = currentSound().id;
  sel.addEventListener('change', () => setMetronomeSound(sel.value));
  setBtnState(false);
}

// A new time signature is a new cycle, so the count starts again from its
// first beat. Without this the beat number carries on across the change and
// the modulo lands wherever it happens to: switch a running 4 to a 4+2 on
// beat 7 and the next accent comes five beats later, in the middle of a
// group. What is being counted changed, so the count restarts — the same
// thing a player does.
function onTalaChanged() {
  if (!state.metroOn) return;
  when = null;
  // A new metre is a new cycle, so a placed downbeat is not projected across
  // it — the count starts again from its own first beat, which is what a
  // player does. Without this the projection would carry the old beat number
  // through the change and the next accent would land inside a group.
  clearMetronomeAnchor();
}

export function startMetronome() {
  if (state.metroOn) return;
  state.metroOn = true;
  setBtnState(true);
  document.addEventListener('tala:changed', onTalaChanged);

  beat = 0;
  when = null;

  // Same loop shape as playback.js: lay down every click that falls inside the
  // window, reading bpm fresh so a tempo change applies within one window.
  const pump = () => {
    const now = audioNow();

    // While the transport is running it OWNS the grid — it emits the clicks
    // from inside its own pump, off the same accumulation as the notes. This
    // loop stands down rather than laying a second, independent set of clicks
    // over them, and drops its anchor so it restarts in step when playback
    // ends instead of firing a catch-up burst for the time it sat out.
    if (state.playing) { when = null; return; }

    // The KEYBOARD is counting — see midi-clock.js. Its pulses emit the beats
    // through emitBeat(), so this loop stands down for exactly the reason it
    // stands down under playback: two grids counting the same bar is not a
    // sync, it is a flam. The anchor is dropped so it restarts in step if the
    // master goes away, and the outgoing train is stopped because leading and
    // following are the same choice made two ways.
    if (followingClock()) {
      when = null;
      stopDriving();
      return;
    }

    // Anchor on the first pump, and re-anchor after anything that left the
    // grid in the past — playback finishing, or the tab being backgrounded
    // long enough that the clock ran away from us.
    if (when == null || when < now - 0.25) {
      // A caller that named the moment wins, provided the moment has not
      // itself gone stale while the pump was standing down.
      if (nextAnchor != null && nextAnchor > now - 0.25) {
        when = nextAnchor;
        beat = 0;
      } else if (anchorHeld()) {
        // A grid placed by hand, projected forward to the next of ITS beats at
        // or after now. The beat NUMBER carries too, so the accent lands where
        // the player put the downbeat rather than wherever the restart fell.
        const k = Math.max(0, Math.ceil((now - anchorAt) / anchorPer));
        when = anchorAt + k * anchorPer;
        beat = k;
      } else {
        when = now + LEAD_IN;
        beat = 0;
      }
      nextAnchor = null;
      stopDriving();     // a new origin is a new Start, not a continuation
    }

    // Before the clicks, so the instrument gets this window's Start ahead of
    // the pulses that follow it rather than half a window behind them.
    driveClock(now, SCHEDULE_AHEAD, when);

    while (when < now + SCHEDULE_AHEAD) {
      emitBeat(beat, when);
      beat += 1;
      when += beatSeconds();
    }
  };
  timer = setInterval(pump, TICK_MS);
  pump();
}

// Put the count's next beat AT `at` (audio clock) and call it beat 0, starting
// the metronome if it is not already running.
//
// The one way in for a beat this module did not work out for itself. It is
// what turns a tap on the keyboard's own click into a shared bar: the tempo
// arrives through state.bpm as usual, and this places the downbeat, which is
// the half no tempo control can express.
export function anchorMetronome(at) {
  if (!Number.isFinite(at)) return;
  nextAnchor = at;
  // Kept as well as consumed, so the same grid can be picked up again after a
  // stop. See anchorHeld().
  anchorAt = at;
  anchorPer = beatSeconds();
  if (!state.metroOn) {
    // The pump anchors itself on its first call and will read nextAnchor
    // there, so there is nothing to set here — setting `when` before the loop
    // exists would only be overwritten.
    startMetronome();
    return;
  }
  when = at;
  beat = 0;
  nextAnchor = null;
  stopDriving();       // a new origin is a new Start, not a continuation
}

export function stopMetronome() {
  state.metroOn = false;
  document.removeEventListener('tala:changed', onTalaChanged);
  clearInterval(timer);
  timer = null;
  stopScheduledClicks();
  // The instrument is counting off pulses queued on ITS clock, so clearing our
  // scheduler cannot recall them — same reason stopPlay() must send its own
  // note-offs. Not called while the transport is running: playback owns the
  // train then, and stopping it here would leave the keyboard's metronome dark
  // under a score that is still playing.
  if (!state.playing) stopDriving();
  stopMetronomeEntry();
  setBtnState(false);
}

export function toggleMetronome() {
  if (state.metroOn) stopMetronome(); else startMetronome();
}
