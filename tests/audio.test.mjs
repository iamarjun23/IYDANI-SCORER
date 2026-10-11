// npm run test:audio
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  onsetOffset, buildSustainLoop, freqOfMidi, sustainLevelAt, sustainTone, sustainDecayT,
  shapeNote,
} from '../src/renderer/audio.js';
import {
  SAMPLE_DETUNE, SAMPLE_DETUNE_CENTS, SAMPLE_LOOP_AT, SAMPLE_LOOP_MIN,
  SUSTAIN_FLOOR, SUSTAIN_TONE_TO_HZ, SUSTAIN_DECAY_T, SUSTAIN_DECAY_MIN_T,
  HELD_FADE_AT, HELD_FADE_T,
} from '../src/renderer/config.js';

// ---------- onset detection ----------

const RATE = 48000;
const tone = (leadSeconds, seconds = 1) => {
  const data = new Float32Array(Math.round(RATE * (leadSeconds + seconds)));
  const lead = Math.round(RATE * leadSeconds);
  for (let i = lead; i < data.length; i++) data[i] = Math.sin(i / 20) * 0.7;
  return data;
};

// The guard keeps a couple of milliseconds in front of the attack.
assert.ok(Math.abs(onsetOffset(tone(0.031), RATE) - 0.029) < 0.001);
assert.equal(onsetOffset(new Float32Array(1000), RATE), 0, 'silence has no onset to find');
assert.equal(onsetOffset(Float32Array.from({ length: 1000 }, () => 0.5), RATE), 0,
  'a sample that starts on the attack is not trimmed');

// The floor is relative to the sample's own peak, so a quiet recording is
// trimmed the same as a loud one.
const quiet = tone(0.031);
for (let i = 0; i < quiet.length; i++) quiet[i] *= 0.05;
assert.ok(Math.abs(onsetOffset(quiet, RATE) - onsetOffset(tone(0.031), RATE)) < 0.001);

// ---------- the shipped recordings ----------

// Every sample really does open with silence — this is what the offset exists
// for. If a re-recorded set ever removes it, the offsets simply come back 0.
const dir = path.join(import.meta.dirname, '..', 'src', 'renderer', 'samples');
const wavs = fs.readdirSync(dir).filter(f => f.endsWith('.wav'));
assert.ok(wavs.length >= 24, 'the sample set is present');

const pcm = (file) => {
  const b = fs.readFileSync(path.join(dir, file));
  let pos = 12, rate = 0, dataAt = 0, dataLen = 0;
  while (pos + 8 <= b.length) {
    const id = b.toString('ascii', pos, pos + 4);
    const len = b.readUInt32LE(pos + 4);
    if (id === 'fmt ') rate = b.readUInt32LE(pos + 12);
    if (id === 'data') { dataAt = pos + 8; dataLen = len; }
    pos += 8 + len + (len % 2);
  }
  const n = Math.floor(dataLen / 2);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = b.readInt16LE(dataAt + i * 2) / 32768;
  return { x, rate };
};

for (const file of wavs) {
  const { x, rate } = pcm(file);
  let peak = 0;
  for (const v of x) if (Math.abs(v) > peak) peak = Math.abs(v);
  assert.ok(peak <= 1, `${file} is not clipped`);
  const offset = onsetOffset(x, rate);
  assert.ok(offset >= 0 && offset < 0.25, `${file} onset ${offset.toFixed(3)}s is plausible`);
}

// ---------- concert pitch ----------
//
// The set is ~6 cents SHARP of A=440 — even across all 24, so it is in tune
// with itself and was inaudible until the app started being played along with
// a real keyboard. SAMPLE_DETUNE corrects it on playbackRate. This measures
// the shipped files and checks the correction actually lands them on concert
// pitch, so a re-recorded set at A=440 fails HERE — as "the constant is now
// wrong" — instead of quietly playing 6 cents flat.

// Fundamental by normalised autocorrelation, over a window past the attack.
// `expected` bounds the lag search (see below) but sets nothing inside it.
const fundamental = (x, rate, expected) => {
  let peak = 0;
  for (const v of x) if (Math.abs(v) > peak) peak = Math.abs(v);
  let i = 0;
  while (i < x.length && Math.abs(x[i]) < peak * 0.02) i++;
  const from = Math.min(i + Math.round(rate * 0.08), x.length - 1);
  const w = x.subarray(from, from + Math.min(Math.round(rate * 0.3), x.length - from));
  const corr = (lag) => {
    let num = 0, a = 0, b = 0;
    for (let k = 0; k + lag < w.length; k++) { num += w[k] * w[k + lag]; a += w[k] * w[k]; b += w[k + lag] * w[k + lag]; }
    return num / Math.sqrt(a * b || 1);
  };
  // Half an octave either side. Autocorrelation latches onto twice the true
  // period as readily as the period itself — a wider search reported n74 a
  // clean octave flat — and the sub-octave lags cannot be told apart by
  // correlation strength alone (preferring the shortest lag above a threshold
  // just made the whole set read 10-80 cents flat instead). Bounding the
  // search at half an octave puts them out of reach. It does mean this cannot
  // catch a file that is genuinely the wrong note; it is a tuning check.
  const lo = Math.floor(rate / (expected * 1.5));
  const hi = Math.ceil(rate / (expected / 1.5));
  let best = lo, bestV = -Infinity;
  for (let lag = lo; lag <= hi; lag++) {
    const v = corr(lag);
    if (v > bestV) { bestV = v; best = lag; }
  }
  // Parabolic refinement — a whole-sample lag is only ~4 cents accurate up at
  // B5, which is the same size as the error being measured.
  const a = corr(best - 1), c = corr(best + 1);
  const denom = a - 2 * bestV + c;
  return rate / (best + (denom ? (a - c) / (2 * denom) : 0));
};

const cents = [];
for (const file of wavs) {
  const midi = Number(file.slice(1, -4));
  const { x, rate } = pcm(file);
  const target = 440 * Math.pow(2, (midi - 69) / 12);
  const heard = fundamental(x, rate, target) * SAMPLE_DETUNE;
  const off = 1200 * Math.log2(heard / target);
  assert.ok(Math.abs(off) < 8,
    `${file} plays ${off.toFixed(1)} cents off concert pitch`
    + ' — the set was re-recorded and SAMPLE_DETUNE no longer describes it');
  cents.push(off);
}

// The set is uniform, so correcting it by its mean should centre it. A drift
// here means the recordings are no longer the ones the constant was measured
// from.
const mean = cents.reduce((a, b) => a + b, 0) / cents.length;
assert.ok(Math.abs(mean) < 3,
  `the corrected set averages ${mean.toFixed(1)} cents off — re-measure SAMPLE_DETUNE`
  + ` (currently ${SAMPLE_DETUNE_CENTS})`);

// ---------- the sustain loop ----------
//
// The recordings are single plucked strikes: measured against their own peaks
// the set is 5-19 dB down after half a second and 19-31 dB down after one. At
// 120 bpm half a second is ONE BEAT, so without a loop a bindu, a chukki, a
// guru and a five-beat joined note all made the same sound, and written
// duration could not be heard at all.
//
// Three things have to hold for the loop to be inaudible AS a loop, and each
// one of them failed at some point while it was being built:
//
//   · the wrap lands on matching material (found by CORRELATION — computing the
//     length from the note's nominal pitch put the top octave ANTI-PHASE,
//     because the set is tuned up to 9.5 cents sharp and 120 ms of it is over a
//     hundred periods)
//   · the level does not step at the wrap (the FLATTENING — a raw loop of this
//     material stepped back up by as much as 9.4 dB every pass, a tremolo at
//     the loop rate)
//   · the samples either side of the junction join (the CROSSFADE — the
//     quietest recording still left a step of 1.4x the local RMS after the
//     first two, which is a tick once a pass)

const rmsOf = (x, from, len) => {
  let sum = 0;
  for (let i = from; i < from + len; i++) sum += x[i] * x[i];
  return Math.sqrt(sum / len);
};

{
  // A synthetic exponential decay is the clean case.
  const rate = 48000;
  const freq = 200;
  const n = Math.round(rate * 2.5);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = Math.sin(2 * Math.PI * freq * i / rate) * Math.exp(-1.8 * i / rate);
  }
  const period = rate / freq;
  const loop = buildSustainLoop(x, rate, freq);
  assert.ok(loop, 'a 2.5s tone is long enough to take a loop');
  assert.ok(Math.abs(loop.start - SAMPLE_LOOP_AT) < 1e-9, 'the loop starts where it says it does');
  assert.ok(loop.end - loop.start >= SAMPLE_LOOP_MIN - period / rate,
    'and is the asked-for length, give or take the period it is snapped to');
  assert.ok(loop.match > 0.99, 'a pure tone wraps onto itself exactly');

  const cycles = (loop.end - loop.start) * rate / period;
  assert.ok(Math.abs(cycles - Math.round(cycles)) < 0.02,
    'the region is whole periods of the tone, which is what the search is for');

  const w = Math.round(period);
  const drift = 20 * Math.log10(
    rmsOf(x, Math.round(loop.end * rate) - w, w) / rmsOf(x, Math.round(loop.start * rate), w));
  assert.ok(Math.abs(drift) < 1,
    'the decay across it is flattened, so it does not tremolo: '
    + drift.toFixed(2) + ' dB left of a 9.4 dB worst case');
}

{
  // And on the shipped set. The numbers are the measured worst cases with a
  // little headroom — a re-recorded set that cannot be looped this cleanly
  // fails here rather than clicking once a pass in somebody's ear.
  for (const file of wavs) {
    const midi = Number(file.match(/n(\d+)/)[1]);
    const { x, rate } = pcm(file);
    const loop = buildSustainLoop(x, rate, freqOfMidi(midi));
    assert.ok(loop, file + ' takes a sustain loop');

    const p = Math.round(rate / freqOfMidi(midi));
    const a = Math.round(loop.start * rate);
    const b = Math.round(loop.end * rate);

    assert.ok(loop.match > 0.7,
      file + ' wraps onto matching material (' + loop.match.toFixed(3) + ', worst measured 0.761)');

    const drift = 20 * Math.log10(rmsOf(x, b - p, p) / rmsOf(x, a, p));
    assert.ok(Math.abs(drift) < 1.5,
      file + ' has no level step at the wrap (' + drift.toFixed(2) + ' dB, worst measured 0.75)');

    const step = Math.abs(x[a] - x[b - 1]) / rmsOf(x, a, p);
    assert.ok(step < 0.5,
      file + ' joins at the junction (' + step.toFixed(3) + ' x rms, worst measured 0.226)');
  }
}

// A recording too short to hold a loop gets none rather than a bad one — the
// caller then plays it straight through, as before, and the MP3 render keeps
// capping its release at the end of the material.
assert.equal(buildSustainLoop(new Float32Array(1000), 48000, 200), null,
  'a sample shorter than the loop point takes no loop');
assert.equal(buildSustainLoop(new Float32Array(48000 * 3), 48000, 0), null,
  'and a fundamental of zero is refused rather than divided by');

// ---------- how a held note ages ----------
//
// The loop holds; the instrument does not. These pin the two corrections that
// keep a held key from freezing into a stationary tone — see the sustain block
// in config.js for what that sounded like and why re-cutting the loop is not
// the answer.

// The decay starts at the struck level and falls, monotonically, to SILENCE.
// It must not settle anywhere: a floor is what made a long hold end in an
// endless dark loop — a buzz — because dropping the level and darkening the
// tone strips the richness covering a stationary tone without removing it.
assert.equal(sustainLevelAt(1, 0), 1, 'a note starts at the level it was struck');
let prev = 1;
for (const t of [0.1, 0.5, 1, 2, 3, 6, 12]) {
  const v = sustainLevelAt(1, t);
  assert.ok(v < prev, `a held note is quieter at ${t}s than before it`);
  prev = v;
}
// Gone, not merely quiet: a key held down must stop making a sound the way the
// instrument does, rather than droning at whatever level the decay settled on.
assert.ok(-20 * Math.log10(sustainLevelAt(1, 15)) > 40,
  'a very long hold has faded out, not settled');
assert.equal(SUSTAIN_FLOOR, 0, 'the decay heads for silence and nowhere else');
// Short symbols must be untouched by it: a danta at 120bpm is 0.125s, and a
// run of them is exactly where a duration-dependent envelope would show.
assert.ok(sustainLevelAt(1, 0.125) > 0.93,
  'a danta loses almost nothing to the slow decay');
// Three seconds in it is ~9 dB down, which is the figure the shape was set by.
const drop3 = -20 * Math.log10(sustainLevelAt(1, 3));
assert.ok(drop3 > 7 && drop3 < 11, `a three-second hold is ~9 dB down (${drop3.toFixed(1)})`);
// Level is proportional, so a velocity-scaled voice decays by the same shape.
assert.ok(Math.abs(sustainLevelAt(0.4, 2) - 0.4 * sustainLevelAt(1, 2)) < 1e-12,
  'the decay scales with how hard the key was struck');

// The decay through the loop is scaled to the NOTE. At the fixed three-second
// constant a one-beat note sat flat from the loop point to the end of its beat
// — a ring at the end of every beat. Whatever a note is worth, it is ~9 dB
// down by its written end; a long one decays no slower than the judged shape
// and a short one no faster than the recording does.
for (const span of [0.4, 0.48, 1.3, 2.5]) {
  const drop = -20 * Math.log10(sustainLevelAt(1, span, sustainDecayT(span)));
  assert.ok(drop > 7 && drop < 10, `a ${span}s sustain ends ~9 dB down (${drop.toFixed(1)})`);
}
assert.equal(sustainDecayT(60), SUSTAIN_DECAY_T, 'a long note keeps the judged decay');
assert.equal(sustainDecayT(0.01), SUSTAIN_DECAY_MIN_T, 'a short one is not dropped off a cliff');
assert.equal(sustainDecayT(NaN), SUSTAIN_DECAY_MIN_T, 'a bad length still yields a real constant');

// An UNLOOPED played note takes a held key's fade, and its release starts from
// the level that fade has reached. Pinning the struck level there steps the
// note back up to full as it is let go — a bump on the end of every long note.
{
  const record = () => {
    const calls = [];
    const log = name => (...args) => calls.push([name, ...args]);
    return {
      calls,
      setValueAtTime: log('set'), linearRampToValueAtTime: log('lin'),
      setTargetAtTime: log('target'), exponentialRampToValueAtTime: log('exp'),
    };
  };
  const long = record();
  const done = shapeNote(long, 1, 10, 2);
  const fade = long.calls.find(c => c[0] === 'target');
  assert.deepEqual(fade.slice(1), [0, 10 + HELD_FADE_AT, HELD_FADE_T], 'a long note fades like a held key');
  const pin = long.calls.find(c => c[0] === 'set' && c[2] === 12);
  assert.ok(Math.abs(pin[1] - Math.exp(-(2 - HELD_FADE_AT) / HELD_FADE_T)) < 1e-9,
    'the release starts from the level the fade reached');
  assert.ok(done > 12, 'and rings out after its written end');
  const short = record();
  shapeNote(short, 1, 10, HELD_FADE_AT / 2);
  assert.ok(!short.calls.some(c => c[0] === 'target'), 'a short note is released before any fade is booked');
  assert.equal(short.calls.find(c => c[0] === 'set' && c[2] > 10)[1], 1, 'and from the level it was struck at');
}

// The darkening must never reach down to the note itself. A flat 900 Hz target
// reads correctly under the low and middle octaves, where it was judged by ear,
// and sits BELOW the fundamental of a taara Ni at 988 Hz — which would cut the
// note away rather than darken it. Checked across the whole written compass,
// three sthayis from mandra Sa.
for (let midi = 36; midi <= 96; midi++) {
  const f = freqOfMidi(midi);
  const { from, to } = sustainTone(f);
  assert.ok(to > f * 2, `midi ${midi}: the tone target clears its own fundamental`);
  assert.ok(from > to, `midi ${midi}: the sweep runs downwards`);
  assert.ok(Number.isFinite(from) && Number.isFinite(to), `midi ${midi}: both ends are real`);
}
// Under the octaves it was set by ear against, the target is the flat one.
assert.equal(sustainTone(freqOfMidi(45)).to, SUSTAIN_TONE_TO_HZ,
  'a mandra note darkens to the judged target');
// The decay may never dip under what a release ramps TO: an exponential ramp
// whose start sits below its target ramps UPWARDS, which would swell a note at
// the moment it is let go after a long hold.
assert.ok(sustainLevelAt(1, 600) >= 0.0001, 'the decay stays clear of the release floor');
assert.ok(sustainLevelAt(0.05, 600) >= 0.0001, 'including a quietly struck one');

// A bad frequency must not put NaN into a filter, which silences a voice
// outright instead of failing loudly.
for (const bad of [0, -1, NaN, null, undefined, 'x']) {
  const { from, to } = sustainTone(bad);
  assert.ok(Number.isFinite(from) && Number.isFinite(to), 'a bad pitch still yields a real filter');
}

console.log(`audio tests passed — ${wavs.length} samples within`
  + ` ${Math.max(...cents.map(Math.abs)).toFixed(1)} cents of concert pitch,`
  + ' every one of them looping cleanly');
