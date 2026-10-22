// What a HELD key writes.
//
// startHoldPromotion() used to floor every hold at the palette's selected
// symbol. The default selection is bindu — one whole beat — so danta, praya,
// praya•, vasu and vasu• all sat below the floor and could not be written by
// playing at all: `Math.max(floorUnits, …)` never returns less than 8 units,
// so however briefly a key was tapped it still came out a bindu. Half the
// ladder was unplayable, and it looked like the notation ignoring the hold.
//
// The floor is a danta now and the hold picks the symbol. WHAT the hold is
// measured against is the other half of this file, and there are two answers:
//
//   metronome OFF — a flat second is one beat (ENTRY_BEAT_MS). The tempo field
//     is a number on a toolbar with nothing counting it out, so holding against
//     it is guesswork; a second is something a player can hold and check.
//
//   metronome ON — the CLICKS are the clock. Each one a key is still down
//     through is one more beat of value, so the faster the count the sooner a
//     held key reaches a guru, and what appears is what was heard counted.
//
// This drives the real clock functions with a fake `performance.now()` so a
// hold of any length can be tested without waiting for it.

const el = new Proxy(function () {}, {
  get: (t, k) => (k === 'length' ? 0 : k === Symbol.toPrimitive ? () => '' : el),
  set: () => true,
  apply: () => el,
});
globalThis.document = new Proxy({}, { get: () => el, set: () => true });

// startHoldPromotion() reads the clock on press and again on release.
let clock = 0;
globalThis.performance = { now: () => clock };

const assert = (await import('node:assert/strict')).default;
const { state } = await import('../src/renderer/state.js');
const {
  SOUND, DOT_MULT, ENTRY_BEAT_MS, TIME_UNITS_PER_BEAT,
} = await import('../src/renderer/config.js');
const {
  addNote, startHoldPromotion, advanceHoldPromotions, onMetronomeTick,
} = await import('../src/renderer/score.js');

let checks = 0;
const is = (a, b, m) => { checks++; assert.equal(a, b, m); };

// What one written note is worth, in timing units.
const unitsOf = (n) => Math.round(n.dur * TIME_UNITS_PER_BEAT);

// Press a key, hold it for `ms`, release. Returns the note that was written.
function holdMs(ms) {
  state.notes = [];
  state.hist = [];
  clock = 1000;
  const index = addNote(0, { playSound: false });
  const release = startHoldPromotion(index, state.sym);
  clock += ms;
  release();
  return state.notes[index];
}

// ---------- metronome OFF: one second is one beat ----------

state.metroOn = false;
state.bpm = 72;
state.sym = 'bindu';          // the default selection — the one that used to win
state.holdWrites = 'time';

is(ENTRY_BEAT_MS, 1000, 'a beat entered with nothing counting is one second');

// hold length (seconds) -> what should be written
const LADDER = [
  [1 / 8, 'danta', false],
  [1 / 4, 'praya', false],
  [3 / 8, 'praya', true],
  [1 / 2, 'vasu', false],
  [3 / 4, 'vasu', true],
  [1, 'bindu', false],
  [1.5, 'bindu', true],
  [2, 'guru', false],
  [3, 'guru', true],
  [4, 'Maguru', false],
];

for (const [secs, sym, dot] of LADDER) {
  const note = holdMs(secs * 1000);
  is(note.sym, sym, `holding ${secs}s writes ${sym}${dot ? '•' : ''}`);
  is(!!note.dot, dot, `holding ${secs}s writes the right chukki`);
  is(
    unitsOf(note),
    Math.round(SOUND[sym].dur * (dot ? DOT_MULT : 1) * TIME_UNITS_PER_BEAT),
    `${sym}${dot ? '•' : ''} is worth what it says`,
  );
}

// A hold BETWEEN two symbols keeps every danta it was down for: 11 dantas is
// written (and played) as 11, headed by the largest glyph that fits — not
// rounded down to a bindu.
for (const dantas of [5, 7, 11, 13, 23]) {
  const note = holdMs(dantas * ENTRY_BEAT_MS / TIME_UNITS_PER_BEAT);
  is(unitsOf(note), dantas, `a ${dantas}-danta hold is worth ${dantas} dantas`);
}
is(holdMs(11 * ENTRY_BEAT_MS / 8).sym, 'bindu', 'an 11-danta hold is headed by a bindu');

// The shortest tap there is still writes SOMETHING, and writes the shortest
// glyph rather than the palette's.
is(holdMs(0).sym, 'danta', 'a zero-length tap writes a danta, not a bindu');
is(holdMs(1000 / 64).sym, 'danta', 'a tap far shorter than one tick writes a danta');

// A hold longer than a Maguru is written as long as it was held; the layout
// carries it across the division line with a join.
is(holdMs(8000).dur, 8, 'eight seconds held is eight beats, not cut to a Maguru');
is(holdMs(5500).dur, 5.5, 'five and a half seconds held is five and a half beats');

// The palette selection no longer decides the value in this mode: the same
// hold writes the same symbol whatever is selected.
for (const selected of ['danta', 'bindu', 'Maguru']) {
  state.sym = selected;
  is(holdMs(250).sym, 'praya', `a praya-length hold writes praya with ${selected} selected`);
}

// The TEMPO does not enter into it with nothing counting. This is the whole
// point of ENTRY_BEAT_MS: the same second of holding writes the same note
// whether the toolbar says 40 or 208, because none of those numbers is being
// sounded and the player has nothing to play them against.
state.sym = 'bindu';
for (const bpm of [40, 72, 120, 208]) {
  state.bpm = bpm;
  is(holdMs(1000).sym, 'bindu', `one second is a bindu at ${bpm}bpm with the metronome off`);
  is(holdMs(2000).sym, 'guru', `two seconds is a guru at ${bpm}bpm with the metronome off`);
}
state.bpm = 72;

// Pumping the clock in danta slices agrees with a single tap, so nothing about
// the growth loop disagrees with the finalizer that follows it.
function pumpMs(ms) {
  state.notes = [];
  state.hist = [];
  clock = 1000;
  const index = addNote(0, { playSound: false });
  const release = startHoldPromotion(index, state.sym);
  const step = ENTRY_BEAT_MS / TIME_UNITS_PER_BEAT;      // one danta
  for (let left = ms; left > 1e-9; left -= step) {
    const dt = Math.min(step, left);
    clock += dt;
    advanceHoldPromotions(dt);
  }
  release();
  return state.notes[index];
}

for (const secs of [0.5, 1, 2, 3]) {
  is(pumpMs(secs * 1000).dur, holdMs(secs * 1000).dur,
    `${secs}s held reads the same pumped as tapped`);
}

// ---------- MIDI event timestamps are the hold, not the handler's clock -----
//
// A key's handler can run a frame after the key arrived (render() shares the
// thread). The press and release are timed from the events' own stamps, so a
// late handler does not move the note across a symbol.
function holdStamped({ pressAt, pressSeen, tickTo = null, releaseAt, releaseSeen }) {
  state.notes = [];
  state.hist = [];
  clock = pressSeen;
  const index = addNote(0, { playSound: false });
  const release = startHoldPromotion(index, state.sym, pressAt);
  if (tickTo != null) { advanceHoldPromotions(tickTo - clock); clock = tickTo; }
  clock = releaseSeen;
  release(releaseAt);
  return unitsOf(state.notes[index]);
}

// 375 ms is three dantas. The press handler ran 70 ms late; read off the clock
// that would be 305 ms, two dantas.
is(holdStamped({ pressAt: 1000, pressSeen: 1070, releaseAt: 1375, releaseSeen: 1375 }), 3,
  'a late press handler does not shorten a stamped hold');
// The release handler late instead: the clock would say 445 ms, four dantas.
is(holdStamped({ pressAt: 1000, pressSeen: 1000, releaseAt: 1375, releaseSeen: 1445 }), 3,
  'a late release handler does not lengthen a stamped hold');
// The growth tick won the race against the queued key-up and counted to 1320;
// the key was up at 1250, two dantas, not the three the tick reached.
is(holdStamped({ pressAt: 1000, pressSeen: 1000, tickTo: 1320, releaseAt: 1250, releaseSeen: 1330 }), 2,
  'time a tick counted past the stamped release is taken back');
// Stamps that cannot be believed fall back to the clock at the call.
is(holdStamped({ pressAt: 0, pressSeen: 5000, releaseAt: 0, releaseSeen: 5250 }), 2,
  'a stale stamp falls back to the clock');
is(holdStamped({ pressAt: 9000, pressSeen: 1000, releaseAt: NaN, releaseSeen: 1250 }), 2,
  'a future or non-numeric stamp falls back to the clock');

// ---------- metronome ON: the tempo sets how long a danta is ----------
//
// A hold is still measured to the danta; the metronome only decides how long a
// beat — and so a danta — is. Nothing is rounded to the nearest click.

// Press, let `ticks` metronome beats go by (with `gapMs` of wall clock between
// them so the danta clock runs too), release.
function holdThroughBeats(ticks, gapMs = 60000 / state.bpm, tailMs = 0) {
  state.notes = [];
  state.hist = [];
  clock = 1000;
  const index = addNote(0, { playSound: false });
  const release = startHoldPromotion(index, state.sym);
  for (let k = 0; k < ticks; k++) {
    const step = gapMs / TIME_UNITS_PER_BEAT;
    for (let j = 0; j < TIME_UNITS_PER_BEAT; j++) { clock += step; advanceHoldPromotions(step); }
    onMetronomeTick();
  }
  clock += tailMs;
  release();
  return state.notes[index];
}

state.metroOn = true;
state.sym = 'bindu';
state.holdWrites = 'time';
state.bpm = 72;

const units = n => Math.round(n.dur * TIME_UNITS_PER_BEAT);
is(holdThroughBeats(1).sym, 'bindu', 'one beat held is one bindu');
is(holdThroughBeats(2).sym, 'guru', 'two beats held is a guru');
is(holdThroughBeats(3).dur, 3, 'three beats held is three beats');
is(holdThroughBeats(9).dur, 9, 'nine beats held is nine beats, not cut to a Maguru');

// Between two clicks the hold keeps its dantas instead of dropping back to the
// last click.
const beat72 = 60000 / 72;
is(units(holdThroughBeats(1, beat72, beat72 / 2)), 12, 'a beat and a half held is a bindu chukki');
is(units(holdThroughBeats(2, beat72, beat72 * 3 / 8)), 19, 'two beats and three dantas is 19 dantas');
is(units(holdThroughBeats(0, 0, beat72 * 7 / 8)), 7, 'seven dantas before the first click is seven dantas');
is(holdThroughBeats(0, 0, 0).sym, 'danta', 'a stab between clicks writes a danta');
is(holdThroughBeats(0, 0, beat72 / 4).sym, 'praya', 'a quarter-beat stab at 72bpm writes a praya');

// THE FASTER THE BEAT, THE FASTER THE VALUE: the same wall-clock hold is worth
// more dantas at a faster count.
{
  state.bpm = 144;
  const fast = holdMs(beat72);
  state.bpm = 72;
  const slow = holdMs(beat72);
  is(fast.sym, 'guru', '833ms is two beats at 144bpm, so a guru');
  is(slow.sym, 'bindu', 'the same 833ms is one beat at 72bpm, so a bindu');
}

// A tempo change part-way through a hold needs no arithmetic here at all: the
// clicks simply arrive at their new spacing, and the note is worth the number
// of them that went by. Two beats at 144 followed by one at 72 is three beats
// played, and three beats is a guru with a chukki.
{
  state.notes = [];
  state.hist = [];
  clock = 1000;
  state.bpm = 144;
  const index = addNote(0, { playSound: false });
  const release = startHoldPromotion(index, state.sym);
  const beat = (bpm) => {
    const step = (60000 / bpm) / TIME_UNITS_PER_BEAT;
    for (let j = 0; j < TIME_UNITS_PER_BEAT; j++) { clock += step; advanceHoldPromotions(step); }
    onMetronomeTick();
  };
  beat(144); beat(144);
  state.bpm = 72;
  beat(72);
  release();
  const n = state.notes[index];
  is(n.sym, 'guru', 'three clicks across a tempo change is a guru');
  is(n.dot, true, 'three clicks across a tempo change takes the chukki');
  is(n.dur, 3, 'three clicks across a tempo change is worth three beats');
}

state.metroOn = false;
state.bpm = 72;

// ---------- 'palette' mode keeps the old rule ----------

state.holdWrites = 'palette';
state.sym = 'bindu';
is(holdMs(125).sym, 'bindu', 'palette mode: a short tap keeps the selected bindu');
is(holdMs(2000).sym, 'guru', 'palette mode: a hold still grows past the floor');
state.sym = 'Maguru';
is(holdMs(0).sym, 'Maguru', 'palette mode: tapping places the selected Maguru');
state.sym = 'danta';
is(holdMs(1000).sym, 'bindu', 'palette mode: a low floor still lets a hold grow');

// ---------- 'fixed' mode writes the selected symbol and nothing else -------
//
// The whole point of the mode: pick a symbol and the hold length stops
// mattering. A tap and a four-beat lean must write the SAME glyph, and it must
// be the selected one — no danta floor underneath it and no growth above it.

state.holdWrites = 'fixed';

for (const sym of ['danta', 'praya', 'vasu', 'bindu', 'guru', 'Maguru']) {
  state.sym = sym;
  for (const ms of [0, 125, 500, 1000, 3000, 8000]) {
    const n = holdMs(ms);
    is(n.sym, sym, `fixed mode: ${sym} selected, held ${ms}ms -> ${sym}`);
    is(n.dot, false, `fixed mode: ${sym} held ${ms}ms takes no chukki`);
    is(n.dur, SOUND[sym].dur, `fixed mode: ${sym} held ${ms}ms keeps its duration`);
  }
}

// Fixed mode is fixed under the metronome too — the clicks have nothing to
// grow, because nothing was registered to grow.
state.metroOn = true;
state.sym = 'bindu';
is(holdThroughBeats(3).sym, 'bindu', 'fixed mode: three beats do not grow the note');
state.metroOn = false;

// The two failure modes this mode exists to prevent, stated directly against
// what the other two rules would have done with the same press.
state.sym = 'bindu';
is(holdMs(125).sym, 'bindu', 'fixed mode: a stab does NOT shrink to a danta the way time mode does');
is(holdMs(4000).sym, 'bindu', 'fixed mode: a long hold does NOT grow to a Maguru the way both other modes do');

// And it is genuinely the selection that decides, so changing the palette
// mid-run changes what the next key writes.
state.sym = 'danta';
is(holdMs(4000).sym, 'danta', 'fixed mode: selecting danta writes danta however long the hold');

state.holdWrites = 'time';
state.sym = 'bindu';

console.log(`hold-value: ${checks} checks passed`);
