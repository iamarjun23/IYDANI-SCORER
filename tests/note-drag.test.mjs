// npm run test:note-drag — drag-and-drop on the sheet: the y -> rung snap and
// what a drop does to state.notes (insert and push, move, pad past the end).

const el = new Proxy(function () {}, {
  get: (t, k) => (k === 'length' ? 0 : k === Symbol.toPrimitive ? () => '' : el),
  set: () => true,
  apply: () => el,
});
globalThis.document = new Proxy({}, { get: () => el, set: () => true });

const assert = (await import('node:assert/strict')).default;
const { state } = await import('../src/renderer/state.js');
const { noteY } = await import('../src/renderer/notation.js');
const { placeAt } = await import('../src/renderer/score.js');
const { pitchAtY } = await import('../src/renderer/note-drag.js');

// Every writable rung snaps back to itself; the magic line goes to a neighbour.
for (const oct of [-1, 0, 1]) {
  for (let svi = 0; svi < 7; svi++) {
    assert.deepEqual(pitchAtY(noteY(svi, oct)), { svi, oct });
  }
}
const ga = noteY(2, 0), ma = noteY(3, 0);
assert.deepEqual(pitchAtY((ga + ma) / 2 + 1), { svi: 2, oct: 0 });
assert.deepEqual(pitchAtY((ga + ma) / 2 - 1), { svi: 3, oct: 0 });
assert.deepEqual(pitchAtY(-500), { svi: 6, oct: 1 });
assert.deepEqual(pitchAtY(500), { svi: 0, oct: -1 });

const N = svi => ({ type: 'note', svaraIndex: svi, oct: 0, head: 'o', sym: 'bindu', dot: false, dur: 1 });
const svis = () => state.notes.map(n => (n.type === 'rest' ? 'r' : n.svaraIndex));
const reset = () => { state.notes.splice(0, state.notes.length, N(0), N(1), N(2)); state.hist = []; };

reset();
placeAt(N(4), 8);                       // before the second note
assert.deepEqual(svis(), [0, 4, 1, 2]);

reset();
placeAt(N(4), 40);                      // two beats past the end: rests fill the gap
assert.deepEqual(svis(), [0, 1, 2, 'r', 'r', 4]);

state.notes.splice(0); state.hist = [];
placeAt({ ...N(0), sym: 'maguru', dur: 4 }, 13);  // Maguru on an empty 4/4 staff: starts it
assert.deepEqual(svis(), [0]);

reset();
placeAt(N(4), 43);                      // past the end, snapped down to the beat
assert.deepEqual(svis(), [0, 1, 2, 'r', 'r', 4]);

reset();
assert.equal(placeAt({ svaraIndex: 0, oct: 0, head: 'o' }, 0, 0), false);  // dropped in place
placeAt({ svaraIndex: 5, oct: 0, head: 'o' }, 24, 0);  // first note to the end, new pitch
assert.deepEqual(svis(), [1, 2, 5]);
assert.equal(state.notes[2].sym, 'bindu');

console.log('note-drag: ok');
