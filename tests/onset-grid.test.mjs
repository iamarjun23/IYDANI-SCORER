// Recording against the metronome places each note by WHERE IT STARTED, the
// way a DAW records against its bar — not by adding up the lengths played
// before it, which let every note's rounding carry into the next.

const el = new Proxy(function () {}, {
  get: (t, k) => (k === 'length' ? 0 : k === Symbol.toPrimitive ? () => '' : el),
  set: () => true,
  apply: () => el,
});
globalThis.document = new Proxy({}, { get: () => el, set: () => true });
let clock = 0;
globalThis.performance = { now: () => clock };

const assert = (await import('node:assert/strict')).default;
const { state } = await import('../src/renderer/state.js');
const { TIME_UNITS_PER_BEAT: U } = await import('../src/renderer/config.js');
const {
  addNote, startHoldPromotion, beginMetronomeEntry, endMetronomeEntry,
  closeMetronomeSilence, onMetronomeTick, stopMetronomeEntry,
} = await import('../src/renderer/score.js');

state.metroOn = true;
state.fill = 'metro';
state.bpm = 120;              // 500 ms a beat, 62.5 ms a danta
state.holdWrites = 'time';
state.notes = [];
const BEAT = 500;

const onsets = () => {
  const out = []; let u = 0;
  for (const n of state.notes) { if (n.type === 'note') out.push(u); u += Math.round(n.dur * U); }
  return out;
};

function play(at, holdMs) {
  clock = at;
  closeMetronomeSilence();
  const i = addNote(0, { playSound: false });
  beginMetronomeEntry();
  const release = startHoldPromotion(i, state.sym);
  clock = at + holdMs;
  release();
  endMetronomeEntry();
}

// A click heard at t=1000. The first key lands 20 ms EARLY — it belongs on
// that click, not a whole beat after the previous one.
clock = 1000;
onMetronomeTick(1000);
// Eight notes, one a beat, each held 4.6 dantas: a release that ROUNDS UP
// every time. Chained, the staff ran 0.4 danta ahead per note.
for (let k = 0; k < 8; k++) play(1000 - 20 + k * BEAT, 4.6 * BEAT / U);
assert.deepEqual(onsets(), [0, 8, 16, 24, 32, 40, 48, 56], 'onsets drifted off the beat grid');
assert.equal(Math.round(state.notes[0].dur * U), 5, 'release is placed on the grid too');

// Legato: the next key arrives while the last is still down. The held note
// ends where the new one starts.
stopMetronomeEntry();
state.notes = [];
clock = 5000; onMetronomeTick(5000);
clock = 5000; closeMetronomeSilence();
const a = addNote(0, { playSound: false }); beginMetronomeEntry();
startHoldPromotion(a, state.sym);
clock = 5000 + 1.5 * BEAT; closeMetronomeSilence();
addNote(1, { playSound: false });
assert.deepEqual(onsets(), [0, 12], 'legato note did not start at its onset');

// ---- metronome OFF: an invisible ruler, one beat a second, from the first key.
stopMetronomeEntry();
state.metroOn = false;
state.fill = 'auto';
state.notes = [];
const SEC = 1000;
const restUnits = () => state.notes.filter(n => n.type === 'rest')
  .reduce((u, n) => u + Math.round(n.dur * U), 0);
play(20000, 0.5 * SEC);               // a vasu on beat 0
play(20000 + 2 * SEC, 0.5 * SEC);     // a pause, then beat 2
assert.deepEqual(onsets(), [0, 16], 'metronome off: the pause was not kept');
assert.equal(restUnits(), 12, 'metronome off: the pause should be written as rests');

// A long stop starts a new take instead of a page of rests.
play(20000 + 60 * SEC, 0.5 * SEC);
assert.equal(onsets()[2], 24, 'a long stop wrote silence instead of starting a new take');

console.log('onset-grid: ok');
