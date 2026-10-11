// Does the metronome actually play WITH the music?
//
// It did not. Two faults, and the first made the second unfixable:
//
//   * metronome.js built its OWN AudioContext. Two contexts have unrelated
//     `currentTime` origins and independently drifting sample clocks, so a
//     click scheduled on one can never be made to land with a note scheduled
//     on the other, however carefully either is timed.
//   * nothing connected the transport to the metronome at all — playback.js
//     held no reference to it, so pressing Play never clicked, and a metronome
//     switched on by hand counted from whenever its button was pressed rather
//     than from the start of the score.
//
// So this drives the REAL startPlay() against a recording AudioContext stub —
// the approach tests/pdf.test.mjs takes with jsPDF — and reads back every time
// the audio graph was told to make a sound. The notes are silent under test
// (no samples to play), so the voices that do get built are the clicks, and
// their start times ARE the click grid.

import assert from 'node:assert/strict';

let checks = 0;
const is = (a, b, m) => { checks++; assert.equal(a, b, m); };
const near = (a, b, m, eps = 1e-6) => {
  checks++;
  assert.ok(Math.abs(a - b) <= eps, `${m} — ${a} vs ${b}`);
};

// ---------- a recording AudioContext ----------

let contextsBuilt = 0;
let ctx = null;              // the one context everything must be built on
let started = [];            // audio-clock time of every voice that sounded

class FakeParam {
  setValueAtTime(v) { this.v = v; return this; }
  linearRampToValueAtTime() { return this; }
  exponentialRampToValueAtTime() { return this; }
  cancelScheduledValues() { return this; }
}
class FakeNode {
  constructor(owner) {
    this.owner = owner;
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
    assert.ok(Number.isFinite(t), 'a voice was scheduled at a non-finite time');
    assert.ok(t >= 0, `a voice was scheduled at ${t}, before the clock started`);
    started.push({ at: t, ctx: this.owner, freq: this.frequency.v });
  }
  stop() {}
}
class FakeCtx {
  constructor() {
    contextsBuilt += 1;
    ctx = this;
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.state = 'running';
    this.destination = new FakeNode(this);
  }
  resume() {}
  createGain() { return new FakeNode(this); }
  createOscillator() { return new FakeNode(this); }
  createBiquadFilter() { return new FakeNode(this); }
  createBufferSource() { return new FakeNode(this); }
  createDynamicsCompressor() { return new FakeNode(this); }
  createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; }
}

// ---------- environment ----------

const el = new Proxy(function () {}, {
  get: (t, k) => (k === 'length' ? 0 : k === Symbol.toPrimitive ? () => '' : el),
  set: () => true, apply: () => el,
});
// Everything on `document` is the catch-all element EXCEPT the listener pair:
// the standalone metronome restarts its count on 'tala:changed', and a stub
// that swallows the registration would let that regression pass unnoticed.
const listeners = new Map();
const docStub = {
  addEventListener: (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  },
  removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
};
const fire = type => listeners.get(type)?.forEach(fn => fn());
globalThis.document = new Proxy(docStub, {
  get: (t, k) => (k in t ? t[k] : el), set: () => true,
});
globalThis.Event = class { constructor(type) { this.type = type; } };

// The pump is captured rather than left to fire, so a whole performance can be
// stepped through instantly. The point is to inspect a schedule, not to wait
// for one.
let pump = null;
globalThis.setInterval = fn => { pump = fn; return 1; };
globalThis.clearInterval = () => { pump = null; };
globalThis.setTimeout = () => 0;

Object.defineProperty(globalThis, 'window', {
  value: { AudioContext: FakeCtx }, configurable: true,
});
globalThis.fetch = () => Promise.reject(new Error('no samples under test'));

const hushed = ['error', 'info', 'warn'].map(k => { const f = console[k]; console[k] = () => {}; return [k, f]; });
const { state } = await import('../src/renderer/state.js');
const { startPlay, stopPlay } = await import('../src/renderer/playback.js');
const {
  beatsPerCycle, startMetronome, stopMetronome, renderClicks,
} = await import('../src/renderer/metronome.js');
const { TALAS } = await import('../src/renderer/config.js');
hushed.forEach(([k, f]) => { console[k] = f; });

const LEAD_IN = 0.08;

// ---------- drive one whole playback, and read back the click grid ----------

function play({ bpm = 72, tala = 'chatusra', beats = 16, metroOn = true } = {}) {
  state.bpm = bpm;
  state.tala = tala;
  state.metroOn = metroOn;
  state.metroSound = 1;              // 'click': a noise hit plus a pitched tone
  state.notes = Array.from({ length: beats }, () => ({
    type: 'note', svaraIndex: 0, oct: 0, head: 'o', sym: 'bindu', dur: 1,
  }));
  state.bars = [];
  state.breaks = [];
  state.hist = [];
  state.future = [];
  state.playing = false;

  started = [];
  // Rewind the fake clock BEFORE the transport reads it — startPlay() anchors
  // on audioNow(), so a clock left where the last run finished would put this
  // run's origin there too.
  if (ctx) ctx.currentTime = 0;
  startPlay();
  const clock = ctx;
  // Bounded independently of the bpm under test — a bad tempo must be
  // observed as a bad schedule, not as a test that never returns.
  const span = Math.min(600, beats * (Number(bpm) > 0 ? 60 / Number(bpm) : 60 / 72) + 1);
  for (let t = 0; pump && t <= span; t += 0.025) {
    clock.currentTime = t;
    pump();
  }
  stopPlay();

  // One click builds two voices at the same instant — a noise hit and a
  // pitched tone — so equal times collapse to one beat. The accent lifts the
  // tone by ACCENT_PITCH, which is how an accented beat is told from a plain
  // one here.
  const PLAIN = 1250;                // 'click' preset's tone, unaccented
  const times = [];
  const accents = [];
  for (const v of started.slice().sort((a, b) => a.at - b.at)) {
    assert.equal(v.ctx, clock, 'a voice was built on a different AudioContext');
    if (!times.length || Math.abs(times[times.length - 1] - v.at) > 1e-6) {
      times.push(v.at);
      accents.push(false);
    }
    if (v.freq > PLAIN + 1) accents[accents.length - 1] = true;
  }
  return Object.assign(times, { accents });
}

// ---------- ONE clock ----------
//
// The fault that made every other timing fix impossible. If this ever goes
// back to 2, nothing below can be made true again.

play({ beats: 4 });
is(contextsBuilt, 1,
  `the metronome and the music must share ONE AudioContext — ${contextsBuilt} were built`);

// ---------- the click is ON the beat, at the score's own origin ----------
//
// Playback puts its first note at audioNow() + LEAD_IN and advances by
// `dur * 60/bpm`. The clicks must come off that same accumulation, so beat k
// falls at exactly LEAD_IN + k * 60/bpm — the note's onset, not near it.

for (const bpm of [40, 60, 72, 96, 120, 168, 208]) {
  const clicks = play({ bpm, beats: 8 });
  assert.ok(clicks.length >= 8, `bpm ${bpm}: only ${clicks.length} clicks for 8 beats`);
  checks++;
  near(clicks[0], LEAD_IN, `bpm ${bpm}: the first click is not on the first note`);
  for (let k = 0; k < 8; k++) {
    near(clicks[k], LEAD_IN + k * (60 / bpm), `bpm ${bpm}: click ${k} is off the beat`);
  }
  // ...and the interval between clicks IS the tempo.
  for (let k = 1; k < 8; k++) {
    near(clicks[k] - clicks[k - 1], 60 / bpm, `bpm ${bpm}: beat ${k} is the wrong length`);
  }
}

// ---------- the count stops with the music ----------

const eight = play({ bpm: 120, beats: 8 });
is(eight.length, 8, 'the metronome ticked on past the end of the score');

// ---------- switched off, nothing sounds ----------

is(play({ beats: 8, metroOn: false }).length, 0,
  'the metronome clicked while it was switched off');

// ---------- the METRE decides the accent ----------
//
// Read off the real schedule, not off a helper: for every builtin tala, the
// accented beats must be exactly the group starts its formula declares,
// repeating every cycle. A plain 4 and an additive 4+3 must not accent alike —
// that is the whole thing the formula exists to say.

for (const [key, tala] of Object.entries(TALAS)) {
  is(tala.groups.reduce((a, b) => a + b, 0), tala.beats,
    `${key}: the formula ${tala.groups.join('+')} does not add to its ${tala.beats} beats`);

  // The beat offsets a cycle of this metre accents: 0, then each group start.
  const starts = [];
  let at = 0;
  for (const g of tala.groups) { starts.push(at); at += g; }

  const cycles = 3;
  const clicks = play({ tala: key, bpm: 120, beats: tala.beats * cycles });
  is(clicks.length, tala.beats * cycles, `${key}: wrong number of clicks`);
  is(beatsPerCycle(), tala.beats, `${key}: the cycle is not ${tala.beats} beats`);

  const got = clicks.accents.map((a, i) => (a ? i : -1)).filter(i => i >= 0);
  const want = [];
  for (let c = 0; c < cycles; c++) for (const b of starts) want.push(c * tala.beats + b);
  assert.deepEqual(got, want,
    `${key} (${tala.formula}): accents on beats ${got.join(',')}, expected ${want.join(',')}`);
  checks++;
}

// The two that must NOT sound alike: a plain four and MISRA CHAPU's 4+3.
// They agree for the first SEVEN beats — both accent 1 and 5 — and only part
// company at the eighth, where the four comes round again and the seven has
// already turned over. Comparing a short window here would prove nothing.
const four = play({ tala: 'chatusra', bpm: 120, beats: 12 });
const misra = play({ tala: 'misra', bpm: 120, beats: 14 });
assert.deepEqual(four.accents.slice(0, 7), misra.accents.slice(0, 7),
  'the first seven beats of a 4 and a 4+3 do coincide');
assert.notDeepEqual(four.accents.slice(0, 12), misra.accents.slice(0, 12),
  'an additive metre accented exactly like a plain one');
checks += 2;
// MISRA CHAPU is seven with an edge at the fifth beat.
assert.deepEqual(misra.accents.slice(0, 7),
  [true, false, false, false, true, false, false],
  'MISRA CHAPU must accent beats 1 and 5');
checks++;

// ---------- a broken tempo cannot stop the count ----------
//
// A cleared tempo field used to make every `when` NaN, which fails the
// while-loop test and stops the metronome dead with no way back.

for (const bad of [0, null, undefined, NaN, '']) {
  state.bpm = bad;
  const clicks = play({ bpm: bad, beats: 4 });
  assert.ok(clicks.length > 0 && clicks.every(Number.isFinite),
    `bpm ${String(bad)} produced no usable click grid`);
  checks++;
}

// ---------- the metronome ON ITS OWN counts the metre ----------
//
// Everything above drives the TRANSPORT, where playback.js owns the grid. The
// button on the toolbar is the other caller, and it runs its own loop — so the
// two could count differently without a single test above noticing. What the
// user sets as the time signature is what it must tick: 4+2 is six clicks a
// cycle with the loud one on 1 and 5, not four clicks and not a plain six.

function solo({ tala = 'chatusra', bpm = 120, seconds = 6, changeTo = null } = {}) {
  state.bpm = bpm;
  state.tala = tala;
  state.playing = false;
  state.metroOn = false;
  state.metroSound = 1;

  started = [];
  if (ctx) ctx.currentTime = 0;
  startMetronome();
  const clock = ctx;
  for (let t = 0; pump && t <= seconds; t += 0.025) {
    clock.currentTime = t;
    // Switch the metre half way, to see the count restart rather than carry
    // its old phase across the change.
    if (changeTo && Math.abs(t - seconds / 2) < 1e-9) {
      state.tala = changeTo;
      fire('tala:changed');
    }
    pump();
  }
  stopMetronome();

  const PLAIN = 1250;
  const times = [];
  const accents = [];
  for (const v of started.slice().sort((a, b) => a.at - b.at)) {
    if (!times.length || Math.abs(times[times.length - 1] - v.at) > 1e-6) {
      times.push(v.at);
      accents.push(false);
    }
    if (v.freq > PLAIN + 1) accents[accents.length - 1] = true;
  }
  return Object.assign(times, { accents, pattern: accents.map(a => (a ? 'X' : '.')).join('') });
}

// The first n clicks of a run, as times and accents together — a bare slice
// would drop the accents riding on the array.
function take(run, n) {
  const accents = run.accents.slice(0, n);
  return { times: run.slice(0, n), accents, pattern: accents.map(a => (a ? 'X' : '.')).join('') };
}

// Two cycles of each builtin, read off the real schedule.
for (const [key, tala] of Object.entries(TALAS)) {
  const cycles = 2;
  const beat = 60 / 120;
  const n = tala.beats * cycles;
  // The pump lays clicks down SCHEDULE_AHEAD in advance, so a run timed to the
  // last beat always carries one or two past it. Run well beyond the window
  // and read the first n — the grid is what is under test, not where the
  // scheduler happened to be cut off.
  const run = take(solo({ tala: key, seconds: LEAD_IN + n * beat + 1 }), n);

  is(run.times.length, n,
    `${key}: the button ticked ${run.times.length} times in ${cycles} cycles of ${tala.beats}`);

  const starts = [];
  let at = 0;
  for (const g of tala.groups) { starts.push(at); at += g; }
  const want = [];
  for (let c = 0; c < cycles; c++) for (const b of starts) want.push(c * tala.beats + b);
  assert.deepEqual(run.accents.map((a, i) => (a ? i : -1)).filter(i => i >= 0), want,
    `${key} (${tala.formula}): the standalone metronome accents the wrong beats`);
  checks++;

  for (let k = 1; k < n; k++) {
    near(run.times[k] - run.times[k - 1], beat, `${key}: beat ${k} is the wrong length`);
  }
}

// RUPAKA is the case the report was about: 4+2 must be SIX clicks grouped
// four-then-two, which is a different sound from a plain four and from a
// plain six.
is(take(solo({ tala: 'rupaka', seconds: 8 }), 12).pattern,
  'X...X.X...X.', '4+2 is not being heard as four beats then two');
is(take(solo({ tala: 'chatusra', seconds: 8 }), 12).pattern,
  'X...X...X...', 'a plain four is not four');

// ---------- a new time signature starts a new count ----------
//
// The beat number used to carry on across the change, so the modulo landed
// wherever it happened to and the next accent fell inside a group. What is
// being counted changed, so the count restarts — the same thing a player does.
const swapped = solo({ tala: 'chatusra', changeTo: 'rupaka', seconds: 6 });
const half = swapped.findIndex(t => t >= 3);
assert.ok(half > 0, 'the metre change produced no clicks after it');
assert.ok(swapped.accents[half],
  `switching to 4+2 mid-count did not restart the cycle — pattern ${swapped.pattern}`);
checks += 2;

// ---------- 6/4 typed into the dialog is six clicks ----------
//
// The formula field takes a printed time signature as well as the additive
// form, and the metronome has to tick what was typed.
{
  const { addTala, resetTalas } = await import('../src/renderer/timesig.js');
  resetTalas();
  const key = addTala({ label: 'Six four', formula: '6/4' });
  is(take(solo({ tala: key, seconds: 8 }), 12).pattern,
    'X.....X.....', '6/4 is not ticking six beats to the cycle');
  resetTalas();
}

// ---------- the MP3 gets the same count ----------
//
// renderClicks() builds the editor's own voices on the context it is HANDED,
// on the transport's grid: beat k at k beats, nothing past the music, and
// nothing leaking onto the live context.
{
  state.tala = 'rupaka';
  state.metroSound = 1;
  const live = ctx;
  const file = new FakeCtx();
  ctx = live;
  started = [];
  renderClicks(file, 0.5, 6);
  const at = [...new Set(started.map(v => v.at))].sort((a, b) => a - b);
  assert.deepEqual(at, Array.from({ length: 12 }, (_, k) => k * 0.5),
    'the exported count is not on the beat grid');
  assert.ok(started.every(v => v.ctx === file), 'an exported click was built on the live context');
  const loud = [...new Set(started.filter(v => v.freq > 1251).map(v => v.at / 0.5))];
  assert.deepEqual(loud.sort((a, b) => a - b), [0, 4, 6, 10], 'the exported count accents the wrong beats');
  started = [];
  startMetronome();
  stopMetronome();
  assert.ok(started.length && started.every(v => v.ctx === live),
    'the metronome did not go back to the live context after a render');
  checks += 4;
}

console.log(`metronome: ${checks} checks passed`);
