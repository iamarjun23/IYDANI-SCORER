// A composer playing a take against the metronome: held keys of ONE beat and
// of TWO AND A HALF beats, with the silences between them, at several tempos
// and with a human's timing (early/late presses, short/long releases).
//
// Unlike hold-value / onset-grid, this runs the whole loop the app runs: the
// metronome's click (onMetronomeTick), the danta clock (tickScoreClock) and
// the key path exactly as piano.js calls it — closeMetronomeSilence, addNote,
// beginMetronomeEntry, startHoldPromotion ... release, endMetronomeEntry.
// What must come out: every note on the beat it was played on, worth what it
// was held, rests filling the gaps, and the score never ahead of or behind
// the clicks.

const el = new Proxy(function () {}, {
  get: (t, k) => (k === 'length' ? 0 : k === Symbol.toPrimitive ? () => '' : el),
  set: () => true,
  apply: () => el,
});
globalThis.document = new Proxy({}, { get: () => el, set: () => true });
let clock = 0;
globalThis.performance = { now: () => clock };
// Every timer is driven by hand below; a real one would see dt = 0 forever.
globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};

const assert = (await import('node:assert/strict')).default;
const { state } = await import('../src/renderer/state.js');
const { TIME_UNITS_PER_BEAT: U } = await import('../src/renderer/config.js');
const {
  addNote, startHoldPromotion, beginMetronomeEntry, endMetronomeEntry,
  closeMetronomeSilence, onMetronomeTick, stopMetronomeEntry, tickScoreClock,
} = await import('../src/renderer/score.js');
const { scoreRows, rowSVG } = await import('../src/renderer/notation.js');
const { buildPlaySeq } = await import('../src/renderer/playback.js');

let checks = 0;
const is = (a, b, m) => { checks++; assert.deepEqual(a, b, m); };

const unitsOf = n => Math.round(n.dur * U);
const total = () => state.notes.reduce((u, n) => u + unitsOf(n), 0);
const notes = () => {
  const out = []; let u = 0;
  for (const n of state.notes) {
    if (n.type === 'note') out.push({ at: u, units: unitsOf(n), sym: n.sym, dot: !!n.dot });
    u += unitsOf(n);
  }
  return out;
};
const restsOk = () => state.notes.every(n => n.type !== 'rest' || unitsOf(n) >= 1);

// A simulated session. Events are run in time order: clicks every beat, the
// danta clock every danta, and the player's presses/releases wherever they
// fall. `phrase` is [[startBeat, holdBeats], ...] in beats from the take's
// first click; `jitter(k)` gives ms of human error for event k.
let quantize = 1;
function take(bpm, phrase, jitter = () => 0, svi = 0, countIn = 4) {
  stopMetronomeEntry();
  state.metroOn = true;
  state.fill = 'metro';
  state.holdWrites = 'time';
  state.sym = 'bindu';
  state.quantize = quantize;
  state.bpm = bpm;
  state.notes = [];
  state.hist = [];
  const beat = 60000 / bpm;
  const t0 = 10000;
  const ev = [];
  const lastBeat = Math.ceil(Math.max(...phrase.map(([s, h]) => s + h))) + 2;
  // The metronome is already counting when the player comes in.
  for (let b = -countIn; b <= lastBeat; b++) ev.push({ t: t0 + b * beat, kind: 'click', o: 0 });
  for (let d = 1; d <= lastBeat * U; d++) ev.push({ t: t0 + d * beat / U, kind: 'tick', o: 1 });
  phrase.forEach(([s, h], k) => {
    const on = t0 + s * beat + jitter(2 * k);
    const off = t0 + (s + h) * beat + jitter(2 * k + 1);
    ev.push({ t: on, kind: 'down', k, o: 2 }, { t: off, kind: 'up', k, o: 3 });
  });
  ev.sort((a, b) => a.t - b.t || a.o - b.o);
  const release = {};
  let lastT = t0;
  for (const e of ev) {
    clock = e.t;
    if (e.kind === 'click') onMetronomeTick(e.t);
    else if (e.kind === 'tick') { tickScoreClock(e.t - lastT); lastT = e.t; }
    else if (e.kind === 'down') {
      closeMetronomeSilence();
      const i = addNote(svi, { playSound: false });
      beginMetronomeEntry();
      release[e.k] = startHoldPromotion(i, state.sym);
    } else {
      release[e.k]();
      endMetronomeEntry();
    }
  }
  return { beat, endUnits: lastBeat * U };
}

const want = phrase => phrase.map(([s, h]) => ({ at: Math.round(s * U), units: Math.round(h * U) }));
const strip = ns => ns.map(({ at, units }) => ({ at, units }));

// ---------- the two holds asked about, alone ----------

for (const bpm of [60, 72, 90, 120, 160]) {
  take(bpm, [[0, 1]]);
  const [n] = notes();
  is([n.sym, n.dot, n.units], ['bindu', false, 8], `${bpm}bpm: one beat held is one bindu`);

  take(bpm, [[0, 2.5]]);
  const [m] = notes();
  is(m.units, 20, `${bpm}bpm: 2.5 beats held is 20 dantas`);
  is(m.sym, 'guru', `${bpm}bpm: 2.5 beats is headed by a guru (guru + vasu)`);
  is(m.dot, false, `${bpm}bpm: 2.5 beats is not a guru chukki (that is 3)`);
}

// ---------- a phrase: 1, rest, 2.5, rest, 1, 2.5 back to back ----------
//
// beats: |1  |r  |2.5        |r½|1  |2.5       |
const PHRASE = [[0, 1], [2, 2.5], [5, 1], [6, 2.5]];

for (const bpm of [60, 72, 90, 120, 160]) {
  const { endUnits } = take(bpm, PHRASE);
  is(strip(notes()), want(PHRASE), `${bpm}bpm: exact phrase lands on its beats`);
  assert.ok(restsOk(), 'no zero-length rest'); checks++;
  // The trailing silence is written on the clicks after the last key up.
  assert.ok(total() <= endUnits && total() >= endUnits - U,
    `${bpm}bpm: score ends within a beat of the clock (${total()} vs ${endUnits})`); checks++;
}

// ---------- the same phrase played by a human ----------
//
// Presses up to ±30 ms off the click, releases up to ±30 ms. At 120bpm a danta
// is 62.5 ms, so ±30 ms must round to the intended danta every time.
const rnd = (seed => () => (seed = (seed * 16807) % 2147483647) / 2147483647)(42);
for (const bpm of [60, 72, 90, 120]) {
  for (let trial = 0; trial < 25; trial++) {
    const j = Array.from({ length: PHRASE.length * 2 }, () => (rnd() * 2 - 1) * 30);
    take(bpm, PHRASE, k => j[k]);
    is(strip(notes()), want(PHRASE),
      `${bpm}bpm trial ${trial}: ±30ms human timing still writes the phrase (jitter ${j.map(Math.round)})`);
  }
}

// ---------- a lazy release: let go just before the next click ----------
// A player holding "one beat" commonly lifts a little early. 1/3 of a danta
// early must still be the full beat; half a danta early is a judgement call
// (rounds), so only the clear case is pinned.
for (const bpm of [72, 120]) {
  const danta = 60000 / bpm / U;
  take(bpm, [[0, 1], [2, 2.5]], k => (k % 2 ? -danta / 3 : 0));
  is(strip(notes()), want([[0, 1], [2, 2.5]]), `${bpm}bpm: early release by a third of a danta`);
}

// ---------- legato: 2.5 then the next key before the first is up ----------
{
  take(90, [[0, 2.5], [2.5, 1]], k => (k === 1 ? 80 : 0)); // first key lifted 80ms late
  is(strip(notes()), want([[0, 2.5], [2.5, 1]]), 'legato overlap: held note ends at the next onset');
}

// ---------- starting off the beat: the 2.5 starts on the half beat ----------
{
  take(72, [[0, 1], [1.5, 2.5]]);
  is(strip(notes()), want([[0, 1], [1.5, 2.5]]), 'a 2.5 started on the "and" keeps its place');
  const restUnits = state.notes.filter(n => n.type === 'rest').slice(0, 1).map(unitsOf);
  is(restUnits, [4], 'the half-beat gap before it is one vasu rest');
}

// ---------- what the 2.5 LOOKS like and SOUNDS like ----------
//
// In the phrase, each 2½ starts on beat 3 of a four-beat division and runs over
// the division line, so each is drawn as two glyphs with a join, and plays as
// ONE note of exactly 20 dantas from where it was played.
{
  take(72, PHRASE);
  const rows = scoreRows(state.notes, state.bars);
  const arcs = rows.reduce((n, r) => n + rowSVG(r, null, null, true).split(' Q ').length - 1, 0);
  is(arcs, 2, 'each 2.5 carried over a division line draws one join (two in the phrase)');

  const seq = buildPlaySeq();
  const longs = state.notes.map((n, i) => [n, i]).filter(([n]) => n.type === 'note' && unitsOf(n) === 20);
  is(longs.length, 2, 'the phrase has two 2.5-beat notes');
  for (const [, i] of longs) {
    const parts = seq.filter(it => it.i === i);
    const sounded = parts.reduce((u, it) => u + unitsOf(it.n), 0);
    is(sounded, 20, `note ${i} sounds for 20 dantas in playback`);
    is(parts[0].at, notes().find(n => n.units === 20 && n.at === parts[0].at)?.at,
      `note ${i} sounds from where it was written`);
    for (let k = 1; k < parts.length; k++) {
      is(parts[k].at, parts[k - 1].at + unitsOf(parts[k - 1].n), `note ${i}'s parts are contiguous`);
    }
  }
}

// ---------- no count-in: the first key comes before ANY click ----------
//
// The metronome has just been switched on and the player comes in ahead of
// its first click. The take is timed from the key until that click arrives,
// then lined up with it, so a later note played a little late still lands on
// its beat.
for (const early of [5, 20, 40, 80, 150]) {
  take(72, PHRASE, k => (k === 0 ? -early : k === 6 ? 28 : 0), 0, 0);
  is(strip(notes()).slice(1), want(PHRASE).slice(1),
    `no count-in, first key ${early}ms early: the rest of the take is on the clicks`);
  is(notes()[0].at, 0, `no count-in, first key ${early}ms early: the first note is on the downbeat`);
}

// ---------- record quantize (Logic's input quantize) ----------
//
// Off (a danta), a fast player loses notes to rounding: past half a danta of
// error the note moves. A coarser grid takes that error away, as long as the
// music is on that grid.
{
  const r = (seed => () => (seed = (seed * 16807) % 2147483647) / 2147483647)(7);
  const trials = (bpm, ms, phrase) => {
    let bad = 0;
    for (let i = 0; i < 60; i++) {
      const j = Array.from({ length: phrase.length * 2 }, () => (r() * 2 - 1) * ms);
      take(bpm, phrase, k => j[k]);
      if (JSON.stringify(strip(notes())) !== JSON.stringify(want(phrase))) bad++;
    }
    return bad;
  };

  quantize = 1;
  assert.ok(trials(120, 45, PHRASE) > 20, 'off: ±45ms at 120bpm does mangle the phrase'); checks++;
  quantize = 4;   // vasu: the phrase is all on half beats
  is(trials(120, 45, PHRASE), 0, 'vasu quantize: ±45ms at 120bpm writes the phrase exactly');
  is(trials(160, 80, PHRASE), 0, 'vasu quantize: ±80ms at 160bpm writes the phrase exactly');
  quantize = 2;   // praya
  is(trials(160, 40, PHRASE), 0, 'praya quantize: ±40ms at 160bpm writes the phrase exactly');
  quantize = 8;   // bindu: whole beats only
  const BEATS = [[0, 1], [2, 2], [5, 1], [6, 3]];
  is(trials(160, 150, BEATS), 0, 'bindu quantize: ±150ms at 160bpm writes whole beats exactly');
  // A 2.5 cannot be written on a bindu grid; it becomes a whole number of
  // beats, and so does every rest beside it.
  take(72, PHRASE);
  assert.ok(state.notes.every(n => unitsOf(n) % 8 === 0), 'bindu quantize: every note and rest is whole beats'); checks++;
  // A stab shorter than the grid is still a note of one quantum, not nothing.
  take(120, [[0, 0.05]]);
  is(notes()[0].units, 8, 'bindu quantize: a stab is one bindu');
  quantize = 4;
  take(120, [[0, 0.05]]);
  is(notes()[0].units, 4, 'vasu quantize: a stab is one vasu');
  quantize = 1;
}

// ---------- region quantize: re-snap a take afterwards, and undo it ----------
//
// Played off at danta resolution with ±45 ms at 120 bpm the phrase comes out
// mangled; picking vasu AFTERWARDS must write it exactly (the same answer as
// recording at vasu), and picking off again must give back the take as played.
{
  const { requantizeTakes } = await import('../src/renderer/score.js');
  const r = (seed => () => (seed = (seed * 16807) % 2147483647) / 2147483647)(7);
  let fixedOne = 0;
  for (let i = 0; i < 40; i++) {
    const j = Array.from({ length: PHRASE.length * 2 }, () => (r() * 2 - 1) * 45);
    quantize = 1;
    take(120, PHRASE, k => j[k]);
    const played = JSON.stringify(state.notes.map(({ take: _t, ...n }) => n));
    if (JSON.stringify(strip(notes())) !== JSON.stringify(want(PHRASE))) fixedOne++;
    state.quantize = 4;
    requantizeTakes();
    is(strip(notes()), want(PHRASE), `requantize to vasu, trial ${i}: phrase exact`);
    assert.ok(restsOk(), 'no zero-length rest after requantize'); checks++;
    state.quantize = 1;
    requantizeTakes();
    is(JSON.stringify(state.notes.map(({ take: _t, ...n }) => n)), played,
      `requantize back to off, trial ${i}: the take as played`);
  }
  assert.ok(fixedOne > 10, 'the raw takes really were off the grid'); checks++;

  // An edit AHEAD of the take shifts it; requantizing carries the shift along.
  quantize = 1;
  take(120, PHRASE, k => (k % 2 ? 20 : -20));
  state.notes.unshift({ type: 'rest', sym: 'rest_symbol_1', dur: 1 });
  state.quantize = 4;
  requantizeTakes();
  is(strip(notes()), want(PHRASE).map(n => ({ ...n, at: n.at + U })), 'requantize after an edit ahead of the take');
  is(requantizeTakes(), false, 'requantizing at the same grid changes nothing');
  quantize = 1;
}

stopMetronomeEntry();
console.log(`composer-take: ${checks} checks passed`);
