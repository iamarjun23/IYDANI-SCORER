// The tone legend's switches: which tones a score uses, per sthayi, and the one
// thing they do — a tone switched off is not written.
//
// addNote() re-renders, so the render is stubbed out the way metro-entry's is:
// what is under test is what lands in state.notes.

const el = new Proxy(function () {}, {
  get: (t, k) => (k === 'length' ? 0 : k === Symbol.toPrimitive ? () => '' : el),
  set: () => true,
  apply: () => el,
});
globalThis.document = new Proxy({}, { get: () => el, set: () => true });
globalThis.setTimeout = () => 0;

const assert = (await import('node:assert/strict')).default;
const { state, toneOn } = await import('../src/renderer/state.js');
const { scaleTones, tonesFrom } = await import('../src/renderer/config.js');
const { addNote } = await import('../src/renderer/score.js');

let checks = 0;
const is = (a, b, m) => { checks++; assert.deepEqual(a, b, m); };

// ---------- the default is the scale ----------

const semis = row => row.flatMap((on, i) => (on ? [i] : []));
is(scaleTones().map(semis), [0, 1, 2].map(() => [0, 1, 4, 5, 7, 8, 11]),
  'a new score starts on S r G m P d N in every sthayi');

// ---------- a stored selection ----------

is(tonesFrom(undefined, false), scaleTones(), 'a blank score with no selection takes the scale');
is(tonesFrom(undefined, true).flat().every(Boolean), true,
  'an older score holding music keeps all twelve');
is(tonesFrom('nonsense', true).length, 3, 'a selection of the wrong shape is replaced');
const ragged = tonesFrom([[false], null, [true, false]], true);
is(ragged.map(r => r.length), [12, 12, 12], 'short rows are filled out to twelve');
is([ragged[0][0], ragged[0][1], ragged[1][5], ragged[2][1]], [false, true, true, false],
  'only an explicit false is off');

// ---------- the gate ----------

state.tones = scaleTones();
state.notes = [];
is(toneOn(0, 0), true, 'madhya Sa is on');
is(toneOn(2, 0), false, 'madhya R2 is off');
is(toneOn(12, -1), true, 'mandra Sá is madhya Sa');
is(toneOn(0, 5), true, 'outside the three sthayis there is no switch');

is(addNote(1, { playSound: false, head: 'f', oct: 0 }), 0, 'r (in the scale) is written');
is(addNote(1, { playSound: false, head: 'o', oct: 0 }), null, 'R (switched off) is refused');
is(state.notes.length, 1, 'and nothing was added for it');

// Per sthayi: switching R on in taara does not switch it on in madhya.
state.tones[2][2] = true;
is(addNote(1, { playSound: false, head: 'o', oct: 1 }), 1, 'taara R is written once switched on');
is(addNote(1, { playSound: false, head: 'o', oct: 0 }), null, 'madhya R is still off');

console.log(`tones: ${checks} checks passed`);
