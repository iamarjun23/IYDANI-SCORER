// Who is still holding a key, and therefore whether the metronome may write
// silence yet.
//
// metroEntry tracked this as a BOOLEAN, so a chord — trivial to play on a MIDI
// keyboard, and reachable with two fingers on the on-screen one — un-armed
// itself on the first key up. The metronome then started filling rests
// underneath notes that had not stopped sounding. It is a count now.
//
// onMetronomeTick() re-renders when it writes, so the render is stubbed out
// rather than reimplemented: what is under test is what lands in state.notes.

const el = new Proxy(function () {}, {
  get: (t, k) => (k === 'length' ? 0 : k === Symbol.toPrimitive ? () => '' : el),
  set: () => true,
  apply: () => el,
});
globalThis.document = new Proxy({}, { get: () => el, set: () => true });

// Silence is measured against the CLOCK now, not counted one beat per tick, so
// a tick only writes the time that has actually gone by. Faked so a beat can be
// let past on demand — and with it faked, no real timer may run: the score
// clock would see dt = 0, reschedule forever and hang the run.
let clock = 0;
globalThis.performance = { now: () => clock };
globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};
// One beat of silence goes by. Held keys block accrual on their own, so calling
// this while a key is down proves it is the HELD COUNT stopping the write and
// not merely a lack of elapsed time.
const aBeat = () => { clock += 60000 / (state.bpm || 72); };

const assert = (await import('node:assert/strict')).default;
const { state } = await import('../src/renderer/state.js');
const {
  beginMetronomeEntry, endMetronomeEntry, onMetronomeTick, stopMetronomeEntry,
} = await import('../src/renderer/score.js');

let checks = 0;
const is = (a, b, m) => { checks++; assert.equal(a, b, m); };

function fresh() {
  stopMetronomeEntry();
  state.metroOn = true;
  state.fill = 'metro';
  state.hist = [];
  state.future = [];
  state.notes = [{ type: 'note', svaraIndex: 0, oct: 0, head: 'o', sym: 'bindu', dur: 1 }];
}
const wrote = fn => { const n = state.notes.length; fn(); return state.notes.length - n; };

// ---------- one key: unchanged behaviour ----------

fresh();
beginMetronomeEntry();
aBeat();
is(wrote(onMetronomeTick), 0, 'a tick under a held key must not write silence');
endMetronomeEntry();
aBeat();
assert.ok(wrote(onMetronomeTick) > 0, 'a tick after the key came up should fill the beat');
checks++;

// ---------- a chord: only the LAST key up ends the entry ----------

fresh();
beginMetronomeEntry();          // key A down
beginMetronomeEntry();          // key B down
beginMetronomeEntry();          // key C down
endMetronomeEntry();            // A up — B and C are still sounding
aBeat();
is(wrote(onMetronomeTick), 0, 'releasing one key of a chord let the metronome write over it');
endMetronomeEntry();            // B up
aBeat();
is(wrote(onMetronomeTick), 0, 'two keys of the chord are still down');
endMetronomeEntry();            // C up — now, and only now, the chord is over
aBeat();
assert.ok(wrote(onMetronomeTick) > 0, 'the last key came up and nothing was filled');
checks++;

// ---------- an unpaired release cannot drive the count negative ----------
//
// The metronome can be switched on part-way through a hold, in which case the
// begin that would have paired with a release never ran. If that left the
// count at -1, the next real key would not register as held at all.

fresh();
endMetronomeEntry();
endMetronomeEntry();
endMetronomeEntry();
beginMetronomeEntry();
aBeat();
is(wrote(onMetronomeTick), 0, 'an unpaired release left the held count below zero');

// ---------- stopping resets the count ----------

fresh();
beginMetronomeEntry();
beginMetronomeEntry();
stopMetronomeEntry();
state.metroOn = true;
state.fill = 'metro';
beginMetronomeEntry();
endMetronomeEntry();
aBeat();
assert.ok(wrote(onMetronomeTick) > 0, 'a stale held count survived stopMetronomeEntry()');
checks++;

console.log(`metro-entry: ${checks} checks passed`);
