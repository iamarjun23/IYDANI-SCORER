// The WEBMIDI.js transport layer in midi-input.js.
//
// midiToWritten() is covered by tests/midi-input.test.mjs; this one covers the
// part that swapping navigator.requestMIDIAccess for WEBMIDI.js actually
// touched — enabling, which ports get listened to, and that rebinding removes
// exactly the listeners this module added. A fake WebMidi singleton stands in
// for the vendored bundle, so no device and no browser is needed.

import assert from 'node:assert/strict';

// ---------- fake WebMidi ----------

function fakeInput(id, name) {
  return {
    id, name, manufacturer: 'Test', state: 'connected',
    listeners: new Map(),
    addListener(ev, fn) {
      if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
      this.listeners.get(ev).add(fn);
    },
    removeListener(ev, fn) {
      if (ev === undefined) return this.listeners.clear();
      this.listeners.get(ev)?.delete(fn);
    },
    events() {
      return [...this.listeners].filter(([, s]) => s.size).map(([e]) => e).sort();
    },
  };
}

const fake = {
  supported: true,
  enabled: false,
  enableCalls: [],
  inputs: [],
  _global: new Map(),
  async enable(opts) { this.enableCalls.push(opts); this.enabled = true; return this; },
  addListener(ev, fn) { this._global.set(ev, fn); },
  fire(ev) { this._global.get(ev)?.(); },
};

globalThis.WebMidi = fake;

const a = fakeInput('in-a', 'Keystation 61');
const b = fakeInput('in-b', 'KOMPLETE KONTROL M32');
fake.inputs = [a, b];

const midi = await import('../src/renderer/midi-input.js');

// ---------- before enabling, nothing is claimed ----------

let s = midi.midiStatus();
assert.equal(s.supported, true, 'the bundle is present, so MIDI is supported');
assert.equal(s.enabled, false);
assert.equal(s.listening, false);
assert.deepEqual(s.inputs, [], 'no port list before enable()');

// ---------- enable binds every input, and asks for no sysex ----------

assert.equal(await midi.initMidiInput(), true);
assert.deepEqual(fake.enableCalls, [{ sysex: false }],
  'sysex must stay off — the main process denies it and it can rewrite an instrument');

s = midi.midiStatus();
assert.equal(s.enabled, true);
assert.equal(s.listening, true);
assert.deepEqual(s.inputs.map(i => i.name), ['Keystation 61', 'KOMPLETE KONTROL M32']);

// Two sets of listeners with two different scopes.
//
// KEYS — notes, both panic messages, the damper pedal — go only on the port
// the device picker selected: that setting is a statement about which keyboard
// writes into the score.
//
// CLOCK goes on EVERY port, whatever the picker says. It is a System Real-Time
// message that arrives whatever channel the notes are on, and an instrument
// with several ports commonly puts its transport on a different one from its
// keys. Picking which keyboard writes is not a statement about which port
// counts the bar, and tying the two together silently threw the clock away for
// anyone who had ever touched the picker. It is bound regardless of
// state.midiSync too — whether a device sends clock at all is a fact about the
// device and the dock reports it either way; only the SOUNDING is gated on the
// setting. See midi-clock.js.
// 'midimessage' is the RAW stream, tapped for the monitor — see
// midi-monitor.js. It rides with the clock and for the same reason: what an
// instrument sends is a fact about the instrument, and reading the bytes is
// the only way to settle it.
const CLOCK = ['clock', 'continue', 'midimessage', 'songposition', 'start', 'stop'];
const KEYS = ['allnotesoff', 'allsoundoff', 'controlchange', 'noteoff', 'noteon'];
const WANT = [...CLOCK, ...KEYS].sort();
assert.deepEqual(a.events(), WANT, 'note, panic, pedal and clock events must all be bound');
assert.deepEqual(b.events(), WANT);

// ---------- enabling twice does not double-bind ----------

await midi.initMidiInput();
assert.equal(a.listeners.get('noteon').size, 1, 'one noteon listener, not two');

// ---------- picking a device unbinds the other ----------

midi.setMidiDevice('in-b');
assert.deepEqual(a.events(), CLOCK,
  'the unpicked port stops writing notes — but keeps its clock, which may be the only one');
assert.deepEqual(b.events(), WANT);
assert.equal(midi.midiStatus().deviceId, 'in-b');

// ...and back to all.
midi.setMidiDevice(null);
assert.deepEqual(a.events(), WANT);
assert.equal(a.listeners.get('noteon').size, 1, 'rebinding did not stack listeners');

// ---------- a listener this module did not add survives a rebind ----------
//
// input.removeListener() with no argument would strip this too.

const foreign = () => {};
a.addListener('noteon', foreign);
midi.setMidiDevice('in-b');
assert.ok(a.listeners.get('noteon').has(foreign),
  'unbinding removed a listener that belongs to someone else');
a.removeListener('noteon', foreign);
midi.setMidiDevice(null);

// ---------- unplugging the picked device falls back to all ----------

fake.inputs = [a];
fake.fire('portschanged');
assert.equal(midi.midiStatus().deviceId, null, 'a device that left cannot stay picked');
assert.deepEqual(a.events(), WANT);
assert.equal(midi.midiStatus().inputs.length, 1);

// ---------- the last device leaving stops the listening state ----------

fake.inputs = [];
fake.fire('portschanged');
s = midi.midiStatus();
assert.equal(s.listening, false, 'no ports means nothing is being listened to');
assert.equal(s.enabled, true, 'but access is still granted');
assert.deepEqual(a.events(), [], 'the departed port was released');

// ---------- a device arriving later is picked up ----------

fake.inputs = [a, b];
fake.fire('portschanged');
assert.equal(midi.midiStatus().listening, true);
assert.deepEqual(a.events(), WANT);

console.log('midi-webmidi: ok');

// ---------- velocity ----------
//
// A controller with no velocity sensor sends a flat 64, which must sound
// exactly as every note did before velocity was read at all — otherwise
// adding the feature quietly turns such a keyboard down.

const { gainForVelocity } = midi;
assert.equal(gainForVelocity(64), 1, 'a flat-64 controller must be unchanged');
assert.equal(gainForVelocity(127), 1, 'the hardest strike is full, not louder than full');
assert.ok(gainForVelocity(20) < gainForVelocity(64), 'a soft key must sound softer');
assert.ok(gainForVelocity(1) > 0, 'the softest key must still be audible');
// Monotonic — harder is never quieter.
for (let v = 1; v < 127; v++) {
  assert.ok(gainForVelocity(v + 1) >= gainForVelocity(v), `velocity ${v} -> ${v + 1} went down`);
}
// A device that sends nothing useful lands on the neutral level rather than 0.
assert.equal(gainForVelocity(undefined), 1);
assert.equal(gainForVelocity(0), 1);

// ---------- the damper pedal ----------
//
// CC 64 is a switch: 64 and above is down. setPedal(false) must release
// whatever the pedal was holding, and releaseAll() must clear the pedal too —
// a voice parked on it is exactly the kind that rings forever.

const cc = (number, rawValue) => ({ controller: { number }, rawValue });
const pedalListener = [...a.listeners.get('controlchange')][0];
assert.ok(pedalListener, 'the pedal is not listened for');

// The pedal is state, not a note: driving it must not throw and must be
// idempotent in both directions.
pedalListener(cc(64, 127));      // down
pedalListener(cc(64, 127));      // still down
pedalListener(cc(64, 0));        // up
pedalListener(cc(64, 0));        // still up
// A controller that is not the damper is ignored.
pedalListener(cc(1, 127));       // mod wheel
pedalListener(cc(7, 0));         // volume
// A malformed message must not take the input path down.
pedalListener({});
midi.setPedal(true);
midi.releaseAll();
midi.setPedal(false);

// ---------- which instrument sounds a live key ----------
//
// A digital piano sounds the key under the player's finger out of its own
// speakers. The app used to sound its sample on top of that, so every live key
// was two instruments at once — different timbre, different decay, and the set
// pulled 5.7 cents off A=440 against the keyboard's own tuning, which beats on
// anything held. deviceSink() is the one question midi-input.js asks before
// starting a voice, so its truth table is the rule.
//
// BOTH halves have to hold. A controller with no engine of its own (the M32 in
// this fixture is exactly that) must never be left silent because a port
// happened to exist, and a piano unplugged mid-session must fall back to the
// samples rather than going quiet.
const { deviceSink } = await import('../src/renderer/midi-out.js');
const { state } = await import('../src/renderer/state.js');

fake.outputs = [];
state.midiSink = 'device';
assert.equal(deviceSink(), false,
  'asking for the keyboard with no output port falls back to the samples');

fake.outputs = [{ id: 'out-a', name: 'Keystation 61' }];
assert.equal(deviceSink(), true, 'a port plus the choice means the keyboard sounds it');

state.midiSink = 'internal';
assert.equal(deviceSink(), false, 'and the samples are still reachable with one plugged in');

// The enabled flag and the port list are set at different points in the
// library's start-up, and publishDevice() now asks between them. Neither an
// absent list nor a disabled singleton may throw.
fake.outputs = undefined;
state.midiSink = 'device';
assert.equal(deviceSink(), false, 'a singleton with no port list yet does not throw');
const { midiOutputs } = await import('../src/renderer/midi-out.js');
assert.deepEqual(midiOutputs(), [], 'and it lists no outputs rather than throwing');

console.log('midi-webmidi: pedal + velocity ok');
console.log('midi-webmidi: sink rule ok');
