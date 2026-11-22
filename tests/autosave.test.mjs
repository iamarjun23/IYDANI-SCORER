// Autosave: the open tabs written to localStorage and put back at launch.
//
// The store is read back on a later day by a later build, so what matters is
// that a session survives the round trip and that anything that is NOT a
// session — nothing, garbage, the wrong shape — leaves the app alone instead of
// being loaded as one. The DOM is the swallow-everything proxy the other
// suites use; render() is real.

const el = new Proxy(function () {}, {
  get: (t, k) => (k === 'length' ? 0 : k === Symbol.toPrimitive ? () => '' : el),
  set: () => true,
  apply: () => el,
});
globalThis.document = new Proxy({}, { get: () => el, set: () => true });
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
};

const assert = (await import('node:assert/strict')).default;
const { state, docs, getActiveDoc } = await import('../src/renderer/state.js');
const { autosaveNow, restoreDocs, newDoc, saveDoc, onFileSaved, tabLabel } = await import('../src/renderer/tabs.js');

const KEY = 'dng.autosave.v1';
const note = svaraIndex => ({
  type: 'note', svaraIndex, oct: 0, head: 'auto', sym: 'bindu', dur: 1, deco: 'none',
});

assert.equal(restoreDocs(), false, 'no store: nothing to restore');

// Two tabs, the second one active, in a key that is not the default.
state.notes = [note(0), note(1)];
state.title = 'First';
state.saMidi = 62;
saveDoc();
newDoc();
state.notes = [note(4)];
state.title = 'Second';
state.breaks = [2];
autosaveNow();

// A relaunch: nothing in memory but what the store holds.
docs.length = 0;
state.notes = [];
state.title = 'Untitled';
state.saMidi = 60;

assert.equal(restoreDocs(), true);
assert.equal(docs.length, 2, 'both tabs come back');
assert.equal(getActiveDoc(), 1, 'on the tab that was open');
assert.equal(state.title, 'Second');
assert.deepEqual(state.notes, [note(4)]);
assert.deepEqual(state.breaks, [2]);
assert.equal(state.saMidi, 62, 'in the key it was written in');
assert.deepEqual(docs[0].notes, [note(0), note(1)]);

// Anything that is not a session is refused, and what is open is untouched.
for (const bad of ['{not json', 'null', '{}', '{"docs":[]}', '{"docs":[{"notes":"x","bars":[]}]}']) {
  store.set(KEY, bad);
  assert.equal(restoreDocs(), false, `refused: ${bad}`);
  assert.equal(docs.length, 2);
  assert.equal(state.title, 'Second');
}

// An active index pointing past the tabs lands on the last one, not on nothing.
store.set(KEY, JSON.stringify({ docs: [{ notes: [], bars: [], title: 'Only' }], active: 9 }));
assert.equal(restoreDocs(), true);
assert.equal(getActiveDoc(), 0);
assert.equal(state.title, 'Only');

// The name chosen in the Save dialog names the tab, per tab, and an export
// coming down the same channel does not.
onFileSaved('My_Song.dng.json');
assert.equal(tabLabel(docs[0]), 'My_Song', 'the tab takes the saved name');
assert.equal(state.title, 'Only', 'the printed title is left alone');
onFileSaved('My_Song.pdf');
assert.equal(docs[0].file, 'My_Song', 'an export is not the document');
newDoc();
assert.equal(tabLabel(docs[1]), 'Untitled', 'a new tab has no file yet');
assert.equal(tabLabel(docs[0]), 'My_Song');

// A damaged or hand-edited session must not be able to make layout, playback or
// the metronome build without limit — that is how one number froze the machine,
// and the autosave would replay it on every launch. Restoring it renders (for
// real) and returns, with every number back inside what the editor can write.
const { MAX_NOTE_BEATS, MAX_REPEAT, MAX_BPM, beatSeconds } = await import('../src/renderer/config.js');
store.set(KEY, JSON.stringify({ active: 0, docs: [{
  title: 'Poisoned', tala: 'chatusra', bpm: 1e9, breaks: [3, 'x', null],
  notes: [{ ...note(0), dur: 1e9 }, { ...note(1), dur: -4 }, null, { ...note(2), dur: '2' }],
  bars: [{ id: 'a', unit: 0, kind: 'open', count: 1e9 }, { id: 'b', unit: 8, kind: 'close', count: 1e9 },
    { id: 'c', unit: 'nowhere', kind: 'open' }],
}] }));
assert.equal(restoreDocs(), true, 'a poisoned session still opens');
assert.equal(state.notes.length, 3, 'a note that is not an object is dropped');
assert.equal(state.notes[0].dur, MAX_NOTE_BEATS, 'an endless note is capped');
assert.equal(state.notes[1].dur, 1, 'a negative length becomes one beat');
assert.equal(state.notes[2].dur, 2, 'a length written as text is kept');
assert.deepEqual(state.bars.map(b => b.count), [MAX_REPEAT, MAX_REPEAT], 'repeat counts are capped');
assert.equal(state.bars.length, 2, 'a mark with no position is dropped');
assert.deepEqual(state.breaks, [3]);
assert.equal(state.bpm, MAX_BPM, 'the tempo is clamped');
assert.equal(beatSeconds(1e9), 60 / MAX_BPM, 'and the clock clamps it on its own as well');
// `1e400` is valid JSON and parses to Infinity: the default, not the ceiling.
const { safeScore, BPM } = await import('../src/renderer/config.js');
assert.equal(safeScore(JSON.parse('{"bpm":1e400,"notes":[{"dur":1e400}]}')).bpm, BPM);
assert.equal(safeScore(JSON.parse('{"notes":[{"dur":1e400}]}')).notes[0].dur, 1);

console.log('autosave tests passed');
