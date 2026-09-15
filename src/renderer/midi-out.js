// Sounding the score ON THE CONNECTED KEYBOARD.
//
// A MIDIInput is only half of what a plugged-in piano offers. The same device
// exposes a MIDIOutput, and until now nothing in the app ever touched it — the
// port was enumerated and then ignored.
//
// Why it is worth using: renderer/samples/ holds 24 recorded notes covering
// C3-B3 and C5-B5. The middle octave was never recorded, so every madhya pitch
// is a neighbouring sample shifted with playbackRate. A connected instrument
// has a real engine across its whole compass with nothing shifted, so playing
// the score out to it is simply a better sound — and it costs no new
// permission, because sending notes is what the output port is for and Web
// MIDI already granted it.
//
// SCOPE: playback only. Live keys are deliberately NOT echoed back to the
// device — a digital piano already sounds its own key when you press it, so
// sending it a note-on for the key under the player's finger would double
// every note they play.
//
// The transport is the vendored WEBMIDI.js singleton, reached through
// globalThis inside functions only, exactly as midi-input.js reaches it — this
// module is imported by playback.js, which the tests load under plain Node
// where no window and no vendor bundle exist.

import { state } from './state.js';
import { perfTimeForAudio } from './audio.js';

// Channel 1, which is what the probe measured this class of device
// transmitting on and what a piano with no channel setting receives on.
const CH = 0;

function wm() {
  return (typeof globalThis !== 'undefined' && globalThis.WebMidi) || null;
}

export function midiOutputs() {
  const w = wm();
  // `outputs` guarded as well as `enabled`: the two are set at different points
  // in the library's own start-up, so a caller that runs in between — which is
  // now the case, since publishDevice() asks whether there is anywhere to send
  // the sound the moment a device is bound — sees an enabled singleton with no
  // port list yet. port() has always guarded it; this had not.
  if (!w || !w.enabled || !Array.isArray(w.outputs)) return [];
  return w.outputs.map(o => ({ id: o.id, name: o.name || 'MIDI output' }));
}

// The port to sound on: the one chosen in the dock, or the first available.
// One connected piano is the ordinary case and needs no choice made.
function port() {
  const w = wm();
  // Same guard as midiOutputs(): `enabled` and `outputs` are set at different
  // points in the library's start-up, and deviceSink() is now asked on EVERY
  // live note-on — so this runs far more often, and far earlier, than when it
  // was only reached by playback.
  if (!w || !w.enabled || !Array.isArray(w.outputs) || !w.outputs.length) return null;
  return w.outputs.find(o => o.id === state.midiOutId) || w.outputs[0] || null;
}

// Is the score going to the keyboard rather than to the samples? Both halves
// matter: the player has to have asked for it AND a port has to exist, so
// unplugging the piano falls back to the internal sound instead of going
// silent.
export function deviceSink() {
  return state.midiSink === 'device' && !!port();
}

export function setMidiOutput(id) {
  state.midiOutId = id || null;
}

// ---------- scheduling ----------
//
// playback.js schedules on the AudioContext clock; Web MIDI timestamps are in
// the performance.now() domain. The two have unrelated origins, so a time from
// one is meaningless to the other and has to be CONVERTED rather than passed
// across — this is the same trap that made a second AudioContext unable to
// place a metronome click against a note.
//
// The correlation is read per call, at the moment of use. Both clocks are read
// microseconds apart, so the conversion is exact for scheduling purposes, and
// taking it fresh each time means a drift between the two clocks over a long
// score is corrected continuously instead of accumulating from one reading
// taken at the start.
//
// It converts to the moment the sound is HEARD, not to the moment the graph
// reaches that point. Those differ by the output latency, and the difference is
// audible the instant both instruments are sounding: a message stamped from
// currentTime reaches the device with none of our latency on it, so it plays
// EARLY against anything the app sounds itself — the app's metronome under a
// score playing through the keyboard, or the keyboard's own metronome under a
// pulse train we are driving. Same latency a followed click is LATE by, in the
// opposite direction. See perfTimeForAudio() in audio.js.
const perfTimeFor = perfTimeForAudio;

// The same, plus the residual nudge in `midiSyncOffset` (ms). It moves the
// SYNCED sound later, and the sound this end places is the instrument's, so it
// is added here — the follow path adds it to our own click for the same
// reason. Only the clock goes through this: a note sent to the device is being
// sounded, not synchronised, and shifting it would put the score itself off
// the beat it was scheduled on.
function perfTimeForSynced(audioWhen) {
  return perfTimeForAudio(audioWhen) + (Number(state.midiSyncOffset) || 0);
}

// One note, note-on then note-off, both stamped ahead on the device's own
// clock. Sending stamped messages rather than calling send() at the right
// moment is the whole point: the device queues them and plays them on time
// however busy this thread is, which is the same reason the audio path
// schedules ahead instead of starting sounds from a timer.
export function sendNoteAt(midi, velocity, audioWhen, seconds) {
  const o = port();
  if (!o) return;
  const n = Math.max(0, Math.min(127, Math.round(midi)));
  const v = Math.max(1, Math.min(127, Math.round(velocity)));
  const on = perfTimeFor(audioWhen);
  // A floor on the sounded length: a zero-length note-off can land in the same
  // millisecond as its note-on and some engines then swallow the note.
  const off = on + Math.max(30, seconds * 1000);
  try {
    o.send([0x90 | CH, n, v], { time: on });
    o.send([0x80 | CH, n, 0], { time: off });
  } catch { /* port vanished mid-schedule; silence is the right failure */ }
}

// ---------- beat clock out ----------
//
// The other half of midi-clock.js: when the APP leads, these are the bytes the
// keyboard's own metronome follows. They are System Real-Time messages — one
// status byte, no data, no channel — so they reach the instrument whatever
// channel it is set to receive notes on.
//
// This is gated on `state.midiSync === 'drive'` and NOT on `midiSink`: which
// end counts the bar and where the score is sounded are separate questions,
// and a player who wants the app's samples while the keyboard's metronome
// keeps time with them is asking for something perfectly ordinary.
const CLOCK = 0xF8;
const START = 0xFA;
const CONTINUE = 0xFB;
const STOP = 0xFC;

export function clockSink() {
  return state.midiSync === 'drive' && !!port();
}

// Stamped ahead on the device's clock, exactly as sendNoteAt() stamps a note:
// a pulse train started from a timer inherits every frame this thread blocks
// for, and a clock that wobbles is worse than no clock, because the instrument
// following it turns that wobble into tempo.
export function sendClockAt(audioWhen) {
  const o = port();
  if (!o) return;
  try { o.send([CLOCK], { time: perfTimeForSynced(audioWhen) }); }
  catch { /* port vanished mid-schedule */ }
}

// Start / Continue / Stop. Sent for the moment they mean, not queued: Stop in
// particular has to overtake the pulses already sitting on the device's clock,
// which is what clear() is for — without it the instrument counts on through
// the window that was already scheduled.
export function sendClockStart(audioWhen = null) {
  const o = port();
  if (!o) return;
  try { o.send([START], audioWhen == null ? undefined : { time: perfTimeForSynced(audioWhen) }); }
  catch { /* port vanished */ }
}

export function sendClockContinue() {
  const o = port();
  if (!o) return;
  try { o.send([CONTINUE]); } catch { /* port vanished */ }
}

export function sendClockStop() {
  const o = port();
  if (!o) return;
  try {
    o.clear?.();
    o.send([STOP]);
  } catch { /* port vanished */ }
}

// Everything off, now. Needed on stop because notes are already queued on the
// DEVICE's clock — clearing our own scheduler cannot recall them, so the
// instrument would play on after the transport went dark.
export function allNotesOff() {
  const o = port();
  if (!o) return;
  try {
    // clear() drops what is still queued; the panic messages stop whatever
    // already started. Both are needed — neither alone leaves the instrument
    // quiet.
    o.clear?.();
    o.sendAllNotesOff?.();
    o.sendAllSoundOff?.();
  } catch { /* nothing to silence */ }
}
