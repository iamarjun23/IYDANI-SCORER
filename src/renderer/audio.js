// Web Audio engine. The ONLY sound source is the recorded note set in
// renderer/samples/ — there is no synthesised fallback. A note asked for before
// the samples have finished decoding is held and played the moment they are
// ready, rather than being faked with oscillators, so the very first key press
// of a session sounds like every one after it.
//
// The samples cover two octaves, C3-B3 and C5-B5 (MIDI 48-59 and 72-83). The
// middle octave was never recorded, so any pitch is played by taking the
// NEAREST sample and shifting it with playbackRate. Madhya therefore comes off
// the edges of the two recorded sets and is never shifted more than 6
// semitones — much closer than transposing a whole octave. Recording the middle
// octave and dropping it in as n60..n71.wav is all it would take to remove the
// shifting entirely; nothing else here has to change.

import { state } from './state.js';
import {
  instrumentById, sampleUrl, SAMPLE_GAIN, RELEASE_SHARE, RELEASE_MAX_SECONDS, RING_MIN_SECONDS, AUDIO_LATENCY_HINT, semiOf,
  SAMPLE_LOOP_AT, SAMPLE_LOOP_MIN, SAMPLE_SUSTAIN_MAX, SAMPLE_SUSTAIN_LOOP,
  HELD_FADE_T,
  SUSTAIN_FLOOR, SUSTAIN_DECAY_T, SUSTAIN_DECAY_MIN_T, SUSTAIN_TONE_T,
  SUSTAIN_TONE_FROM_HZ, SUSTAIN_TONE_TO_HZ,
  SUSTAIN_TONE_FROM_RATIO, SUSTAIN_TONE_TO_RATIO,
} from './config.js';

let ctx = null;

function audio() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: AUDIO_LATENCY_HINT });
  }
  // Autoplay policy parks a context created before any gesture; every entry
  // point runs through here so the first real note wakes it.
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// ---------- sample library ----------

const buffers = new Map();      // MIDI note -> AudioBuffer
const onsets = new Map();       // MIDI note -> seconds of silence to skip
const loops = new Map();        // MIDI note -> { start, end } sustain region
// buildSustainLoop() REWRITES the region it finds — it flattens the decay
// across it and crossfades the wrap — so the buffer it is given can no longer
// be played straight through: past loopEnd the material is a step down from
// the flattened region, a drop no envelope asked for. It therefore works on a
// COPY. `buffers` stays the recording exactly as it was made, which is what a
// held live key plays: its own decay IS the fade a piano key has when the key
// is kept down, and no loop can imitate that without freezing the tone.
const loopBuffers = new Map();  // MIDI note -> the same recording, loop-prepared
let inst = null;                // the instrument loaded or loading — config.js
let ready = null;               // resolves once `inst` has been fetched and decoded

// Which instrument the notes are played on. Before setInstrument() has run —
// and under the node tests, which never run it — that is the saved setting.
export function currentInstrument() {
  return inst || instrumentById(state.instrument);
}

// Swap the recordings every voice is built from. Called once at start-up with
// the saved choice and again whenever it is changed. Voices already sounding
// keep the buffers they were started on; everything after takes the new set.
// A load that finishes after another instrument has been chosen is thrown
// away rather than mixed into it.
export function setInstrument(id) {
  const next = instrumentById(id);
  if (next === inst && ready) return ready;
  inst = next;
  buffers.clear(); onsets.clear(); loops.clear(); loopBuffers.clear();
  if (bus) bus.tone.frequency.value = toneFor(next, bus.context);
  ready = loadInstrument(next);
  return ready;
}

async function loadInstrument(next) {
  // The `dng:` scheme only exists inside the app. Under a node test this module
  // is imported for its pure helpers, so don't fill the log with failures.
  if (typeof window === 'undefined') return;
  const notes = Object.keys(next.cents).map(Number);
  const decoded = await Promise.all(notes.map(async midi => {
    try {
      const res = await fetch(sampleUrl(next, midi));
      if (!res.ok) throw new Error(`${res.status}`);
      return [midi, await audio().decodeAudioData(await res.arrayBuffer())];
    } catch (err) {
      console.error(`[audio] ${next.dir}/n${midi} failed to load:`, err.message);
      return null;
    }
  }));
  if (inst !== next) return;
  for (const entry of decoded) {
    if (!entry) continue;
    const [midi, buf] = entry;
    buffers.set(midi, buf);
    const src = buf.getChannelData(0);
    onsets.set(midi, onsetOffset(src, buf.sampleRate));
    // The loop is cut out of a duplicate, not out of the recording — see
    // loopBuffers. The copy is only kept if a loop was actually found.
    if (SAMPLE_SUSTAIN_LOOP) {
      const copy = ctx.createBuffer(1, src.length, buf.sampleRate);
      const data = copy.getChannelData(0);
      data.set(src);
      const loop = buildSustainLoop(data, buf.sampleRate, freqOfMidi(midi));
      if (loop) { loops.set(midi, loop); loopBuffers.set(midi, copy); }
    }
  }
  const lead = [...onsets.values()];
  const meanLead = lead.length ? lead.reduce((a, b) => a + b, 0) / lead.length : 0;
  console.info(`[audio] ${next.name}: ${buffers.size}/${notes.length} note samples decoded`
    + ` — skipping ${(meanLead * 1000).toFixed(0)}ms of lead-in silence,`
    + ` ${loops.size} with a sustain loop`);
}

// The rate factor that puts recording `src` of the current instrument on
// A=440 — see `cents` in config.js.
function tuning(src) {
  return Math.pow(2, -(currentInstrument().cents[src] || 0) / 1200);
}


// Where the note actually starts, in seconds. The threshold is relative to the
// buffer's own peak so it survives a quieter replacement sample, and the result
// backs off by GUARD so a voice starts on near-silence rather than part-way up
// the attack, which would click.
const ONSET_FLOOR = 0.005;      // -46dB of the sample's own peak
const ONSET_GUARD = 0.002;      // seconds kept in front of the attack

export function onsetOffset(data, sampleRate) {
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const v = Math.abs(data[i]);
    if (v > peak) peak = v;
  }
  if (!peak) return 0;
  const floor = peak * ONSET_FLOOR;
  let i = 0;
  while (i < data.length && Math.abs(data[i]) < floor) i++;
  return Math.max(0, i / sampleRate - ONSET_GUARD);
}

// The sustain region, MEASURED off the recording rather than declared.
//
// Taken from SAMPLE_LOOP_AT, which is past the attack transient and inside the
// part of the tail measured at 0.985-1.000 correlation per period across all 24
// files. Two things then have to be true of it, and each is a separate failure
// you can hear.
//
// THE LENGTH IS FOUND BY CORRELATION, not by arithmetic on the note's nominal
// pitch. Rounding SAMPLE_LOOP_MIN up to whole equal-tempered periods looks
// exact and is not: this set is tuned +1.5 to +9.5 cents sharp (see
// `cents` in config.js), and 120 ms of the top octave is over a hundred periods,
// so a few cents of error accumulates into most of a period of drift. Measured
// that way the high notes wrapped ANTI-PHASE — correlation -0.11 to -0.71,
// which is a click on every pass. So the length is chosen by searching a period
// either side of the target for the offset whose material best matches the
// start, which finds the recording's true period whatever it is tuned to.
//
// AND THE REGION IS FLATTENED in place. The natural decay across a 120 ms
// window at 0.4 s runs from 1.5 dB in the low octave to 9.4 dB in the high one,
// so a loop taken raw steps back up to its opening level on every pass — a
// tremolo at the loop rate, which is worse than the silence it was meant to
// cure. The decay is exponential, so cancelling it is one gain curve: scale
// sample i by (a0/a1)^(i/len), measured over one period at each end.
//
// The tail past loopEnd is left untouched and is never heard, because a looped
// voice never reaches it. The array is MUTATED: it is the decoded buffer's own
// channel data, which is the point — the correction lives in the buffer, so
// every voice built from it sustains without repeating the arithmetic.
function windowRMS(data, from, len) {
  let sum = 0;
  for (let i = from; i < from + len; i += 1) sum += data[i] * data[i];
  return Math.sqrt(sum / len);
}

// Normalised cross-correlation of two windows. Normalised because the tail is
// decaying: the two windows differ in LEVEL by design, and what is being asked
// is whether they have the same SHAPE.
function windowMatch(data, a, b, len) {
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < len; i += 1) {
    const p = data[a + i], q = data[b + i];
    num += p * q; da += p * p; db += q * q;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

export function buildSustainLoop(data, rate, freq) {
  const period = rate / freq;
  if (!(period > 1) || !(rate > 0) || !(data && data.length)) return null;
  const start = Math.round(SAMPLE_LOOP_AT * rate);
  const p = Math.round(period);
  const target = Math.max(p, Math.round(SAMPLE_LOOP_MIN * rate));
  const win = p * 3;
  const lo = Math.max(p, target - p);
  const hi = target + p;
  if (start < 1 || start + hi + win >= data.length) return null;

  let len = target;
  let best = -2;
  for (let L = lo; L <= hi; L += 1) {
    const c = windowMatch(data, start, start + L, win);
    if (c > best) { best = c; len = L; }
  }
  const end = start + len;

  const a0 = windowRMS(data, start, p);
  const a1 = windowRMS(data, end - p, p);
  // Clamped: a pathological ratio would amplify the tail's noise floor rather
  // than the note. 4x is 12 dB, well past the 9.4 dB worst case measured.
  const ratio = a0 > 0 && a1 > 0 ? Math.min(4, Math.max(1, a0 / a1)) : 1;
  if (ratio > 1) {
    for (let i = 0; i < len; i += 1) data[start + i] *= Math.pow(ratio, i / len);
  }

  // Crossfade the wrap. Correlation finds the best whole-cycle length there is,
  // not a perfect one — the quietest recording in the set still left a step of
  // 1.4x the local RMS at the junction, which is a tick once a pass. Fading the
  // material that runs up to loopStart into the end of the loop makes the last
  // samples before the wrap converge on the ones before the start, so what
  // plays next continues them. Standard sampler practice, and the reason a
  // loop point does not have to be found to the sample.
  const fade = Math.min(p, Math.floor(len / 4));
  if (fade > 1 && start - fade >= 0) {
    for (let i = 0; i < fade; i += 1) {
      const w = i / fade;
      data[end - fade + i] = data[end - fade + i] * (1 - w) + data[start - fade + i] * w;
    }
  }
  return { start: start / rate, end: end / rate, match: best };
}


// Decoding needs a context, so make one up front instead of waiting for the
// first note — that wait is exactly what used to leave the first note sampleless.
try { audio(); } catch (err) {
  console.error('[audio] could not create AudioContext:', err.message);
}

// Trim + limiter, in that order, between every voice and the output. It is a
// safety net, not an effect: the trim gives the sum of several ringing tails
// somewhere to go, and the limiter only acts on what still peaks over. Live
// playback and the MP3 render build the SAME bus, so the file cannot sound
// different from the editor.
// The bus's lowpass for `instrument` — its toneHz, or wide open at 0. Wide open
// is the top of the band rather than no filter, so the live bus can be retuned
// in place when the instrument changes.
function toneFor(instrument, context) {
  return instrument.toneHz > 0 ? instrument.toneHz : context.sampleRate / 2;
}

export function createMasterBus(context, instrument = currentInstrument()) {
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -4;
  limiter.knee.value = 12;
  limiter.ratio.value = 4;
  limiter.attack.value = 0.008;
  // A release long enough to span the gap between onsets never recovers, and
  // the whole render breathes; this one rides peaks without pumping.
  limiter.release.value = 0.08;
  const trim = context.createGain();
  trim.gain.value = 0.7;
  // See `toneHz` in config.js.
  const tone = context.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = toneFor(instrument, context);
  trim.connect(tone).connect(limiter).connect(context.destination);
  trim.tone = tone;
  return trim;
}

let bus = null;
function masterBus(context) {
  if (!bus) bus = createMasterBus(context);
  return bus;
}

// A voice fades in over this long. The onset trim starts playback just before
// the attack, which is near-silence but not silence — without a ramp that step
// is a click on every single note. An instrument's `attack` says how much
// longer than that; CLICK_ATTACK is the shortest fade that does not click.
const CLICK_ATTACK = 0.003;
const attackLen = () => Math.max(CLICK_ATTACK, currentInstrument().attack);

// What a release ramps down to. Exponential ramps cannot reach zero, so this is
// the conventional near-silence they aim at, named because the sustain decay
// now has to stay clear of it — see sustainLevelAt().
const RELEASE_FLOOR = 0.0001;

// ---------- how a sounding note ages ----------
//
// See the sustain block in config.js for why a held voice must not simply hold.
// Both halves are pure and both are used THREE times — the live voice, the
// struck voice and the offline MP3 render — because a file that shaped its
// notes differently from the editor would not be the same performance.

// The level a voice has reached `elapsed` seconds into its decay.
// Written out rather than read back off the AudioParam because the release has
// to be scheduled AHEAD, at a time that has not happened yet: a ramp booked
// from a stale value steps the note back up to full before falling, which is a
// bump on the end of every note.
export function sustainLevelAt(level, elapsed, decayT = SUSTAIN_DECAY_T) {
  const t = Math.max(0, Number(elapsed) || 0);
  const v = level * (SUSTAIN_FLOOR + (1 - SUSTAIN_FLOOR) * Math.exp(-t / decayT));
  // Never below the value the release ramps TO. The decay now runs all the way
  // to silence, so a note released after a very long hold reaches a level under
  // RELEASE_FLOOR — and an exponential ramp whose start is below its target
  // ramps UPWARDS, which would swell the note at the moment it is let go.
  return Math.max(v, RELEASE_FLOOR);
}

// The two ends of the darkening sweep for a note at `freq`. Held clear of the
// note's own pitch at both ends — see config.js. Guarded against a bad
// frequency so a filter is never handed a NaN, which silences the voice
// outright rather than failing loudly.
export function sustainTone(freq) {
  const f = Number(freq) > 0 ? Number(freq) : 440;
  return {
    from: Math.max(SUSTAIN_TONE_FROM_HZ, f * SUSTAIN_TONE_FROM_RATIO),
    to: Math.max(SUSTAIN_TONE_TO_HZ, f * SUSTAIN_TONE_TO_RATIO),
  };
}

// The decay's time constant for a note whose sustained part — written end
// minus the point the loop takes over — is `span` seconds. See
// SUSTAIN_DECAY_MIN_T: a fixed constant held every one-beat note flat.
export function sustainDecayT(span) {
  return Math.min(SUSTAIN_DECAY_T, Math.max(SUSTAIN_DECAY_MIN_T, Number(span) || 0));
}

// The whole envelope of one played note of written length `d`: attack, the
// decay, the release. Returns when it has rung out. `loopAt` is how long after
// the voice starts the loop takes over (null: no loop). ONE function for the
// Play button and the MP3 render, so a note cannot age differently in the file.
//
// The decay starts where the recording stops falling by itself, and before
// that the recording is left alone. Looped, that is the loop point. Unlooped
// it is the instrument's `fadeAt`, with a held key's own fade — the recording sits on a
// residue instead of dying, and a played note must not end on that buzz any
// more than a held key may.
export function shapeNote(param, level, t, d, loopAt = null) {
  // Never more than half the note, or a short note is still fading in when it
  // ends. Never under CLICK_ATTACK either.
  const atk = Math.max(CLICK_ATTACK, Math.min(attackLen(), d / 2));
  attackOnly(param, level, t, atk);
  const looped = loopAt != null;
  // Held for the whole written value, released AFTER it over a short tail that
  // crossfades into the next note's attack — see RELEASE_SHARE.
  const ring = Math.max(ringLength(d), CLICK_ATTACK);
  const hold = t + Math.max(d, atk);
  const from = t + Math.max(looped ? loopAt : currentInstrument().fadeAt, atk);
  let end = level;
  // Only if the note lasts that long: a decay booked past `hold` would land in
  // the middle of the release ramp.
  if (from < hold) {
    const decayT = looped ? sustainDecayT(hold - from) : HELD_FADE_T;
    param.setTargetAtTime(level * SUSTAIN_FLOOR, from, decayT);
    end = sustainLevelAt(level, hold - from, decayT);
  }
  // Pin the level the decay has ACTUALLY reached, never the struck level —
  // that would step the note back up to full at the moment it is let go.
  param.setValueAtTime(end, hold);
  const done = hold + ring;
  // LINEAR, not exponential: an exponential release is steepest at its start,
  // so the old note had dropped ~9 dB before the next one had faded in, and
  // every note change dipped. A straight line stays near full while the next
  // note rises, and the two crossfade at a steady level.
  param.linearRampToValueAtTime(0, done);
  return done;
}

// Attack and nothing else, for a voice whose recording supplies its own decay.
export function attackOnly(param, level, t, atk = attackLen()) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(level, t + atk);
}

// The darkening, as a lowpass whose corner falls away from the strike.
function shapeTone(context, freq, t) {
  const { from, to } = sustainTone(freq);
  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  // Left at the default 0.7071 Q: this is a tone control, not a resonance, and
  // any lift at the corner would put a formant on the note that moves as the
  // corner moves — a wah, which is far more noticeable than the flutter it is
  // here to remove.
  filter.frequency.setValueAtTime(Math.min(from, context.sampleRate * 0.45), t);
  filter.frequency.setTargetAtTime(to, t, SUSTAIN_TONE_T);
  return filter;
}

// Which recording to play for a wanted pitch: the nearest one. On a tie prefer
// the HIGHER sample, because shifting a sample down sounds better than
// stretching one up.
function nearestSample(midi) {
  let best = null, bestDist = Infinity;
  for (const m of buffers.keys()) {
    const d = Math.abs(m - midi);
    if (d < bestDist || (d === bestDist && m > best)) { bestDist = d; best = m; }
  }
  return best;
}

// Frequency -> (fractional) MIDI note, for picking the nearest sample. NOT the
// same question as midiNoteOf(), which maps a WRITTEN note to a MIDI number.
const midiFromFreq = f => 69 + 12 * Math.log2(f / 440);

// Start one sampled voice at frequency `f`. Returns null only while the samples
// are still decoding (or if every one of them failed) — the caller then waits
// for `whenReady()` instead of substituting another sound.
// `when` is an AudioContext time. Playback schedules notes AHEAD on that clock
// rather than starting them the moment a timer fires: the timer shares a thread
// with the score redraw, and a note started from it lands 7-15ms late depending
// on how busy the frame was. Ahead-scheduled, the onset is sample-accurate no
// matter what the main thread is doing.
// `sustain` is whether this voice may run on past the recording. Playback says
// yes — a written Maguru has to last four beats and the set is a single pluck
// that is gone in three seconds. A HELD KEY says no: what it wants is the fade
// the instrument itself has, and that is the recording, played once.
function sampleVoice(f, when = null, level = SAMPLE_GAIN, sustain = true) {
  const a = audio();
  if (!buffers.size) return null;
  const midi = midiFromFreq(f);
  const src = nearestSample(midi);
  if (src == null) return null;

  const node = a.createBufferSource();
  // Within a SUSTAINED voice the loop is unconditional, not reserved for notes
  // long enough to need it: the prepared copy is flattened, so the material
  // after loopEnd is a step down from it, and looping means no voice ever
  // reaches that step. What ends such a note is its envelope, which is where
  // duration belongs. An unsustained voice plays the untouched recording and
  // never meets the step at all.
  const loop = sustain ? loops.get(src) : null;
  node.buffer = bufferFor(src, !!loop);
  if (loop) {
    node.loop = true;
    node.loopStart = loop.start;
    node.loopEnd = loop.end;
  }
  // tuning() pulls the recording onto concert pitch — every set is a few cents
  // sharp of A=440, which beats against a live instrument. It is a factor on
  // the rate, so it never changes WHICH sample is chosen.
  node.playbackRate.value = Math.pow(2, (midi - src) / 12) * tuning(src);
  if (!sampleVoice.logged) {
    sampleVoice.logged = true;
    console.info(`[audio] sampled playback active — first note MIDI ${midi.toFixed(1)}`
      + ` from n${src} at rate ${node.playbackRate.value.toFixed(3)}`);
  }

  const g = a.createGain();
  const t = Math.max(when == null ? a.currentTime : when, a.currentTime);
  // A sustained voice gets its whole envelope from strike(), which knows how
  // long the note is. A held key's recording dies on its own, then stops
  // falling and sits on a residue — see `fadeAt` in config.js.
  if (!sustain) {
    attackOnly(g.gain, level, t);
    g.gain.setTargetAtTime(0, t + currentInstrument().fadeAt, HELD_FADE_T);
  }
  // The darkening only makes sense over a LOOPED voice: a sample with no loop
  // runs out on its own and is already losing its top as it decays, so filtering
  // it would take away tone the recording was going to lose anyway.
  node.connect(loop ? shapeTone(a, f, t).connect(g) : g).connect(masterBus(a));
  // Start AT the attack, not at sample zero — see the note at the top.
  const onset = onsets.get(src) || 0;
  node.start(t, onset);
  // When, after its start, this voice stops being the recording and becomes
  // the loop — in real time, so the shift is divided back out.
  const loopAt = loop ? (loop.start - onset) / node.playbackRate.value : null;
  // `level` rides on the voice so strike() holds it at the level it was
  // actually started at, rather than snapping every voice back to SAMPLE_GAIN.
  return { node, g, at: t, level, loopAt, looped: !!loop, sampled: true, stopped: false };
}

// Which of the two recordings a voice plays. A looped voice must take the
// prepared copy — the loop points were measured in it — and everything else
// takes the untouched one.
function bufferFor(midi, looped) {
  return (looped && loopBuffers.get(midi)) || buffers.get(midi);
}

function whenReady() {
  audio();
  return ready || setInstrument(state.instrument);
}

// Pitch is intervallic from state.saMidi (the tonic key set by the Sa picker).
// A svara with semi=0, oct=0 plays at exactly the Sa key's pitch.
// The audio clock. Playback schedules against this rather than performance.now()
// — it is the only clock the sound actually obeys.
export function audioNow() {
  return audio().currentTime;
}

// ---------- the clock you HEAR ----------
//
// currentTime is where the graph is being RENDERED. It runs AHEAD of the
// speaker by the device's output latency — 10 ms on a good WASAPI path, 40 ms
// and more on Bluetooth or a shared-mode driver — so a sound scheduled at
// currentTime + d is not heard d from now, it is heard d + latency from now.
//
// Everything inside the app can ignore that, because every voice is late by
// the same amount and a click and a note scheduled together still land
// together. It stops being ignorable the moment a SECOND instrument is in the
// room: the keyboard's own metronome comes out of its own speaker with none of
// our latency on it, so an app click scheduled by currentTime arrives audibly
// behind it. That is a flam, and no amount of correct clock arithmetic
// upstream removes it.
//
// getOutputTimestamp() is the one API that answers the right question. It
// pairs the audio-clock position being HEARD RIGHT NOW with the performance
// clock, so the conversion below carries the latency instead of ignoring it.

// How far currentTime runs ahead of the speaker, in seconds.
export function outputLatency() {
  const a = audio();
  const ts = a.getOutputTimestamp?.();
  if (ts && ts.contextTime > 0) return Math.max(0, a.currentTime - ts.contextTime);
  // Not every build reports a timestamp. base + output is the same quantity
  // assembled from its two declared parts.
  return (a.baseLatency || 0) + (a.outputLatency || 0);
}

// A performance.now() moment -> the AudioContext time to SCHEDULE at so the
// sound is HEARD at that moment. The answer is normally BEHIND audioNow(),
// which is not a bug: it is the caller being told that a sound wanted this
// soon has already missed its slot, and that anything meant to land with an
// external instrument has to be scheduled at least outputLatency() ahead.
export function audioTimeForPerf(ms) {
  const a = audio();
  const ts = a.getOutputTimestamp?.();
  if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
    return ts.contextTime + (ms - ts.performanceTime) / 1000;
  }
  return a.currentTime - outputLatency() + (ms - performance.now()) / 1000;
}

// The same correlation read the other way: the performance.now() moment at
// which a sound scheduled at AudioContext time `at` is actually HEARD.
//
// This is what anything sent OUT to the instrument must be stamped by. A note
// or a clock pulse handed to the device plays essentially the moment it
// arrives, with none of our output latency on it, so a message stamped from
// currentTime lands EARLY against the app's own sound by exactly the amount a
// followed click lands late. Same latency, opposite sign, same flam.
export function perfTimeForAudio(at) {
  const a = audio();
  const ts = a.getOutputTimestamp?.();
  if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
    return ts.performanceTime + (at - ts.contextTime) * 1000;
  }
  return performance.now() + (at - a.currentTime + outputLatency()) * 1000;
}

// THE context — there is exactly one, and everything that makes a sound has to
// be built on it. Two AudioContexts have unrelated `currentTime` origins and
// independently drifting sample clocks, so a click scheduled on a second one
// can never be made to land with a note scheduled on the first, however
// carefully either is timed. The metronome had its own and that is precisely
// why it would not play with the music.
//
// It also carries the autoplay unpark: a context built before any gesture is
// created suspended, and a caller that does not come through here gets a
// silent context that never resumes.
export function audioCtx() {
  return audio();
}

// A MIDI note number straight to a frequency, for a key the staff cannot
// write: it is still heard, so it still needs a pitch, and it has no (semi,
// oct) on the ladder to ask freqOf() for.
export function freqOfMidi(midi) {
  return 440 * Math.pow(2, (Number(midi) - 69) / 12);
}

// The MIDI note a written note IS. Split out of freqOf() because the score can
// now be sounded on the connected instrument as well as on the samples, and
// both have to agree about which note that is — sending the device a pitch
// derived a second way is how the staff and the keyboard end up a semitone
// apart.
export function midiNoteOf(semi, oct) {
  return (state.saMidi ?? 60) + semi + 12 * oct;
}

export function freqOf(semi, oct) {
  return freqOfMidi(midiNoteOf(semi, oct));
}

// The note's WRITTEN value in seconds — how long it is held at level before
// anything is released. ONE rule for the Play button and for MP3 export.
export function heldLength(beats, bpm) {
  return Math.max(0, Number(beats) || 0) * (60 / (Number(bpm) || 120));
}

// How long a note of written length `held` takes to fade AFTER its written
// end — the crossfade into the next note. See RELEASE_SHARE in config.js.
export function ringLength(held) {
  return Math.min(RELEASE_MAX_SECONDS, (Number(held) || 0) * RELEASE_SHARE);
}

// One struck note, held `d` seconds and then released over ringLength(d).
export function pluck(f, d = 0.33) {
  return pluckAt(f, d, null);
}

// The same strike, at a chosen point on the audio clock. `when` in the past is
// clamped to now, so a scheduler that falls behind still sounds the note.
export function pluckAt(f, d, when = null) {
  const v = sampleVoice(f, when);
  if (v) { strike(v, d); damp(lastStrike, Math.round(midiFromFreq(f)), v); return v; }
  // Samples still decoding: play this note as soon as they land — but never
  // long after its moment has gone, or a stale note fires over a later one.
  whenReady().then(() => {
    if (when != null && audioNow() > when + 0.25) return;
    const late = sampleVoice(f, when);
    if (late) strike(late, d);
  });
  return null;
}

// A string struck again stops ringing from the last time. Without this the
// ring every short note now gets (RING_MIN_SECONDS) piles up under a run: at
// danta speed five strikes of one pitch ring at once and a repeated S S S
// reads as one held S — the run loses its articulation and a danta passage
// sounds no faster than a praya one. So the previous voice on the SAME pitch
// is damped at the new one's onset; other pitches ring on underneath, which
// is the legato the ring exists for. `last` maps pitch -> {g, node}, one map
// per context, and the onsets must arrive in time order (playback's and the
// MP3 render's both do).
//
// The old voice fades out in a straight line over DAMP_T, under the new strike,
// the way a piano string re-struck is still sounding when the hammer lands. It
// was cut in 12 ms, which dropped the pitch to nothing as the new note began.
// Each repeat then started again from silence, and S S S was reported from the
// field as a "tan" on every repeat.
const DAMP_T = 0.08;
const lastStrike = new Map();
export function damp(last, key, v) {
  const prev = last.get(key);
  last.set(key, v);
  // Nothing to damp if it has already rung out, or would start after this one.
  if (!prev || prev.at >= v.at || prev.end <= v.at) return;
  const p = prev.g.gain;
  if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(v.at); else p.cancelScheduledValues(v.at);
  p.linearRampToValueAtTime(0, v.at + DAMP_T);
  prev.node.stop(v.at + DAMP_T + 0.01);
}

// Measured from the voice's OWN start, which for a scheduled note is in the
// future.
function strike(v, d) {
  v.end = shapeNote(v.g.gain, v.level ?? SAMPLE_GAIN, v.at, d, v.loopAt);
  v.node.stop(v.end);
}

// A held piano key uses a sustained voice rather than repeatedly inserting
// notes. The returned handle is intentionally opaque; pass it to stopSustain
// when the pointer or physical key is released. If the samples are not decoded
// yet the handle comes back empty and fills itself in when they are — unless
// the key was already let go by then.
//
// `gain` is how hard the key was struck, 1 being a normal strike. A MIDI
// keyboard's velocity arrives here; the on-screen piano and the letter keys
// have no such thing to report and leave it at 1, which is the level every
// voice played at before velocity was read at all.
export function startSustain(f, gain = 1) {
  const level = SAMPLE_GAIN * Math.max(0, Number(gain) || 0);
  // NOT sustained: a held key plays the recording once and lets it die, which
  // is what the instrument does under a finger that stays down. The loop was
  // making it ring instead — past SAMPLE_LOOP_AT the tone stops changing, and
  // a stationary tone is heard as a ring for as long as it is there, which on
  // a long hold is seconds of it. Nothing about the loop could fix that (see
  // config.js, where nine cuts of it were measured): what is wrong with a
  // frozen tone is that it does not move, not where it was cut.
  const v = sampleVoice(f, null, level, false);
  // The recording runs out on its own, so a key whose release never arrives —
  // a missed MIDI note-off — can no longer drone. The cap is kept anyway: it
  // costs nothing and it is the one guard that does not depend on the buffer's
  // length. Any real release calls stopSustain() long before it.
  if (v) { capSustain(v); return v; }

  const handle = { node: null, g: null, level, sampled: true, stopped: false };
  whenReady().then(() => {
    if (handle.stopped) return;
    const late = sampleVoice(f, null, level, false);
    if (!late) return;
    handle.node = late.node;
    handle.g = late.g;
    handle.at = late.at;
    capSustain(handle);
  });
  return handle;
}

function capSustain(v) {
  if (v && v.node) v.node.stop((v.at ?? audioNow()) + SAMPLE_SUSTAIN_MAX);
}

// Releases a sampled voice. A voice whose sample had not arrived yet has
// nothing to stop — marking it stopped is enough, the pending start sees the
// flag and never sounds.
export function stopSustain(voice) {
  if (!voice || voice.stopped) return;
  voice.stopped = true;
  if (!voice.node) return;

  const t = audio().currentTime;
  const g = voice.g;
  g.gain.cancelScheduledValues(t);
  g.gain.setValueAtTime(Math.max(g.gain.value, RELEASE_FLOOR), t);
  g.gain.exponentialRampToValueAtTime(RELEASE_FLOOR, t + RING_MIN_SECONDS);
  voice.node.stop(t + RING_MIN_SECONDS + 0.02);
}

// Render playback without using the speakers. MP3 export calls this with the
// same expanded sequence used by the Play button, so repeats, rests, ties,
// tempo and tonic all match what the user hears in the editor.
// `clicks(context, beatSeconds, musicSeconds)` lays the metronome into the same
// render — handed in rather than imported, because metronome.js imports this
// module.
export async function renderSequenceOffline(sequence, bpm, clicks = null) {
  await whenReady();
  if (!buffers.size) throw new Error('The note samples could not be loaded.');

  const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineContext) throw new Error('Offline audio rendering is not supported.');

  const tempo = Math.max(20, Math.min(320, Number(bpm) || 120));
  // One written beat is one tempo beat, exactly as playback.js and the
  // metronome count it, so the exported audio matches what the editor plays.
  const stepSeconds = 60 / tempo;
  const events = [];
  let cursor = 0;

  for (const item of sequence) {
    const n = item.n;
    const dur = Number(n.dur) || 1;
    if (n.type === 'note' && !n.tie) {
      const wantedMidi = (state.saMidi ?? 60) + semiOf(n.svaraIndex, n.head) + 12 * n.oct;
      const sourceMidi = nearestSample(wantedMidi);
      const rate = Math.pow(2, (wantedMidi - sourceMidi) / 12) * tuning(sourceMidi);
      const offset = onsets.get(sourceMidi) || 0;
      // The recording's own end used to be the cap — a release could not be
      // scheduled past material that did not exist. With a sustain loop there
      // is always material, so the written value is the only thing that ends a
      // note, exactly as it is for the Play button. A sample with no loop (too
      // short to take one) keeps the old cap, or its release would be booked
      // over silence.
      const loop = loops.get(sourceMidi);
      const natural = (buffers.get(sourceMidi).duration - offset) / rate;
      const want = heldLength(Number(n.full) || dur, tempo);
      const soundSeconds = loop ? want : Math.min(want, natural);
      events.push({ wantedMidi, sourceMidi, rate, offset, start: cursor, soundSeconds, loop });
    }
    cursor += dur * stepSeconds;
  }

  if (!events.length) throw new Error('Add at least one note before exporting MP3.');
  const tail = 0.3;
  const duration = Math.max(cursor,
    ...events.map(e => e.start + e.soundSeconds)) + tail;
  if (duration > 600) throw new Error('MP3 export is limited to 10 minutes.');

  const sampleRate = 44100;
  const offline = new OfflineContext(2, Math.ceil(duration * sampleRate), sampleRate);
  const trim = createMasterBus(offline);
  const struck = new Map();

  for (const event of events) {
    const source = offline.createBufferSource();
    source.buffer = bufferFor(event.sourceMidi, !!event.loop);
    source.playbackRate.value = event.rate;
    // The same loop the live voice takes, so the file cannot sound different
    // from the editor — which is the whole reason this shares heldLength(),
    // ringLength() and createMasterBus() with it.
    if (event.loop) {
      source.loop = true;
      source.loopStart = event.loop.start;
      source.loopEnd = event.loop.end;
    }

    const gain = offline.createGain();
    // The same envelope and the same darkening the live voice takes, for the
    // same reason the loop and the master bus are shared: the export is the
    // performance, so a note may not age differently in the file.
    const done = shapeNote(gain.gain, SAMPLE_GAIN, event.start, event.soundSeconds,
      event.loop ? (event.loop.start - event.offset) / event.rate : null);
    const freq = freqOfMidi(event.wantedMidi);
    source.connect(event.loop ? shapeTone(offline, freq, event.start).connect(gain) : gain)
      .connect(trim);
    source.start(event.start, event.offset);
    source.stop(Math.min(duration, done));
    damp(struck, event.wantedMidi, { g: gain, node: source, at: event.start, end: done });
  }

  if (clicks) clicks(offline, stepSeconds, cursor);
  return offline.startRendering();
}
