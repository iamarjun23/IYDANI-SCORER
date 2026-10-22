// Live MIDI keyboard input.
//
// A physical piano gives note-on / note-off, which is exactly what the
// on-screen piano's pointer path already consumes, so this module does not
// invent a second way into the score: a key going down calls addNote() and
// arms startHoldPromotion(), a key coming up releases it. That means how long
// a key is HELD picks the glyph — bindu -> bindu. -> guru -> guru. -> Maguru —
// the same as holding an on-screen key, so playing in time writes the right
// weights without anyone choosing a symbol first.
//
// PITCH goes through SEMI_TO_WRITTEN (midi-import.js), not through the piano's
// nearest-scale snap: the twelve semitone classes map exactly onto 7 naturals
// with a hollow goli plus 5 variants with a filled one, so a C major scale
// played on the device is written as a C major scale rather than snapped to
// Mayamalavagowla.
//
// PLACEMENT is writtenFor() in piano.js and nowhere else. A digital piano
// spans seven octaves against the staff's three, so the writable window is
// auto-centred over the device by whole octaves and the keys that still fall
// outside it are HEARD BUT NOT WRITTEN — they are drawn on the dock's keyboard
// with no svara on them, and a key whose label promises it writes nothing must
// not quietly write something. Folding them in was tried and is not what
// ships: an octave-displaced note reads as a wrong note, and the player can
// see on the dock exactly which keys are live.
//
// This module deliberately holds no second copy of that mapping. It used to —
// a pure midiToWritten() that folded, tested in isolation while the live path
// called writtenFor() — and the two had drifted into opposite behaviours with
// the tests passing throughout. tests/midi-input.test.mjs now drives
// writtenFor() itself.

import { state } from './state.js';
import { TONE_LETTER, MIN_BPM, MAX_BPM, beatSeconds } from './config.js';
import { midiOutputs, allNotesOff, deviceSink } from './midi-out.js';
import { setSetting } from './settings.js';
import { SEMI_TO_WRITTEN } from './midi-import.js';
import {
  addNote, beginMetronomeEntry, closeMetronomeSilence, endMetronomeEntry, startHoldPromotion,
} from './score.js';
import {
  freqOf, startSustain, stopSustain, audioNow, audioTimeForPerf, outputLatency,
} from './audio.js';
import {
  emitBeat, startMetronome, stopMetronome, stopDriving, anchorMetronome,
  anchorHeld, clearMetronomeAnchor,
} from './metronome.js';
import { stopPlay } from './playback.js';
import { audioClickState, audioClickSupported, startAudioClickSync, stopAudioClickSync } from './audio-click-sync.js';
import {
  PPQ, newClockFollower, clockPulse, clockStart, clockContinue, clockStop,
  clockSongPosition, clockIdle, bpmFromPeriod, setClockLead, clockAlign,
  newTapTempo, tapTempo, tapStale, TAP_TIMEOUT_MS,
} from './midi-clock.js';
import {
  highlightSemi, highlightDeviceKey, buildPiano, writtenFor, deviceFreq, deviceRange, setOct,
} from './piano.js';
import {
  newRangeTracker, resetRangeTracker, noteSeen, noteName, newVelocityProbe,
  velocityToRecord,
} from './midi-device.js';
import { deviceMemory, rememberDevice, forgetDeviceRange } from './settings.js';
import {
  newMonitor, monitorRecord, monitorClear, setMonitorSource,
} from './midi-monitor.js';

// What a placed key's notehead is. writtenFor() answers WHERE the key sits;
// this answers what is drawn there, and the two are looked up in one place so
// they cannot disagree.
export function writtenNoteFor(midi) {
  const placed = writtenFor(midi);
  if (!placed) return null;
  return { ...SEMI_TO_WRITTEN[placed.semi], semi: placed.semi, oct: placed.oct };
}

// ---------- live device ----------
//
// The transport is WEBMIDI.js (src/renderer/vendor/webmidi.iife.min.js), not
// raw navigator.requestMIDIAccess. What that buys is the message layer this
// module used to hand-roll: a 0x90 with velocity 0 is delivered as a real
// 'noteoff', channel-mode 'allnotesoff'/'allsoundoff' arrive by name, and
// 'portschanged' covers the hot-plug cases one statechange handler missed.
// Everything from noteOn()/noteOff() upward is unchanged, so the scoring path
// and its tests are untouched.
//
// The library is reached through globalThis and only inside functions, never
// imported: tests/midi-input.test.mjs loads this module under plain Node,
// where there is no window and no vendor bundle, and a top-level import of a
// browser IIFE would break that.

// WebMidi is a singleton, so "enabled" is its own flag rather than a handle.
let enabled = false;
let listening = false;
// The listeners this module attached, so rebinding removes exactly its own
// and cannot strip a listener some other part of the app added.
const boundInputs = new Set();
// Ports the CLOCK is listened for on. A superset of boundInputs, and
// deliberately so — see bindInputs().
const clockInputs = new Set();
// midi note number -> what to undo when the key comes up. Keyed by note so a
// chord, or the same note retriggered by a sustain-pedal roll, cannot leave a
// voice ringing.
const held = new Map();
const statusListeners = new Set();
let audioAutoStarting = false;
let audioLastBeat = null;

// Which device to listen to. null = every input, which is what a single
// connected piano wants and costs nothing when there are several.
let deviceId = null;

// The lowest and highest note this session has actually seen. Web MIDI does
// not report a device's range, so what has been played is the only evidence
// that cannot be wrong — see midi-device.js.
// EMPTIED when the device changes. It used to be filled for the life of the
// session, and publishDevice() then seeded it from the newly selected device's
// memory without clearing what the previous one had taught it — so two
// keyboards plugged in one after the other were drawn as the union of their
// spans, and the next note written that union into whichever name was current.
const learned = newRangeTracker();

// ---------- what this device has PROVED it can do ----------
//
// Web MIDI reports no capabilities whatsoever, so the only way to know whether
// a keyboard has a velocity sensor is to watch what it sends. A device with no
// sensor stamps one fixed value on every key — measured on a CASIO USB-MIDI:
// every note arrived at exactly 100, however hard it was struck.
//
// That matters because addNote() is deliberately careful never to invent a
// dynamic: a typed or clicked note carries no `vel`, because "writing a
// default onto it would make every score claim a dynamic it never played".
// Live MIDI was walking straight past that rule — it passed `vel` on every
// note, so a flat-velocity keyboard stamped 100 on everything and midi-file.js
// wrote that 100 into exported MIDI. The score claimed dynamics the instrument
// cannot produce.
//
// So velocity is RECORDED ONLY ONCE PROVED: two different values have to have
// arrived from this device before any of them is written down. One value seen
// many times over is proof of the opposite. The cost is that the first note or
// two on a brand-new keyboard carry no dynamic — paid once per device ever,
// since the verdict is remembered, and much cheaper than a scorefull of
// invented ones.
let velProbe = newVelocityProbe();

// Feed one arriving velocity to the probe and get back what to WRITE — the
// real value once the sensor is proved, null before that. The verdict is
// published and remembered the moment it is reached, so it is decided once per
// device ever rather than once per session.
function noteVelocity(velocity) {
  const before = velProbe.verdict;
  const record = velocityToRecord(velProbe, velocity);
  if (velProbe.verdict !== before) setVelocityVerdict(velProbe.verdict);
  return record;
}

function setVelocityVerdict(sensitive) {
  state.midiVelocity = sensitive;
  rememberDevice(state.midiDeviceName, { velocity: sensitive });
}

// What the dock's keyboard is drawn from. Published onto state rather than
// exported, so piano.js can read it without importing this module back.
let recalledFor = null;

function publishDevice() {
  const list = midiInputs();
  const dev = list.find(i => i.id === deviceId) || list[0] || null;
  state.midiDeviceName = dev ? dev.name : '';
  state.midiListening = listening;
  // A device we have met before arrives already known. Without this the range
  // was relearned from scratch every launch, so the auto-centre shift — which
  // LATCHES on the first note — was taken against a guessed 49 keys even for a
  // keyboard whose true span had been measured a dozen sessions running.
  if (dev && recalledFor !== dev.name) {
    recalledFor = dev.name;
    // A different instrument: nothing measured about the last one is evidence
    // about this one.
    resetRangeTracker(learned);
    const known = deviceMemory(dev.name);
    if (known.low != null) noteSeen(learned, known.low);
    if (known.high != null) noteSeen(learned, known.high);
    state.midiVelocity = typeof known.velocity === 'boolean' ? known.velocity : null;
    // A remembered verdict starts the probe already decided, so a keyboard we
    // have met before records dynamics correctly from its very first note.
    velProbe = newVelocityProbe(typeof known.velocity === 'boolean' ? known.velocity : null);
    // First time this keyboard has ever been seen: assume it is an instrument
    // and let it be the sound, rather than layering a sample over the note the
    // player can already hear. Done here, per DEVICE, and NOT by changing the
    // global default in settings.js — that default is 'internal' for a good
    // reason, namely that the app has to make a sound on a machine with no
    // keyboard attached at all.
    //
    // Latched by `sinkSet`, so it happens once per device ever. Without the
    // latch, plugging the same piano back in would silently overturn a player
    // who had chosen the samples on purpose.
    if (!known.sinkSet && midiOutputs().length) {
      setSetting('midiSink', 'device');
      rememberDevice(dev.name, { sinkSet: true });
    }
  }
  state.midiLearned = { low: learned.low, high: learned.high };
}

// Re-measure the drawn keyboard from scratch.
//
// The learned range is a one-way ratchet by design — a key not yet pressed
// proves nothing, so it only ever widens — and until this existed there was
// nothing on the other end of it. One note from below the instrument (a second
// port being listened to, a device left transposed, an octave button pressed
// by accident) drew keys the keyboard does not have, and they stayed: written
// through to the store as they were learned, restored at the next launch, and
// not shiftable by the dock's key-count picker either, since the learned range
// widens straight back past whatever size is chosen there.
//
// So the picker asks for this FIRST and the count is applied to a clean slate.
// Auto-detect asks for it too: "start again" is the honest meaning of picking
// Auto when the keyboard on screen is wrong.
export function forgetKeyRange() {
  resetRangeTracker(learned);
  forgetDeviceRange(state.midiDeviceName);
  state.midiLearned = { low: null, high: null };
}

// Which keys are down, for the drawn keyboard to paint. Kept beside
// publishDevice() because it is the same arrangement — this module publishes
// onto state, piano.js reads it, and neither imports the other.
function publishHeld() {
  state.midiHeld = [...held.keys()];
}

// Does a live key sound HERE, or is the instrument under the player's hand
// already making the sound?
//
// A digital piano sounds the key you press, out of its own speakers, with its
// own engine. The app was sounding its sample on top of that, so every live
// key was TWO instruments at once — different timbre, different decay, and the
// sample set pulled 5.7 cents off A=440 (SAMPLE_DETUNE_CENTS) against the
// keyboard's own tuning, so a held note beat between the two. That is the
// harshness players hear on a held key, and it is much louder than anything in
// the sample engine itself.
//
// midi-out.js has always said live keys are never echoed OUT for exactly this
// reason; nothing said the same about sounding them IN. This is that rule.
//
// It cannot be unconditional, because a controller with no engine — an M32, an
// MPK249 — makes no sound of its own and would simply go silent. Web MIDI
// reports no such capability (the whole port object is
// id/name/manufacturer/version/type/state/connection), so as with every other
// question about an instrument here, there is nothing to ask. What there IS is
// the player's own declaration, already made and already persisted: the dock's
// sink. deviceSink() is true only when they have said the keyboard is the
// sound AND a port exists to send it to.
function keySoundsHere() {
  return !deviceSink();
}

export function onMidiStatus(fn) {
  statusListeners.add(fn);
  fn(midiStatus());
  return () => statusListeners.delete(fn);
}

function emitStatus(note = null) {
  publishDevice();
  const s = midiStatus();
  if (note) s.lastNote = note;
  statusListeners.forEach(fn => fn(s));
}

// The vendored WEBMIDI.js singleton, or null when this module is running
// somewhere it was never loaded (Node, under the tests).
function wm() {
  return (typeof globalThis !== 'undefined' && globalThis.WebMidi) || null;
}

export function midiInputs() {
  const w = wm();
  if (!enabled || !w) return [];
  return w.inputs.map(i => ({
    id: i.id,
    name: i.name || 'MIDI input',
    manufacturer: i.manufacturer || '',
    state: i.state,
  }));
}

export function midiStatus() {
  const w = wm();
  return {
    // WebMidi.supported answers the same question navigator.requestMIDIAccess
    // did, and answers false as well when the bundle failed to load at all —
    // which is a build problem the status line should not hide.
    supported: !!w && !!w.supported,
    enabled,
    listening,
    deviceId,
    inputs: midiInputs(),
    lastNote: null,
  };
}

export function setMidiDevice(id) {
  deviceId = id || null;
  resetClock();
  bindInputs();
  emitStatus();
}

// Retry by hand. Access not yet granted means asking again; access already
// granted means re-reading the input list, which is what a piano plugged in
// while the app was running needs if its statechange was missed.
export async function reconnectMidi() {
  if (!enabled) return initMidiInput();
  releaseAll();
  bindInputs();
  emitStatus();
  return true;
}

// Attach to every input (or the chosen one). Re-run whenever the port list
// changes, since a piano switched on after the app started arrives that way.
//
// 'noteon'/'noteoff' are CHANNEL events: WEBMIDI.js registers them across all
// sixteen channels of the input by default, and delivers a 0x90 with velocity
// zero as a 'noteoff', which is the running-status form this used to decode by
// hand. 'allnotesoff' and 'allsoundoff' are the two panic messages a stuck key
// is actually cleared by — the raw path only listened for the first.
function bindInputs() {
  const w = wm();
  if (!enabled || !w) return;
  unbindInputs();
  w.inputs.forEach(input => {
    // The beat clock is listened for on EVERY port, including ones the device
    // picker has set aside. Two reasons, and they are both about how
    // instruments are actually wired: the clock is a System Real-Time message
    // that arrives whatever channel the notes are on, and an instrument that
    // exposes several ports commonly puts its transport on a different one
    // from its keys (a "DAW" or "MIDI 2" port beside the piano port). Picking
    // which keyboard WRITES is not a statement about which port counts the
    // bar, and binding the two together silently threw the clock away for
    // anyone who had ever touched the picker. Which port is believed is then
    // decided by what actually arrives — see clockPortOK().
    input.addListener('clock', onClockPulse);
    input.addListener('start', onClockStartMsg);
    input.addListener('continue', onClockContinueMsg);
    input.addListener('stop', onClockStopMsg);
    input.addListener('songposition', onSongPosition);
    // The RAW stream, for the monitor. On every port for the same reason, and
    // ahead of everything this module interprets: what a keyboard sends is a
    // fact, and reading the bytes is the only way to settle a question the
    // spec leaves unanswerable — see midi-monitor.js.
    input.addListener('midimessage', onRawMessage);
    clockInputs.add(input);

    if (deviceId && input.id !== deviceId) return;
    input.addListener('noteon', onWebMidiNoteOn);
    input.addListener('noteoff', onWebMidiNoteOff);
    input.addListener('allnotesoff', releaseAll);
    input.addListener('allsoundoff', releaseAll);
    input.addListener('controlchange', onControlChange);
    boundInputs.add(input);
  });
  listening = boundInputs.size > 0;
}

// Remove only what bindInputs() added. input.removeListener() with no argument
// would strip every listener on the port, including any this module did not
// put there.
function unbindInputs() {
  boundInputs.forEach(input => {
    input.removeListener('noteon', onWebMidiNoteOn);
    input.removeListener('noteoff', onWebMidiNoteOff);
    input.removeListener('allnotesoff', releaseAll);
    input.removeListener('allsoundoff', releaseAll);
    input.removeListener('controlchange', onControlChange);
  });
  clockInputs.forEach(input => {
    input.removeListener('clock', onClockPulse);
    input.removeListener('start', onClockStartMsg);
    input.removeListener('continue', onClockContinueMsg);
    input.removeListener('stop', onClockStopMsg);
    input.removeListener('songposition', onSongPosition);
    input.removeListener('midimessage', onRawMessage);
  });
  boundInputs.clear();
  clockInputs.clear();
  listening = false;
}

function onWebMidiNoteOn(e) {
  // Which channel the keyboard talks on. Reported in the dock rather than
  // acted on — every channel is listened to regardless — because "nothing is
  // being written" is sometimes a channel problem and nothing else showed it.
  const ch = e.message?.channel;
  if (ch && !state.midiChannels.includes(ch)) state.midiChannels = [...state.midiChannels, ch];
  // e.note.number is the MIDI note; rawAttack is the 0-127 velocity, which is
  // what the status line reports. WEBMIDI.js has already routed a
  // velocity-zero note-on to onWebMidiNoteOff, so there is no zero case here.
  // e.timestamp is when the message ARRIVED, on the performance.now() clock —
  // the hold is timed from it rather than from when this handler got to run.
  noteOn(e.note.number, e.note.rawAttack ?? 100, e.timestamp);
}

function onWebMidiNoteOff(e) {
  noteOff(e.note.number, e.timestamp);
}

// ---------- the raw stream ----------
//
// Everything that arrives, decoded and tallied, whether or not this module
// acts on it. It runs from the moment a port is bound rather than from the
// moment somebody opens the panel: the interesting message is nearly always
// one that has already gone past — a Start sent when the metronome was
// switched on, a controller moved once — and a monitor that only records while
// it is being watched cannot show it.
//
// Cheap by construction: a flood family (clock, active sensing, MTC) increments
// a counter and is not kept, so a device sending 24 pulses a quarter costs one
// Map write per pulse and no memory.

const monitor = newMonitor();

function onRawMessage(e) {
  const data = e?.message?.data ?? e?.data ?? e?.rawData;
  if (!data) return;
  monitorRecord(monitor, e?.port?.name ?? e?.target?.name ?? 'unnamed port',
    data, e?.timestamp ?? performance.now());
}

// What the panel reads. Handed over as a function rather than imported, so
// midi-monitor.js stays free of WebMidi and of state.
export function monitorSnapshot() {
  const w = wm();
  return {
    mon: monitor,
    meta: {
      supported: !!w && !!w.supported,
      enabled,
      // The request is `{ sysex: false }` and that option is the whole guard —
      // see the note on applyPermissions() in src/main.js. Reported rather
      // than assumed, so the panel cannot claim a protection that was lifted.
      sysex: !!w?.sysexEnabled,
      inputs: midiInputs(),
    },
  };
}

// ---------- following the keyboard's clock ----------
//
// The other end of midi-clock.js. A digital piano that is running its own
// metronome sends MIDI beat clock down the same cable it sends notes on, and
// with `state.midiSync === 'follow'` the app counts off THAT rather than off a
// grid of its own: press the metronome on the keyboard and the toolbar's
// metronome lights up, at the keyboard's tempo, on the keyboard's downbeat.
//
// The click you hear is the APP's — MIDI carries no audio, so the keyboard's
// own click cannot come down the wire. What crosses is the beat; the sound is
// ours, through emitBeat(), which is the same call metronome.js's own loop
// makes. So metro fill writes its rests under a followed beat exactly as it
// does under a counted one.
//
// Arriving clock is decoded whatever the sync setting is, because whether a
// device sends clock at all is a fact about the device and the dock reports
// it. Only the SOUNDING is gated on 'follow'.

const follower = newClockFollower();
// Did WE switch the metronome on? A master that stops must not silence a
// metronome the player started for themselves — they would be left counting
// nothing, with the button still lit.
let metroFromClock = false;
let watchdog = null;
// Which port's clock is believed. Now that every port is listened to, two of
// them could be ticking at once — a piano and an interface, or the same
// instrument's keys port and DAW port both echoing — and two masters
// interleaved into one follower is not a sync, it is noise. The first port to
// deliver a pulse counts the bar and keeps it for as long as it is running;
// only once it has stopped can another take over.
let clockPortId = null;

function clockPortOK(e) {
  const id = e?.port?.id ?? e?.target?.id ?? null;
  // No attribution to go on — believe it rather than drop the only clock in
  // the room over a missing property.
  if (id == null) return true;
  if (clockPortId === id) return true;
  if (clockPortId == null || !follower.running) {
    clockPortId = id;
    return true;
  }
  return false;
}

// performance.now() -> the AudioContext clock. The two have unrelated origins,
// so a time from one is meaningless to the other and has to be converted at
// the moment of use — the same trap perfTimeFor() in midi-out.js crosses in
// the opposite direction.
//
// audioTimeForPerf(), NOT audioNow() + delta. The difference is the whole
// reason a followed click flams against the keyboard's own: audioNow() is
// where the graph is RENDERED, which runs ahead of the speaker by the output
// latency, so converting through it schedules every click that much late. The
// app never noticed on its own, because every voice it makes is late by the
// same amount; the moment a second instrument is in the room it is audible.
// See the note over outputLatency() in audio.js.
//
// `midiSyncOffset` is the residual offset kept for MIDI-clock setups whose
// device and app audio paths are measurably different.
function audioTimeFor(ms) {
  return audioTimeForPerf(ms + (Number(state.midiSyncOffset) || 0));
}

// How much warning the follower has to give, in pulses, for a click to be
// SCHEDULED on its beat rather than started when the message arrives. Measured
// rather than fixed: device delivery latency varies by driver, and a fixed
// lead that covered the slowest path would be
// predicting a quarter of a beat ahead on the first for no reason.
//
// A quarter beat of headroom over the measured latency absorbs the delivery
// jitter of the pulse itself. setClockLead() clamps the result.
function relead() {
  if (!(follower.period > 0)) return;
  const need = outputLatency() * 1000 + follower.period * (PPQ / 4);
  setClockLead(follower, Math.ceil(need / follower.period));
}

function publishClock() {
  const bpm = bpmFromPeriod(follower.period);
  state.midiClockRunning = follower.running;
  state.midiClockBpm = bpm == null ? null : Math.round(bpm);
  // Whether this device ever says WHERE its bar starts. A keyboard that only
  // free-runs clock gives us a perfect tempo and an arbitrary downbeat, so the
  // clicks land on its beats but the ACCENT can sit anywhere in the cycle.
  // That is a real difference the player can hear and cannot otherwise
  // explain, so it is reported rather than hidden.
  state.midiClockFree = follower.pulses > 0 && !follower.sawTransport;
}

// A master that stops WITHOUT sending Stop — a cable pulled, an instrument
// switched off, a port stalled — would otherwise leave the app waiting on a
// beat that never comes, metronome lit and silent. Polled rather than timed
// off the last pulse, because there is no message to hang a timer on.
function startWatchdog() {
  if (watchdog != null || typeof setInterval !== 'function') return;
  watchdog = setInterval(() => {
    if (!clockIdle(follower, performance.now())) return;
    clockStop(follower);
    endFollowedCount();
  }, 250);
}

function stopWatchdog() {
  if (watchdog == null) return;
  clearInterval(watchdog);
  watchdog = null;
}

// The metronome goes on for the master's count and off again with it, but only
// as far as we turned it on.
function beginFollowedCount() {
  if (state.midiSync !== 'follow' || state.metroOn) return;
  metroFromClock = true;
  startMetronome();
}

function endFollowedCount() {
  publishClock();
  // The dock says whether the app is ACTUALLY following, and a master going
  // quiet is the one transition that arrives with no message behind it — the
  // watchdog notices it and nothing else would repaint the line.
  emitStatus();
  stopWatchdog();
  if (!metroFromClock) return;
  metroFromClock = false;
  stopMetronome();
}

function onClockPulse(e) {
  if (!clockPortOK(e)) return;
  const ms = e?.timestamp ?? performance.now();
  const seen = state.midiClockSeen;
  state.midiClockSeen = true;
  const wasRunning = follower.running;
  // BEFORE the pulse is counted, so this pulse is already judged against a
  // lead sized for the tempo the master is actually running at.
  relead();
  const due = clockPulse(follower, ms);
  publishClock();
  // Reported once, when the first pulse arrives: "this keyboard sends clock"
  // is exactly the kind of measured fact the dock exists to state, and without
  // it a player whose instrument sends none has nothing to look at but a
  // setting that does nothing.
  // ...and again whenever the clock starts or stops running, because that is
  // the difference between "following" and "counting on our own" and the
  // player has no other way to tell which they are hearing. Both are rare —
  // this is not per pulse.
  if (!seen || follower.running !== wasRunning) emitStatus();
  if (state.midiSync !== 'follow') return;

  startWatchdog();
  // Only where the count BEGINS — the auto-run case, for a keyboard that sends
  // clock and never announces itself. Doing it per beat instead would make the
  // toolbar button unusable: switching the click off mid-count would turn
  // itself back on a fiftieth of a second later.
  if (!wasRunning && follower.running) {
    // The wire is better evidence than an ear, so a clock that starts running
    // takes the bar back off the tap.
    stopAudioClickSync();
    dropTapSync();
    beginFollowedCount();
  }
  if (!due) return;

  // Following decides WHERE the beat is; the metronome button still decides
  // whether you hear it. Muting the click must not stop the app following, and
  // following must not take the button away.
  if (state.metroOn) {
    // Clamped to now: the downbeat straight after a Start has no pulse before
    // it to be announced from, so its time can already have passed by the time
    // the message is delivered. Late by a frame beats not sounding at all.
    emitBeat(due.beat, Math.max(audioNow(), audioTimeFor(due.atMs)));
  }
  if (due.bpm != null) setTempoFromClock(due.bpm);
}

// The device's tempo becomes the app's, so the sheet prints what is being
// played and playback runs at it. Dispatched rather than written, because
// toolbar.js owns the tempo field and already imports this module — asking it
// by event is what keeps the two from importing each other.
//
// Only on a real change: the estimate wobbles a fraction of a bpm every beat,
// and rewriting the field at every one of them would make it unreadable and
// re-print the sheet header for nothing.
let sentBpm = null;
// Wider than a rounding step on purpose. The estimate breathes a few tenths of
// a bpm every beat, and a bare round() would flip 119/120 back and forth all
// the way through a steady take — rewriting the tempo field and re-printing
// the sheet header once a beat for a tempo nobody changed. Past 0.75 bpm it is
// the player moving, not the estimate.
function setTempoFromClock(bpm) {
  if (sentBpm != null && Math.abs(bpm - sentBpm) < 0.75) return;
  const n = Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(bpm)));
  if (n === sentBpm) return;
  sentBpm = n;
  if (typeof document === 'undefined') return;
  document.dispatchEvent(new CustomEvent('tempo:external', { detail: { bpm: n } }));
  // The dock prints the clock's tempo too, and it is drawn from the status
  // event rather than polled — without this it would show whatever the tempo
  // was when the device was first noticed. Only fires on a real change, so it
  // costs nothing per beat.
  emitStatus();
}

function onClockStartMsg(e) {
  if (!clockPortOK(e)) return;
  dropTapSync();
  clockStart(follower);
  // A device that says where its bar begins has just said it, which is better
  // evidence than any tap — so the tapped phase is dropped rather than being
  // left to argue with the message that replaced it.
  state.midiClockAligned = false;
  publishClock();
  emitStatus();
  sentBpm = null;
  if (state.midiSync !== 'follow') return;
  stopAudioClickSync();
  startWatchdog();
  beginFollowedCount();
}

function onClockContinueMsg(e) {
  if (!clockPortOK(e)) return;
  clockContinue(follower);
  publishClock();
  emitStatus();
  if (state.midiSync !== 'follow') return;
  stopAudioClickSync();
  startWatchdog();
  beginFollowedCount();
}

function onClockStopMsg(e) {
  if (!clockPortOK(e)) return;
  clockStop(follower);
  endFollowedCount();
}

// A different keyboard is a different master. What was learned about the last
// one — that it sends clock, at what tempo, how far into its count it was —
// says nothing about this one, and leaving it up would have the dock reporting
// a clock from a device that is no longer plugged in.
function resetClock() {
  const fresh = newClockFollower();
  Object.assign(follower, fresh);
  sentBpm = null;
  clockPortId = null;
  state.midiClockSeen = false;
  state.midiClockAligned = false;
  state.midiTapSynced = false;
  state.midiTapCount = 0;
  clearMetronomeAnchor();
  endFollowedCount();
}

// Song Position Pointer, in sixteenths. Read off the raw bytes rather than a
// named property: it is a two-byte 14-bit value, LSB first, and decoding it
// here means the module does not depend on which of them the transport chose
// to expose.
function onSongPosition(e) {
  if (!clockPortOK(e)) return;
  const d = e?.message?.data || e?.data || [];
  clockSongPosition(follower, (d[1] || 0) | ((d[2] || 0) << 7));
}

// ---------- legacy phase-alignment helpers ----------
//
// Some callers and saved sessions still use these pure timing helpers. They
// are intentionally not exposed in the MIDI dock: keyboard synchronisation is
// now transport-only and does not listen to audio or ask for manual taps.

const tapper = newTapTempo();

// A run of taps ends by going quiet, and nothing arrives to mark that. Without
// a nudge the dock would sit on "tap 4 · 119 bpm — keep tapping" for the rest
// of the session, when what it should say is that the run has settled on a
// number the player can now check against the instrument's own display.
let tapSettle = null;

function scheduleTapSettle() {
  if (typeof setTimeout !== 'function') return;
  if (tapSettle != null) clearTimeout(tapSettle);
  tapSettle = setTimeout(() => { tapSettle = null; emitStatus(); }, TAP_TIMEOUT_MS + 50);
}

// The audio time to place the next beat at. Pushed forward by whole beats if
// the conversion lands in the past.
function tapAnchor(nextMs, periodMs) {
  const per = periodMs / 1000;
  let at = audioTimeFor(nextMs);
  const floor = audioNow();
  while (at < floor && per > 0) at += per;
  return at;
}

// One tap, taken at the moment the button was pressed. Returns what is known
// so far so the dock can count the player in.
export function tapSyncBeat(ms = performance.now()) {
  const t = tapTempo(tapper, ms);
  state.midiTapCount = t.count;

  // ONE tap is a downbeat with no tempo behind it — and that is very often the
  // whole of what is missing. A keyboard's metronome displays its bpm; typing
  // that number into the tempo field matches the two tempi EXACTLY, better
  // than any four taps can estimate, and leaves only the question of where the
  // bar begins. So a first tap moves the count onto it at the tempo already
  // set, and the dock says that tapping on will take the tempo too.
  if (t.bpm == null) {
    const per = beatSeconds(state.bpm) * 1000;
    anchorMetronome(tapAnchor(t.atMs + per, per));
    state.midiTapSynced = true;
    scheduleTapSettle();
    emitStatus();
    return { count: t.count, bpm: null };
  }

  const bpm = Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(t.bpm)));
  // The tempo field owns state.bpm — see setTempoFromClock() for why this is
  // an event and not a write.
  if (typeof document !== 'undefined') {
    document.dispatchEvent(new CustomEvent('tempo:external', { detail: { bpm } }));
  }
  anchorMetronome(tapAnchor(t.nextMs, t.period));
  state.midiTapSynced = true;
  scheduleTapSettle();
  emitStatus();
  return { count: t.count, bpm };
}

// A real clock arriving supersedes anything tapped, the same way a Start
// message supersedes a tapped downbeat: measured beats beat estimated ones.
function dropTapSync() {
  clearMetronomeAnchor();
  if (!state.midiTapSynced) return;
  state.midiTapSynced = false;
  state.midiTapCount = 0;
}

// Is tapping the thing to offer? Only when following was ASKED for and there
// is no clock to follow — with a clock running, the wire is better than any
// ear and the tap would only fight it.
export function canTapSync() {
  return state.midiSync === 'follow' && !state.midiClockRunning;
}

// The player saying where the keyboard's bar begins.
//
// Only free-running devices need this and only they offer the button: a
// keyboard that sends Start has already told us, and clockAlign() is a phase
// correction on top of a tempo that is already locked, so ONE tap holds for as
// long as the device keeps counting. It is not tap-tempo and does not have to
// be repeated.
//
// Stamped at the moment of the click rather than at the moment the beat is
// heard, because what the player is matching is the keyboard's click in the
// room — the residual between the two speakers is what the ±ms field is for.
export function alignClockDownbeat() {
  const at = clockAlign(follower, performance.now());
  if (!at) return false;
  state.midiClockAligned = true;
  publishClock();
  emitStatus();
  return true;
}

// Whether the beat is ACTUALLY shared, in a phrase and a colour. The sync
// picker says what was ASKED for; this says what is happening, and the gap
// between the two is the whole of "why is only the app's metronome playing".
// Each branch is a different fix in a different place:
//
//   no clock at all   the instrument is not transmitting it. That is a switch
//                     on the device (MIDI Clock / Sync / Transmit Clock) and
//                     nothing sent down the cable can throw it for you, so the
//                     line has to SAY so rather than leave the picker looking
//                     like it was ignored.
//   free-run          the tempo is exact and the bar position is not on the
//                     wire at all. One tap fixes it — see alignClockDownbeat().
//   stopped           the device sends clock and is not running it now.
//
// 'live' is counting together, 'want' is "this needs you", and no class is a
// plain statement of fact.
export function syncStateFor(s) {
  if (!s.listening || state.midiSync === 'off') return { text: '', cls: '' };
  if (state.midiSync === 'drive') {
    return midiOutputs().length
      ? { text: 'driving the keyboard’s beat', cls: 'live' }
      : { text: 'no MIDI output — nothing to drive', cls: 'want' };
  }
  const audio = audioClickState();
  if (audio.listening && !state.midiClockRunning) {
    return { text: audio.seen ? 'tracking keyboard audio beat' : 'listening for keyboard audio beat', cls: audio.seen ? 'live' : 'want' };
  }
  // Legacy tap alignment, retained for API/session compatibility but not
  // surfaced by the MIDI dock.
  // A tapped grid is an origin AND a spacing, so it stands only while the
  // tempo it was measured at does. anchorHeld() is asked rather than assumed:
  // typing a new tempo, or changing the metre, ends the alignment, and a dock
  // that went on claiming "matched by ear" through either would be stating
  // something the metronome had already stopped doing.
  if (state.midiTapSynced && anchorHeld()) {
    // One tap placed the BAR at the tempo already set; two or more also took
    // the tempo. Saying which is what tells a player whether the number in the
    // tempo field is still theirs.
    if (state.midiTapCount < 2) {
      return { text: `bar lined up at ${state.bpm} bpm — keep tapping for the tempo`, cls: 'live' };
    }
    // The estimate, LIVE, while the run is still going. A tap tempo settles as
    // 1/(n-1): four taps at 120 are good to about a bpm and a half, eight to
    // under one. Showing the running number and the count is what lets a
    // player see it converge and stop when it agrees with the number printed
    // on the instrument — and correct it by typing when it does not, which is
    // the only way to be exactly right.
    if (!tapStale(tapper, performance.now())) {
      return {
        text: `tap ${state.midiTapCount} · ${state.bpm} bpm — keep tapping to settle it`,
        cls: 'live',
      };
    }
    // Settled. The number is stated rather than left in the toolbar, because
    // the question being answered is "does this match the piano's display".
    return { text: `matched by ear · ${state.bpm} bpm`, cls: 'live' };
  }
  if (!state.midiClockSeen) {
    if (audio.error) return { text: audio.error, cls: 'want' };
    return { text: 'no beat clock from this keyboard', cls: 'want' };
  }
  if (!state.midiClockRunning) return { text: 'keyboard clock stopped', cls: '' };
  if (!state.midiClockFree || state.midiClockAligned) {
    return { text: 'following the keyboard’s beat', cls: 'live' };
  }
  return { text: 'following tempo — tap the downbeat to lock the bar', cls: 'want' };
}

// Is the tap-align button worth offering? Only while a free-running master is
// actually counting: with nothing running there is no phase to move, and with
// a Start-sending device there is nothing to guess.
export function canAlignDownbeat() {
  return state.midiSync === 'follow' && state.midiClockRunning && state.midiClockFree;
}

// Sync is a preference, not score data — see settings.js. Switching it off
// mid-count has to put back whatever it took over: the metronome we started,
// and (in 'drive') the pulse train metronome.js/playback.js are sending.
export function setMidiSync(mode) {
  setSetting('midiSync', mode);
  if (state.midiSync !== 'follow') endFollowedCount();
  if (state.midiSync !== 'follow') stopAudioClickSync();
  else ensureAudioClickSync();
  if (state.midiSync !== 'drive') stopDriving();
  emitStatus();
}

async function ensureAudioClickSync() {
  if (audioAutoStarting || state.midiSync !== 'follow' || !listening || !audioClickSupported()) return;
  if (audioClickState().listening) return;
  audioAutoStarting = true;
  audioLastBeat = null;
  const audioBeat = ms => {
    if (audioLastBeat == null) { audioLastBeat = ms; return; }
    const dt = ms - audioLastBeat;
    audioLastBeat = ms;
    // Reject obvious room-noise/false-trigger intervals. The CTK's normal
    // metronome range around performance tempos is 90–180 BPM (333–667 ms).
    if (dt < 333 || dt > 667) return;
    tapSyncBeat(ms);
  };
  try { await startAudioClickSync(audioBeat); }
  finally { audioAutoStarting = false; emitStatus(); }
}

// Turn WEBMIDI.js on. Rejects when the user or the OS refuses, which must not
// be fatal — the on-screen piano and the letter keys keep working.
export async function initMidiInput() {
  if (enabled) return true;
  const w = wm();
  if (!w || !w.supported) {
    emitStatus();
    return false;
  }
  try {
    await w.enable({ sysex: false });
  } catch {
    enabled = false;
    emitStatus();
    return false;
  }
  enabled = true;

  // 'portschanged' covers both directions and fires after WEBMIDI.js has
  // rebuilt its own port list, so w.inputs is already correct when we rebind.
  w.addListener('portschanged', onPortsChanged);
  bindInputs();
  emitStatus();
  ensureAudioClickSync();
  return true;
}

function onPortsChanged() {
  const w = wm();
  // A device pulled mid-note leaves its key stuck down otherwise.
  if (deviceId && w && !w.inputs.some(i => i.id === deviceId)) deviceId = null;
  releaseAll();
  resetClock();
  bindInputs();
  emitStatus();
}

// How hard the key was struck, as a gain multiplier. A MIDI velocity of 0
// never reaches here (that is a note-off), and a controller with no velocity
// sensor sends a flat 64 — which lands on 1.0, the level every note played at
// before velocity was read at all, so a non-velocity keyboard sounds exactly
// as it did. The floor keeps the softest key audible rather than silent.
const GAIN_FLOOR = 0.15;
export function gainForVelocity(velocity) {
  const v = Math.max(1, Math.min(127, Number(velocity) || 64));
  return Math.min(1, GAIN_FLOOR + (1 - GAIN_FLOOR) * Math.pow(v / 64, 1.4));
}

export function noteOn(midi, velocity = 64, at) {
  // A physical key press takes control away from score playback. This keeps
  // the app from continuing to play underneath the musician's live MIDI
  // performance; MIDI transport messages still control the metronome itself.
  if (state.playing) {
    // Browser playback owns the transport cleanup; the guard keeps the pure
    // MIDI module usable in its Node test environment as well.
    if (typeof document === 'undefined') state.playing = false;
    else stopPlay();
  }
  if (held.has(midi)) noteOff(midi, at);
  const sym = state.sym;
  const gain = gainForVelocity(velocity);

  // A key outside the drawn keyboard proves the drawn keyboard is too small.
  // The tracker is published to state BEFORE anything reads it back: the drawn
  // keyboard is rebuilt from state.midiLearned further down, and publishing at
  // the end of the call left it a note behind, so the key that widened the
  // range was not drawn until the next note arrived.
  const grew = learned.low == null || midi < learned.low || midi > learned.high;
  noteSeen(learned, midi);
  if (grew) {
    publishDevice();
    // Written through as it widens, not at shutdown: there is no reliable
    // moment to save at — the window can be closed, the device unplugged, or
    // the app killed — and a range learned across a whole session and then
    // lost is exactly the bug this fixes.
    rememberDevice(state.midiDeviceName, { low: learned.low, high: learned.high });
  }

  // Where this key sits on the staff — or null, when the device reaches past
  // the three sthayis the staff can write. Such a key is HEARD but not
  // written: the dock draws it with no svara on it, and a key that says it
  // writes nothing must not quietly write something.
  const placed = writtenFor(midi);
  if (!placed) {
    // deviceFreq(), not freqOfMidi(): an unwritable key is transposed by the
    // same auto-centre shift as a writable one, so the keyboard does not jump
    // pitch at the edge of the window.
    // Counted for the velocity verdict even though nothing is written: the key
    // proves just as much about the sensor as a writable one does.
    noteVelocity(velocity);
    // Silent when the keyboard is the instrument — see keySoundsHere(). The
    // whole deviceFreq() transposition exists to line the samples up with the
    // writable window, and none of it applies to a piano sounding its own key
    // at its own pitch.
    const voice = keySoundsHere() ? startSustain(deviceFreq(midi), gain) : null;
    held.set(midi, { voice, stopPromotion: () => {}, semi: null, oct: null, written: false });
    // Published BEFORE the rebuild below, which paints the held keys from it.
    publishHeld();
    if (grew && state.mode === 'midi') buildPiano();
    // An unwritable key lights like any other: it is a real key on the drawn
    // device and it is sounding, so leaving it dark would read as a dead key.
    highlightDeviceKey(midi, true);
    emitStatus({ midi, velocity, semi: null, oct: null, unwritable: true });
    return;
  }

  const w = { ...SEMI_TO_WRITTEN[placed.semi], semi: placed.semi, oct: placed.oct };
  // playSound:false — the sustained voice below is the sound. Letting addNote
  // pluck as well double-strikes every note.
  // Sound FIRST, before any score work, so the key is heard the instant it lands.
  const voice = keySoundsHere() ? startSustain(freqOf(w.semi, w.oct), gain) : null;
  closeMetronomeSilence();
  // null until this device has proved it has a velocity sensor — addNote()
  // writes no `vel` at all for null, which is what a note with no dynamic to
  // record is supposed to look like.
  const index = addNote(w.svaraIndex, {
    playSound: false, sym, head: w.head, oct: w.oct, vel: noteVelocity(velocity),
  });
  // null: the tone is switched off in the sheet's legend. The key still sounds
  // and lights; there is just no note to grow and no entry to count as held.
  const on = index != null;
  if (on) beginMetronomeEntry();
  const stopPromotion = on ? startHoldPromotion(index, sym, at) : () => {};
  held.set(midi, { voice, stopPromotion, semi: w.semi, oct: w.oct, written: on });
  publishHeld();

  // Two keyboards can be on screen, so both are told. highlightSemi() lights
  // the app's own piano (addressed by semitone and sthayi) when that is what
  // the dock is showing; highlightDeviceKey() lights the drawn DEVICE key
  // (addressed by midi number) in MIDI mode. Each matches nothing in the other
  // mode, so calling both is how one physical press lights whichever keyboard
  // the player is actually looking at.
  // The sthayi selector and the sheet's tone legend follow the hand, as they
  // follow the letter rows in keyboard.js — a switched-off tone included, so
  // the legend on screen is the row that refused it. Before the highlight:
  // setOct() rebuilds the piano.
  if (state.oct !== w.oct) setOct(w.oct);
  if (on) { highlightSemi(w.semi, true, w.oct); scrollToLatest(); }
  if (grew && state.mode === 'midi') buildPiano();
  highlightDeviceKey(midi, true);
  emitStatus({ midi, velocity, ...w, toneOff: !on });
}

// ---------- the damper pedal ----------
//
// CC 64 sustains the SOUND and nothing else. The written note stops growing at
// key release, because a pedal is not a longer note — a pianist playing
// quavers with the pedal down means quavers, and letting the pedal drive
// startHoldPromotion() would write a whole pedalled phrase as one Maguru.
//
// So a key released under the pedal finishes on the staff exactly as it would
// have unpedalled, and only its voice is handed here to keep ringing.
let pedalDown = false;
const pedalVoices = new Set();

export function setPedal(down) {
  const was = pedalDown;
  pedalDown = !!down;
  if (was && !pedalDown) {
    pedalVoices.forEach(stopSustain);
    pedalVoices.clear();
  }
}

// CC 64, where 64 and above is down — the MIDI convention for a switch
// controller, and what a half-pedalling piano sends on its way past the
// detent.
function onControlChange(e) {
  if (e?.controller?.number === 64) setPedal((e.rawValue ?? 0) >= 64);
}

export function noteOff(midi, at) {
  const h = held.get(midi);
  if (!h) return;
  held.delete(midi);
  publishHeld();
  // Unlit on the key coming UP, never on the pedal: CC 64 holds the SOUND on,
  // but the finger has left the key and the picture is of the keyboard.
  highlightDeviceKey(midi, false);
  h.stopPromotion(at);
  if (h.written) endMetronomeEntry();
  // Under the pedal the voice outlives the key; every other part of the
  // release still happens on time.
  if (pedalDown) pedalVoices.add(h.voice);
  else stopSustain(h.voice);
  if (!h.written) return;
  // Only unlight if no other held key sounds the same pitch class.
  if (![...held.values()].some(o => o.semi === h.semi && o.oct === h.oct))
    highlightSemi(h.semi, false, h.oct);
}

// Everything off, pedal included. This is what a panic message, a device
// leaving and the window losing focus all need — a voice parked on the pedal
// is exactly the kind that would otherwise ring forever.
export function releaseAll() {
  // Wrapped: forEach would hand noteOff() the array index as a timestamp.
  [...held.keys()].forEach(m => noteOff(m));
  pedalDown = false;
  pedalVoices.forEach(stopSustain);
  pedalVoices.clear();
}

// Keep the newest note on screen. Playing a long line otherwise writes rows
// below the fold and the player watches a staff that stopped moving.
//
// The element that scrolls is `.stage`, NOT `#sheetwrap`. This read the wrap
// for a long time and therefore did nothing at all: `.sheetwrap` carries the
// zoom transform and has no overflow, so its scrollTop is pinned at 0 and
// assigning to it neither moves anything nor throws. See follow.js, which
// holds the sounding row centred during playback and states the same rule.
function scrollToLatest() {
  if (typeof document === 'undefined') return;
  requestAnimationFrame(() => {
    const stage = document.querySelector('.stage');
    const rows = document.querySelectorAll('#score .srow');
    const last = rows[rows.length - 1];
    if (!stage || !last) return;
    const stageBox = stage.getBoundingClientRect();
    const rowBox = last.getBoundingClientRect();
    // Entry nudges only when the row has left the view — unlike playback, which
    // holds its row centred. Writing notes should leave the page still.
    if (rowBox.bottom > stageBox.bottom || rowBox.top < stageBox.top) {
      stage.scrollTop += rowBox.bottom - stageBox.bottom + 24;
    }
  });
}

// ---------- dock UI ----------
//
// The dock's status line and device picker. It reports three separable things
// — whether MIDI is available at all, whether a device is bound, and what was
// just played — because "nothing appears on the staff" has three different
// causes and the player needs to know which one they have.

const SECTION = { '-1': 'mandra', '0': 'madhya', '1': 'taara' };

// The button says the state in a word. Three cases, not two: "no device" and
// "no permission" both mean nothing is being written, and they are fixed in
// completely different places.
function buttonFor(s) {
  if (!s.supported) return { text: 'MIDI unavailable', cls: 'idle', hint: 'This build has no Web MIDI support' };
  if (!s.enabled)   return { text: 'MIDI blocked', cls: 'idle', hint: 'MIDI access was refused — click to ask again' };
  if (!s.listening) return { text: 'No MIDI device', cls: '', hint: 'Connect a keyboard by USB, then click to rescan' };
  const dev = s.inputs.find(i => i.id === s.deviceId) || s.inputs[0];
  const name = s.inputs.length > 1 && !s.deviceId ? `${s.inputs.length} devices` : dev.name;
  return { text: 'MIDI connected', cls: 'live', hint: `${name} — click to rescan` };
}

// What the device has been observed to be, in a phrase. This is the only place
// the player is ever told what their keyboard can do, because Web MIDI tells
// them nothing: the port carries a name and no capabilities at all. Each part
// appears only once it is KNOWN — an unproven velocity sensor says nothing
// rather than guessing, since the whole point is not to claim what has not
// been seen.
export function capabilityTextFor(s) {
  if (!s.listening) return '';
  const bits = [];
  // The keyboard AS DRAWN, and where that size came from. `source` was worked
  // out by resolveDeviceRange() from the beginning and shown nowhere, so a
  // dock drawing two keys the instrument does not have said nothing about why
  // — and the three causes (a name parsed wrong, a plain default, a note
  // learned from somewhere it should not have been) are fixed three different
  // ways. It is the drawn range and not the played one because the drawn range
  // is what is on screen to be disagreed with.
  const drawn = deviceRange();
  const SOURCE = {
    picked: 'size picked', name: 'from its name', default: 'assumed',
    'picked+played': 'size picked, widened by a key played',
    'name+played': 'from its name, widened by a key played',
    'default+played': 'assumed, widened by a key played',
  };
  bits.push(`${noteName(drawn.low)}–${noteName(drawn.high)}`
    + ` (${drawn.keys} keys, ${SOURCE[drawn.source] || drawn.source})`);
  if (state.midiVelocity === true) bits.push('velocity');
  else if (state.midiVelocity === false) bits.push('no velocity');
  if (state.midiChannels.length) bits.push(`ch ${state.midiChannels.join('/')}`);
  // Which instrument is making the sound. Stated because the failure mode is
  // SILENCE and silence names no cause: a controller with no engine of its own
  // set to sound on itself plays nothing at all, and nothing else on screen
  // would say why. Same reasoning as syncStateFor() — a setting the player
  // cannot see the effect of is indistinguishable from one being ignored.
  bits.push(deviceSink() ? 'sounding on the keyboard' : 'sounding in the app');
  // Whether this keyboard sends beat clock at all, measured the same way as
  // everything else here: by watching for it. A device that sends none cannot
  // be followed, and saying so is the difference between a setting that does
  // nothing and a setting the player can see is not being fed.
  if (state.midiClockSeen) {
    const bpm = state.midiClockBpm ? `clock ${state.midiClockBpm} bpm` : 'clock';
    // "free-run" is not a fault, it is a fact about the device: the tempo is
    // exact, the downbeat is a guess, and only the accent depends on the
    // second one.
    bits.push(state.midiClockFree ? `${bpm} (free-run)` : bpm);
  }
  return bits.join(' · ');
}

function statusTextFor(s) {
  if (!s.supported) return 'MIDI is not available in this build';
  // Refused access, NOT an absent device. These read the same to the player —
  // nothing is being written — but they are fixed in completely different
  // places, and the line used to blame the cable while the button beside it
  // correctly said "MIDI blocked".
  if (!s.enabled) return 'MIDI access was refused — click MIDI to ask again';
  if (!s.inputs.length) return 'No MIDI device found — connect one by USB';
  if (!s.listening) return 'MIDI device found but not listening';
  const dev = s.inputs.find(i => i.id === s.deviceId) || s.inputs[0];
  const name = s.inputs.length > 1 && !s.deviceId ? `${s.inputs.length} MIDI devices` : dev.name;
  if (!s.lastNote) return `${name} — play to write`;
  const n = s.lastNote;
  if (n.unwritable) return `${name} — key outside the staff's range: heard, not written`;
  const letter = TONE_LETTER[n.semi];
  if (n.toneOff) return `${name} — ${letter} is switched off in the tone legend: heard, not written`;
  return `${name} — ${letter} ${SECTION[n.oct]}`;
}

export function installMidiUI() {
  const sel = document.getElementById('midiDevice');
  const box = document.getElementById('inputStatus');
  const txt = document.getElementById('statusText');
  const btn = document.getElementById('midiBtn');
  const btnTxt = document.getElementById('midiBtnText');

  const cap = document.getElementById('midiCaps');
  const sink = document.getElementById('midiSink');
  const sync = document.getElementById('midiSync');
  const syncState = document.getElementById('midiSyncState');

  sel?.addEventListener('change', () => setMidiDevice(sel.value || null));

  if (sink) {
    sink.value = state.midiSink;
    sink.addEventListener('change', () => {
      // Anything already queued on the instrument's clock has to be recalled,
      // or switching to the app's sound mid-score leaves the keyboard playing
      // the rest of the line underneath it.
      allNotesOff();
      setSetting('midiSink', sink.value);
    });
  }

  if (sync) {
    sync.value = state.midiSync;
    sync.addEventListener('change', () => {
      setMidiSync(sync.value);
    });
  }

  // Tapped on the keyboard's own click, so the moment of the PRESS is what is
  // handed on. Which of the two jobs it does is decided here rather than by
  // two buttons, because from the player's side it is one gesture and the only
  // difference is how much of it the cable already supplied.
  btn?.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btnTxt.textContent = 'Searching…';
    try { await reconnectMidi(); } finally { btn.disabled = false; emitStatus(); }
  });

  // A device arriving or leaving changes the whole picture — the drawn key
  // count comes from its name — so the keyboard is rebuilt with the status.
  let lastShape = '';
  onMidiStatus(s => {
    if (txt && state.mode !== 'keyboard') txt.textContent = statusTextFor(s);
    if (cap) {
      const line = capabilityTextFor(s);
      cap.textContent = line;
      cap.hidden = !line;
    }
    if (sink) {
      // Only offered when there is somewhere else to send it.
      sink.hidden = !midiOutputs().length;
      sink.value = state.midiSink;
    }
    if (sync) {
      // Following needs only an INPUT — a keyboard that sends clock and takes
      // nothing back is a perfectly good master — so this is offered as soon
      // as one is bound, not gated on an output port the way the sink is.
      sync.hidden = !s.listening;
      sync.value = state.midiSync;
    }
    if (syncState) {
      const st = syncStateFor(s);
      syncState.textContent = st.text;
      syncState.hidden = !st.text;
      // The colour is the part a player reads without reading — green is
      // counting together, amber is "this one needs you".
      syncState.classList.toggle('live', st.cls === 'live');
      syncState.classList.toggle('want', st.cls === 'want');
    }
    if (s.listening && state.midiSync === 'follow') ensureAudioClickSync();
    box?.classList.toggle('live', s.listening);
    const shape = `${s.listening}|${state.midiDeviceName}`;
    if (shape !== lastShape) {
      lastShape = shape;
      if (state.mode === 'midi') buildPiano();
    }
    if (btn && btnTxt && !btn.disabled) {
      const b = buttonFor(s);
      btnTxt.textContent = b.text;
      btn.title = b.hint;
      btn.classList.toggle('live', b.cls === 'live');
      btn.classList.toggle('idle', b.cls === 'idle');
      // Nothing to retry when the build has no Web MIDI at all.
      btn.disabled = !s.supported;
    }
    if (!sel) return;
    // Only worth showing once there is a choice to make.
    sel.hidden = s.inputs.length < 2;
    const want = s.inputs.map(i => i.id).join('|');
    if (sel.dataset.devices !== want) {
      sel.dataset.devices = want;
      // Built as ELEMENTS, never as an interpolated string. A device's id and
      // name come out of its USB descriptor — they are the device's text, not
      // ours — and a name carrying a quote or an angle bracket used to break
      // out of the option and inject markup into the dock. The CSP stops that
      // markup from running a script, but it still mangles the picker and
      // makes the device unselectable, and relying on the CSP for the rest is
      // not a defence worth keeping.
      sel.replaceChildren(new Option('All devices', ''));
      s.inputs.forEach(i => sel.add(new Option(i.name, i.id)));
    }
    sel.value = s.deviceId || '';
  });

  // The monitor panel reads through this rather than importing anything from
  // here, which is what keeps it a pure decoder with a panel bolted on.
  setMonitorSource(monitorSnapshot);
  document.addEventListener('midi:monitor-clear', () => monitorClear(monitor));

  // Ask on load rather than behind a button: the client's setup is a piano
  // that is already plugged in, and a prompt they never see is a feature that
  // never works. A refusal is not fatal — everything else keeps working.
  initMidiInput();

  // The empty-state panel's button lives in piano.js, which this module
  // imports — so it asks by event rather than making the two circular.
  document.addEventListener('midi:reconnect', async () => {
    await reconnectMidi();
    emitStatus();
  });

  // The dock's key-count picker, same arrangement: it lives in piano.js, which
  // this module imports, so it asks by event rather than making the two
  // circular.
  document.addEventListener('midi:forget-range', () => {
    forgetKeyRange();
    buildPiano();
    emitStatus();
  });

  // A key still down when the window goes away would otherwise ring forever.
  window.addEventListener('blur', releaseAll);
  window.addEventListener('beforeunload', releaseAll);
}

// The mode pills rewrite the status line; this puts the live MIDI text back.
export function refreshMidiStatus() {
  emitStatus();
}
