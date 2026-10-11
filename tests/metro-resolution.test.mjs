// The metronome must measure SILENCE the same way a held key measures SOUND.
//
// A note is worth as little as a danta — an eighth of a beat — because
// startHoldPromotion() resolves a hold to the danta. Silence was counted in
// METRONOME TICKS, one per beat, so the smallest gap that could be written was
// a whole beat, and a gap was only written when a tick happened to fire. Play
// two dantas one danta-rest apart and the rest fell between two ticks: nothing
// was written and the score read as two dantas in a row. The notation measured
// its notes to an eighth of a beat and the space between them to a whole one.
//
// Silence is now read off the wall clock against the current tempo — the same
// conversion the hold uses — and flushed both on a tick AND in front of the
// next note. This drives the real functions with a fake performance.now().

const el = new Proxy(function () {}, {
  get: (t, k) => (k === 'length' ? 0 : k === Symbol.toPrimitive ? () => '' : el),
  set: () => true,
  apply: () => el,
});
globalThis.document = new Proxy({}, { get: () => el, set: () => true });

let clock = 0;
globalThis.performance = { now: () => clock };
// The score clock is pumped by hand below, so no REAL timer may run: with
// performance.now() faked, a live timer would see dt = 0, reschedule itself
// forever and hang the run.
globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};

const assert = (await import('node:assert/strict')).default;
const { state } = await import('../src/renderer/state.js');
const { TIME_UNITS_PER_BEAT } = await import('../src/renderer/config.js');
const {
  addNote, beginMetronomeEntry, closeMetronomeSilence, endMetronomeEntry,
  onMetronomeTick, startHoldPromotion, stopMetronomeEntry, tickScoreClock,
} = await import('../src/renderer/score.js');

let checks = 0;
const is = (a, b, m) => { checks++; assert.equal(a, b, m); };

const beatMs = () => 60000 / state.bpm;
const totalUnits = () => state.notes.reduce(
  (u, n) => u + Math.round((Number(n.dur) || 0) * TIME_UNITS_PER_BEAT), 0);

function reset(bpm = 60) {
  stopMetronomeEntry();
  state.bpm = bpm;
  state.holdWrites = 'time';
  state.sym = 'bindu';
  state.metroOn = true;
  state.fill = 'metro';
  state.notes = [];
  state.hist = [];
  clock = 10000;
}

// Exactly what piano.js / keyboard.js / midi-input.js do on a key press.
function play(beats) {
  closeMetronomeSilence();
  const i = state.notes.length;
  addNote(0, { playSound: false });
  beginMetronomeEntry();
  const release = startHoldPromotion(i, state.sym);
  clock += beats * beatMs();
  release();
  endMetronomeEntry();
}
// Idle time, pumped through the score clock the way the real danta timer does.
function wait(beats) {
  let left = beats * beatMs();
  const step = beatMs() / TIME_UNITS_PER_BEAT;      // one danta
  while (left > 1e-9) {
    const dt = Math.min(step, left);
    clock += dt;
    tickScoreClock(dt);
    left -= dt;
  }
}

// ---------- a gap SHORTER than a beat is written ----------

reset();
play(1 / 8);                 // danta
wait(3 / 8);                 // three dantas of silence, no tick in between
play(1 / 8);                 // danta
is(totalUnits(), 5, 'danta + 3 units of rest + danta survives with no tick at all');
is(state.notes.filter(n => n.type === 'rest').length > 0, true, 'the sub-beat gap became rests');
is(state.notes[0].sym, 'danta', 'the first note is still a danta');
is(state.notes[state.notes.length - 1].sym, 'danta', 'the second note is still a danta');

// The same figure, one danta of silence.
reset();
play(1 / 8);
wait(1 / 8);
play(1 / 8);
is(totalUnits(), 3, 'a ONE danta gap is written, not swallowed');

// Back to back with no gap writes no rest at all.
reset();
play(1 / 8);
play(1 / 8);
is(totalUnits(), 2, 'no gap means no rest');
is(state.notes.every(n => n.type === 'note'), true, 'nothing spurious inserted');

// ---------- silence still adds up over a tick ----------

reset();
play(1 / 8);
wait(7 / 8);                 // out to the beat line
onMetronomeTick();
play(1 / 8);
is(totalUnits(), 9, 'a tick and a press agree: one full beat, then the next note');

// A tick that fires with the fractional remainder pending must not double-count
// it when the next press flushes.
reset();
play(1 / 4);
wait(1 / 2);
onMetronomeTick();
wait(1 / 4);
play(1 / 4);
// praya(2) + 6 units of silence + praya(2). The tick writes none of it — four
// units do not finish the beat — and the press writes all six.
is(totalUnits(), 10, 'tick then press writes each unit of silence exactly once');

// ---------- whole beats of silence are bindu rests, wherever the key came up ----------

// A key is released anywhere between two clicks. A click that wrote everything
// it had cut each beat of silence at the click, so releasing half a beat after
// one filled the staff with pairs of vasu rests.
for (const after of [1 / 2, 1 / 4, 3 / 8]) {
  reset();
  closeMetronomeSilence();
  addNote(0, { playSound: false });
  beginMetronomeEntry();
  const up = startHoldPromotion(0, state.sym);
  clock += beatMs() / 2;
  onMetronomeTick();         // one click heard while the key is down: a bindu
  clock += after * beatMs();
  up();
  endMetronomeEntry();
  wait(1 - after);
  for (let i = 0; i < 5; i++) { onMetronomeTick(); wait(1); }
  const rests = state.notes.slice(1);
  is(rests.length, 4, `released ${after} of a beat after a click: one rest a beat`);
  is(rests.every(n => n.sym === 'rest_symbol_1'), true, '...and every one a bindu rest');
  play(1 / 8);               // the part-beat left over lands in front of the next note
  is(totalUnits(), 8 + Math.round((5 + 1 - after) * 8) + 1, '...with no silence lost');
}

// ---------- silence is measured in BEATS, so tempo scales it ----------

// The same WALL-CLOCK gap is worth twice as much at half the tempo.
for (const [bpm, expected] of [[60, 4], [120, 6]]) {
  reset(bpm);
  play(1 / 8);
  clock += 250;              // 1/4 beat at 60, 1/2 beat at 120
  play(1 / 8);
  is(totalUnits(), expected, `a 250ms gap is worth ${expected - 2} units at ${bpm}bpm`);
}

// A tempo change part-way through the silence is honoured, the way it is
// part-way through a hold: half the gap at each tempo.
reset(60);
play(1 / 8);
wait(0.5);                   // half a beat at 60 = 4 units
state.bpm = 120;
wait(1);                     // a whole beat at 120 = 8 units
play(1 / 8);
is(totalUnits(), 14, 'silence spanning a tempo change is measured at both tempi');

// ---------- the guards still hold ----------

// 'auto' fill derives its rests at render time; nothing may be written here.
reset();
state.fill = 'auto';
play(1 / 8);
wait(2);
play(1 / 8);
is(totalUnits(), 2, "'auto' fill writes no rests of its own");

// A gap while a key is STILL DOWN is sound, not silence.
//
// TWO ticks land inside the hold rather than one, because with the metronome
// running the ticks are what a hold is WORTH: each click a key is still down
// through is one more beat of value. Two beats held is two clicks heard is a
// guru — the same note this always asserted, reached by the count instead of
// by the wall clock.
reset();
closeMetronomeSilence();
const idx = state.notes.length;
addNote(0, { playSound: false });
beginMetronomeEntry();
const rel = startHoldPromotion(idx, state.sym);
clock += beatMs();
onMetronomeTick();           // a tick lands mid-hold
clock += beatMs();
onMetronomeTick();
rel();
endMetronomeEntry();
is(state.notes.filter(n => n.type === 'rest').length, 0, 'a tick during a hold writes no rest');
is(state.notes[idx].sym, 'guru', 'the held note is a guru, and the tick did not shorten it');

console.log(`metro-resolution: ${checks} checks passed`);
