// Does the app actually count off the KEYBOARD's clock?
//
// midi-clock.js is pure and covered on its own, and tests/midi-webmidi.test.mjs
// proves the clock listeners get bound. Neither of them touches the part in
// between — the wiring in midi-input.js that turns an arriving 0xF8 into a
// click on the app's own metronome — and that is the part a player hears. Its
// failure mode is not an exception: it is the app's metronome counting on
// beside the piano, in its own time, with every setting looking correct.
//
// So this drives the REAL listeners, through a fake WebMidi singleton and a
// recording AudioContext, and reads the click grid back off the audio graph.
//
// The fake clock is arranged so that one millisecond of performance.now() is
// one millisecond of AudioContext time from the same origin, and the fake
// context reports no output latency. A click for a beat at performance time
// `t` is then scheduled at exactly `(t - T0) / 1000` on the audio clock, so
// the numbers asserted below ARE the beat times.

import assert from 'node:assert/strict';

let checks = 0;
const is = (a, b, m) => { checks++; assert.equal(a, b, m); };
const ok = (c, m) => { checks++; assert.ok(c, m); };
const near = (a, b, m, eps = 1e-6) => {
  checks++;
  assert.ok(Math.abs(a - b) <= eps, `${m} — ${a} vs ${b}`);
};

// ---------- a recording AudioContext ----------

let ctx = null;
let started = [];

class FakeParam {
  setValueAtTime() { return this; }
  linearRampToValueAtTime() { return this; }
  exponentialRampToValueAtTime() { return this; }
  cancelScheduledValues() { return this; }
}
class FakeNode {
  constructor() {
    this.gain = new FakeParam();
    this.frequency = new FakeParam();
    this.Q = new FakeParam();
    this.threshold = new FakeParam();
    this.knee = new FakeParam();
    this.ratio = new FakeParam();
    this.attack = new FakeParam();
    this.release = new FakeParam();
  }
  connect(n) { return n; }
  disconnect() {}
  addEventListener() {}
  start(t) {
    assert.ok(Number.isFinite(t), 'a click was scheduled at a non-finite time');
    started.push(t);
  }
  stop() {}
}
class FakeCtx {
  constructor() {
    ctx = this;
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.state = 'running';
    // No getOutputTimestamp and no declared latency, so the conversion between
    // the two clocks is the identity and the asserted beat times stay
    // readable. The latency correction itself is audio.js's business and is
    // covered where it lives.
    this.baseLatency = 0;
    this.outputLatency = 0;
    this.destination = new FakeNode();
  }
  resume() {}
  createGain() { return new FakeNode(); }
  createOscillator() { return new FakeNode(); }
  createBiquadFilter() { return new FakeNode(); }
  createBufferSource() { return new FakeNode(); }
  createDynamicsCompressor() { return new FakeNode(); }
  createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; }
}

// ---------- environment ----------

const el = new Proxy(function () {}, {
  get: (t, k) => (k === 'length' ? 0 : k === Symbol.toPrimitive ? () => '' : el),
  set: () => true,
  apply: () => el,
});
const listeners = new Map();
const docStub = {
  addEventListener: (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  },
  removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
  // Live, not swallowed. The tempo an external source reports travels as a
  // 'tempo:external' event because toolbar.js owns the tempo field — see
  // setTempoFromClock() — so a stub that dropped it would test the tap path
  // with the tempo permanently stuck wherever it started.
  dispatchEvent: e => { [...(listeners.get(e.type) || [])].forEach(fn => fn(e)); return true; },
};
globalThis.document = new Proxy(docStub, {
  get: (t, k) => (k in t ? t[k] : el),
  set: () => true,
});
globalThis.Event = class { constructor(type) { this.type = type; } };
globalThis.CustomEvent = class {
  constructor(type, o) { this.type = type; Object.assign(this, o || {}); }
};

// The metronome's pump and the follower's watchdog both live on setInterval.
// Captured rather than fired, so a whole stretch of counting can be stepped
// through instantly: the point is to inspect a schedule, not to wait for one.
const timers = new Set();
globalThis.setInterval = fn => { timers.add(fn); return fn; };
globalThis.clearInterval = fn => { timers.delete(fn); };
// The tap-run settle nudge lives on a real setTimeout — captured with the
// intervals, so a run can be walked past its timeout instantly.
const late = new Set();
globalThis.setTimeout = fn => { late.add(fn); return fn; };
globalThis.clearTimeout = fn => { late.delete(fn); };
const fireLate = () => { const fns = [...late]; late.clear(); fns.forEach(fn => fn()); };

// One millisecond of performance time is one millisecond of audio time.
const T0 = 10000;
let perfNow = T0;
globalThis.performance = { now: () => perfNow };
function advance(ms) {
  perfNow += ms;
  if (ctx) ctx.currentTime = (perfNow - T0) / 1000;
}

Object.defineProperty(globalThis, 'window', {
  value: { AudioContext: FakeCtx, addEventListener: () => {} },
  configurable: true,
});
globalThis.fetch = () => Promise.reject(new Error('no samples under test'));

// ---------- a fake keyboard ----------

function fakeInput(id, name) {
  return {
    id,
    name,
    manufacturer: 'Test',
    state: 'connected',
    listeners: new Map(),
    addListener(ev, fn) {
      if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
      this.listeners.get(ev).add(fn);
    },
    removeListener(ev, fn) {
      if (ev === undefined) return this.listeners.clear();
      this.listeners.get(ev)?.delete(fn);
    },
    fire(ev, e) { [...(this.listeners.get(ev) || [])].forEach(fn => fn(e)); },
  };
}
const fake = {
  supported: true,
  enabled: false,
  inputs: [],
  _global: new Map(),
  async enable() { this.enabled = true; return this; },
  addListener(ev, fn) { this._global.set(ev, fn); },
};
globalThis.WebMidi = fake;
const kbd = fakeInput('in-a', 'Test Piano');
fake.inputs = [kbd];

const hushed = ['error', 'info', 'warn', 'log'].map(k => {
  const f = console[k];
  console[k] = () => {};
  return [k, f];
});
const { state } = await import('../src/renderer/state.js');
const midi = await import('../src/renderer/midi-input.js');
const {
  followingClock, startMetronome, stopMetronome, anchorHeld,
} = await import('../src/renderer/metronome.js');
const { PPQ, TAP_TIMEOUT_MS: TAP_TIMEOUT } = await import('../src/renderer/midi-clock.js');
hushed.forEach(([k, f]) => { console[k] = f; });

await midi.initMidiInput();
state.metroSound = 0;
state.midiSync = 'follow';
state.midiSyncOffset = 0;

// Beats, in performance-clock milliseconds since T0. One click builds two
// voices at the same instant, so equal times collapse to a single beat.
function beats() {
  const out = [];
  for (const at of started.slice().sort((a, b) => a - b)) {
    const ms = at * 1000;
    if (!out.length || Math.abs(out[out.length - 1] - ms) > 1e-6) out.push(ms);
  }
  return out;
}

const BPM = 120;
const PERIOD = 60000 / (BPM * PPQ);     // 20.8333… ms between pulses

function pulses(n) {
  for (let i = 0; i < n; i++) {
    kbd.fire('clock', { timestamp: perfNow });
    advance(PERIOD);
  }
}

// ---------- before a single pulse, the dock says so ----------
//
// This is the line the whole feature turns on. A keyboard that transmits no
// clock cannot be followed however the picker is set, and with no statement of
// that fact the failure is indistinguishable from the app ignoring the setting
// — which is exactly how it was reported.

let st = midi.syncStateFor(midi.midiStatus());
is(st.text, 'no beat clock from this keyboard',
  'a silent cable has to be named as one, and answered');
is(st.cls, 'want', 'and flagged as needing something from the player');
is(midi.canTapSync(), true, 'with nothing on the wire, no clock is available');
is(state.midiClockRunning, false, 'nothing is running');
is(followingClock(), false, 'so the app counts for itself');

// ---------- a free-running clock is believed after one beat of it ----------

started = [];
pulses(60);

is(state.midiClockSeen, true, 'the clock was seen');
is(state.midiClockRunning, true, 'and is running');
is(state.midiClockFree, true, 'this device never announced a downbeat');
is(state.midiClockBpm, BPM, 'the tempo is read off the pulse interval');
is(state.metroOn, true, 'a master that starts counting switches our click on');
is(followingClock(), true, 'so the standalone loop must stand down');

st = midi.syncStateFor(midi.midiStatus());
is(st.text, 'following tempo — tap the downbeat to lock the bar',
  'free-run is a tempo without a bar, and says so');
is(midi.canAlignDownbeat(), true, 'which is exactly when the tap is offered');

// The count is believed on the 25th pulse — one full beat of evidence — and
// beat 0 is that pulse. Every beat after it is half a second later at 120.
const free = beats();
ok(free.length >= 2, `beats must actually sound — got ${free.length}`);
near(free[0], 24 * PERIOD, 'beat 0 lands on the pulse the clock was believed at');
for (let i = 1; i < free.length; i++) {
  near(free[i] - free[i - 1], 500, `beat ${i} is one beat after beat ${i - 1}`);
}

// ---------- the tap moves the PHASE and nothing else ----------
//
// The whole complaint about a free-running device is that the two clicks sit a
// fraction of a beat apart. One tap on the keyboard's own click settles it for
// as long as the device keeps counting, because the tempo was never in doubt.

const tapAt = perfNow;
is(midi.alignClockDownbeat(), true, 'a running clock can be aligned');
is(state.midiClockAligned, true, 'and remembers that it was');
st = midi.syncStateFor(midi.midiStatus());
is(st.text, 'following the keyboard’s beat', 'once the bar is known, it is simply following');
is(st.cls, 'live', 'which is the settled state');
// The button STAYS. A tap is a human landing on a click, so the first one can
// be a few milliseconds out and the obvious repair is to tap again — taking
// the control away the moment it is first used would make that impossible.
is(midi.canAlignDownbeat(), true, 'a tap that missed has to be repeatable');
is(state.midiClockBpm, BPM, 'aligning must not disturb the tempo');

started = [];
pulses(120);
const locked = beats();
ok(locked.length >= 4, `beats must keep sounding after a tap — got ${locked.length}`);
// A tap can only land on a pulse, so the new downbeat is the pulse nearest to
// it — within half a pulse of the tap itself, and every beat after that a
// whole number of beats away.
for (const b of locked) {
  const off = (((b - (tapAt - T0)) % 500) + 500) % 500;
  const err = Math.min(off, 500 - off);
  ok(err <= PERIOD / 2 + 1e-6, `a beat landed ${err.toFixed(1)}ms off the tapped downbeat`);
}

// ---------- a device that DOES announce its bar supersedes the tap ----------

started = [];
const startAt = perfNow;
kbd.fire('start', { timestamp: perfNow });
is(state.midiClockFree, false, 'a Start message is a downbeat');
is(state.midiClockAligned, false, 'so the guess it replaces is dropped');
st = midi.syncStateFor(midi.midiStatus());
is(st.text, 'following the keyboard’s beat', 'and the state is simply following');
is(midi.canAlignDownbeat(), false, 'nothing to tap when the device says where the bar is');

pulses(72);
const led = beats();
ok(led.length >= 3, `a Start must be followed by beats — got ${led.length}`);
near(led[0], startAt - T0, 'beat 0 is the Start itself');
near(led[1] - led[0], 500, 'and the count runs on from there');

// ---------- Stop puts back the metronome it took over ----------

kbd.fire('stop', { timestamp: perfNow });
is(state.midiClockRunning, false, 'the master stopped');
is(state.metroOn, false, 'so the click it switched on goes off with it');
is(followingClock(), false, 'and the standalone loop is free to count again');
st = midi.syncStateFor(midi.midiStatus());
is(st.text, 'keyboard clock stopped', 'a stopped master is not a missing one');

// ---------- a click the PLAYER started is not the master's to silence ----------

startMetronome();
is(state.metroOn, true, 'the player switched it on');
kbd.fire('start', { timestamp: perfNow });
kbd.fire('stop', { timestamp: perfNow });
is(state.metroOn, true, 'a master that stops must not silence a click we did not start');
stopMetronome();
is(state.metroOn, false, 'and the button still puts it away');

// ---------- a keyboard that sends nothing at all ----------
//
// The case this was reported from. Most digital pianos never transmit beat
// clock: the metronome makes a sound in the room and says nothing down the
// cable, so 'follow' has nothing to follow however it is set. What is left is
// the click itself and a player who can hear it — tapping along carries the
// same two facts the wire was going to, the tempo and the downbeat.

// A fresh device, so nothing is remembered about the clock that was running.
midi.setMidiDevice(null);
is(state.midiClockSeen, false, 'a new master is not the old one');
is(state.midiTapSynced, false);
is(state.metroOn, false, 'and nothing is counting');
st = midi.syncStateFor(midi.midiStatus());
is(st.text, 'no beat clock from this keyboard', 'which is what the dock says');
is(midi.canTapSync(), true, 'and tapping is what it offers');
is(midi.canAlignDownbeat(), false, 'there is no phase to move without a clock');

// toolbar.js owns the tempo field, so the tempo an external source reports
// reaches state.bpm through the event — stood in for here.
document.addEventListener('tempo:external', e => { state.bpm = e.detail.bpm; });

// ---- one tap, when the tempo is already right ----
//
// A keyboard's metronome DISPLAYS its bpm. Typing that number into the tempo
// field matches the two tempi exactly — better than any number of taps can
// estimate — and leaves only the question of where the bar begins. So a single
// tap has to be enough, and it must not disturb the number that was typed.

state.bpm = 96;                        // read off the keyboard's own display
const TAP96 = 60000 / 96;
const oneTapAt = perfNow;
let first = midi.tapSyncBeat();
is(first.count, 1, 'one tap is a downbeat');
is(first.bpm, null, 'and no tempo — one tap has no interval in it');
is(state.bpm, 96, 'so the tempo that was typed is left exactly alone');
is(state.midiTapSynced, true, 'but the bar is placed on it, which is the point');
is(state.metroOn, true, 'and the click starts');

st = midi.syncStateFor(midi.midiStatus());
is(st.text, 'bar lined up at 96 bpm — keep tapping for the tempo',
  'the dock says which half of the job the tap did');
is(st.cls, 'live');

started = [];
for (let i = 0; i < 100; i++) {
  advance(25);
  timers.forEach(fn => fn());
}
const oneTap = beats();
ok(oneTap.length >= 3, `the lined-up count must sound — got ${oneTap.length}`);
near(oneTap[0], oneTapAt - T0 + TAP96, 'the first beat is one beat after the tap', 1e-3);
for (let i = 1; i < oneTap.length; i++) {
  near(oneTap[i] - oneTap[i - 1], TAP96, `beat ${i} follows at the TYPED tempo`, 1e-3);
}

// ---- keep tapping, and the tempo comes from the taps too ----
//
// The other half: a player who cannot read the number off the instrument taps
// it out. Four taps half a second apart is 120, and it overrides the 96.

const TAP_MS = 500;
advance(TAP_TIMEOUT + 500);            // past the timeout, so this is a NEW run
midi.tapSyncBeat();
let last = null;
let lastTapAt = 0;
for (let i = 0; i < 3; i++) {
  advance(TAP_MS);
  lastTapAt = perfNow;
  last = midi.tapSyncBeat();
}
is(last.count, 4, 'four taps in the run');
is(last.bpm, 120, 'half a second between them is 120 bpm');
is(state.bpm, 120, 'and the tempo field takes it, the same way it takes a clock’s');
is(state.midiTapSynced, true, 'the beat is matched');
is(state.metroOn, true, 'and matching it starts the click, since that is the point');

// While the run is still live, the estimate is shown CONVERGING. A tap tempo
// settles as 1/(n-1), so the count and the running number are what let a
// player see it arrive and compare it with the number printed on the piano.
st = midi.syncStateFor(midi.midiStatus());
is(st.text, 'tap 4 · 120 bpm — keep tapping to settle it',
  'the estimate and the tap count are both on show while it is still moving');
is(st.cls, 'live');

// The count now runs on the tapped grid: the next beat is one period after the
// last tap, and every beat after that a beat apart.
started = [];
for (let i = 0; i < 120; i++) {
  advance(25);
  timers.forEach(fn => fn());
}
const tapped = beats();
ok(tapped.length >= 4, `the tapped count must sound — got ${tapped.length}`);
near(tapped[0], lastTapAt - T0 + TAP_MS, 'the first beat is one beat after the last tap', 1e-3);
for (let i = 1; i < tapped.length; i++) {
  near(tapped[i] - tapped[i - 1], TAP_MS, `beat ${i} follows a beat later`, 1e-3);
}

// Once the run goes quiet it has settled, and the number is STATED — the
// question being answered is "does this match the piano's display". The run
// above already carried time past the timeout; the nudge is what repaints,
// since a run ends by nothing arriving and nothing arriving fires no event.
fireLate();
st = midi.syncStateFor(midi.midiStatus());
is(st.text, 'matched by ear · 120 bpm', 'a settled run names the tempo it landed on');
is(st.cls, 'live');

// ---------- a tapped bar survives the metronome button ----------
//
// It did not. Restarting the click re-anchored at `now + LEAD_IN` and threw
// the placed downbeat away — measured a third of a beat out at 96 bpm — while
// the dock went on reporting the bar as lined up. The tempo has not changed
// across a stop, so the bar is still where the player put it, and the grid is
// projected forward rather than started again.

const tapGrid = b => {
  const off = (((b - (lastTapAt - T0)) % TAP_MS) + TAP_MS) % TAP_MS;
  return Math.min(off, TAP_MS - off);
};

stopMetronome();
advance(137);                          // a pause of no particular length
started = [];
startMetronome();
for (let i = 0; i < 60; i++) {
  advance(25);
  timers.forEach(fn => fn());
}
const resumed = beats();
ok(resumed.length >= 2, `the restarted count must sound — got ${resumed.length}`);
resumed.forEach(b => {
  ok(tapGrid(b) <= 1e-3, `a beat landed ${tapGrid(b).toFixed(1)}ms off the tapped grid after a restart`);
});
is(midi.syncStateFor(midi.midiStatus()).cls, 'live', 'and the dock is still right to say so');

// ---------- a new tempo ends the alignment, and the dock stops claiming it ----------
//
// A grid is an origin AND a spacing. Typing a new tempo keeps the origin and
// throws away the spacing, which is not a bar — so the claim has to go with it
// rather than outliving what the metronome is actually doing.

state.bpm = 132;
is(midi.syncStateFor(midi.midiStatus()).text,
  'no beat clock from this keyboard',
  'a tempo the tap never measured is not a tap sync');
state.bpm = 120;
is(midi.syncStateFor(midi.midiStatus()).text, 'matched by ear · 120 bpm',
  'and putting the tempo back puts the alignment back — nothing was destroyed');

// ---------- a real clock supersedes the ear ----------

pulses(30);
is(state.midiClockRunning, true, 'the keyboard started sending clock after all');
is(state.midiTapSynced, false, 'measured beats beat estimated ones');
is(midi.canTapSync(), false, 'so tapping is no longer what is offered');
is(anchorHeld(), false, 'and the tapped grid is let go with it');
is(followingClock(), true, 'and the wire is what counts the bar');

// ---------- 'off' means off ----------

started = [];
stopMetronome();                      // put back the click the tap section left running
midi.setMidiDevice(null);             // and the clock it left running
is(state.metroOn, false, 'a clean slate');
midi.setMidiSync('off');
is(midi.syncStateFor(midi.midiStatus()).text, '', 'nothing to report when nothing is asked for');
kbd.fire('start', { timestamp: perfNow });
pulses(48);
is(state.metroOn, false, 'a master must not switch on a metronome nobody asked it to');
is(beats().length, 0, 'and must not sound a single click');
// The clock is still DECODED, because whether the device sends one is a fact
// about the device and the dock reports it either way.
is(state.midiClockSeen, true, 'the clock is still read, only not obeyed');

console.log(`midi-follow: ${checks} checks passed`);
