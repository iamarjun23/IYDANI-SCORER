// Shape of You (Ed Sheeran) — melody line, converted to the DNG project format.
//
// Source: a MIDI-JSON dump of the arrangement (96 bpm, PPQ 96). Only the
// "Voice" track is transcribed; the Lead/Strings/Chorus/Bass/Drums tracks are
// accompaniment and DNG writes one melodic line.
//
// The tune is in C# minor, so Sa = C#5 (MIDI 73). Every melody pitch then
// falls in madhya (73..83) or mandra (68, 71) — nothing needs taara.
//
//   run: node tools/generate-shape-of-you.mjs

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOUND, TIME_UNITS_PER_BEAT, REST_MAP } from '../src/renderer/config.js';
import { glyphFor, padRests } from '../src/renderer/notation.js';

const BPM     = 96;
const SA_MIDI = 73;              // C#5
const TITLE   = 'Shape of You';
const UNIT    = (60 / BPM) / TIME_UNITS_PER_BEAT;   // seconds per danta

// [time (s), midi, duration (s)] — duration defaults to a praya (0.15625s).
const D = 0.15625;
const VOICE = [
  [9.84375,73],[10,76,0.2604166666666661],[10.3125,76],[10.46875,76],[10.625,76],
  [10.78125,76],[11.09375,76],[11.40625,73],[11.5625,76],[11.71875,76],[11.875,76],
  [12.03125,76],[12.1875,76],[12.34375,76],[12.5,76],[12.8125,76],[13.125,80],
  [13.28125,80],[13.59375,80],[15,83],[15.15625,78],[15.3125,80],[15.46875,80],
  [15.78125,80],[16.09375,80],[16.25,78],[16.40625,78],[16.5625,78],[16.71875,78],
  [16.875,78],[17.1875,78],[17.34375,76],[17.5,78],[17.8125,78],[18.125,78],
  [18.28125,76],[18.59375,73],[19.84375,78],[20,80],[20.15625,80],[20.3125,80],
  [20.46875,80],[20.625,80],[20.78125,80],[20.9375,80],[21.09375,80],[21.40625,80],
  [21.5625,80],[21.71875,80],[21.875,80],[22.03125,80],[22.1875,80],[22.34375,80],
  [22.5,83],[22.8125,80],[23.125,78],[23.28125,78],[23.4375,76],[23.59375,80,0.625],
  [24.375,78],[24.53125,76],[24.84375,76],[25,83],[25.15625,78],[25.3125,80],
  [25.46875,80],[25.78125,80],[26.09375,80],[26.25,78],[26.40625,78],[26.5625,78],
  [26.71875,78],[26.875,78],[27.1875,78],[27.34375,76],[27.5,78],[27.8125,78],
  [28.125,78],[28.28125,76],[28.59375,73],[28.90625,68],[29.0625,68],[29.375,73],
  [29.53125,73],[29.6875,73],[30,73],[30.3125,73],[30.625,73],[30.9375,71],
  [31.25,73],[31.5625,80],[31.875,78,0.2604166666666643],[32.5,76],[32.65625,78],
  [32.96875,80],[33.125,78],[33.4375,76],[33.75,73],[34.0625,76],[34.375,80],
  [34.53125,76],[34.6875,78,0.2604166666666643],[35,73],[35.625,83],[35.78125,78],
  [35.9375,80],[36.25,78],[36.40625,78],[36.5625,76],[36.875,73],[37.5,78],
  [37.65625,78],[37.96875,76],[38.125,78],[38.4375,76],[38.75,78],[39.0625,76],
  [39.375,73],[39.6875,71],[40,73,0.3125],[40.625,73,0.3125],[40.9375,71,0.3125],
  [41.25,73,0.3125],[41.5625,80,0.3125],[41.875,78,0.3125],[42.5,78],[42.65625,78],
  [42.96875,80],[43.125,78],[43.4375,76],[43.75,73],[44.0625,76],[44.375,80],
  [44.53125,76],[44.6875,78],[45,73],[45.625,83],[45.78125,78],[45.9375,80],
  [46.25,78],[46.40625,78],[46.5625,76],[46.875,73],[47.1875,73],[47.5,83],
  [47.65625,78],[47.8125,80],[48.125,78],[48.28125,78],[48.4375,76],[48.75,73],
  [50.9375,76],[51.09375,78],[51.25,80],[51.5625,78],[51.71875,76],[51.875,76],
  [52.1875,78],[52.5,78],[53.4375,76],[53.59375,78],[53.75,80],[54.0625,78],
  [54.21875,76],[54.375,76],[54.6875,78],[55,73],[55.9375,76],[56.09375,78],
  [56.25,80],[56.5625,78],[56.71875,76],[56.875,76],[57.1875,78],[57.5,78],
  [58.4375,76],[58.59375,78],[58.75,80],[59.0625,78],[59.21875,76],
  [59.375,78,0.46875],[59.84375,73],[60.9375,76],[61.09375,78],[61.25,80],
  [61.5625,78],[61.71875,76],[61.875,76],[62.1875,78],[62.5,78],[63.4375,76],
  [63.59375,78],[63.75,80],[64.0625,78],[64.21875,76],[64.375,76],[64.6875,78],
  [65,73],[65.3125,73],[65.46875,73],[65.625,73],[65.78125,73],[65.9375,76],
  [66.09375,78],[66.25,80],[66.5625,73],[66.875,76],[67.1875,78],[67.5,78],
  [68.4375,76],[68.59375,78],[68.75,80],[69.0625,78],[69.21875,76],
  [69.375,78,0.46875],[69.84375,73],[73.4375,76],[73.59375,78],[73.75,80,0.3125],
  [74.0625,78],[74.21875,76],[74.375,78,0.46875],[74.84375,73],[78.4375,76],
  [78.59375,78],[78.75,80,0.3125],[79.0625,78],[79.21875,76],[79.375,78,0.46875],
  [79.84375,73],[83.4375,76],[83.59375,78],[83.75,80,0.3125],[84.0625,78],
  [84.21875,76],[84.375,78,0.46875],[84.84375,73],[85.3125,73],[85.46875,73],
  [85.625,73],[85.78125,73],[85.9375,76],[86.09375,78],[86.25,80],[86.5625,73],
  [86.875,76],[87.1875,78],[87.5,78],[88.4375,76],[88.59375,78],[88.75,80,0.3125],
  [89.0625,78],[89.21875,76],[89.375,76,0.3125],[89.6875,78,0.3125],[90,73],
];

// A semitone above Sa resolves to a ladder position plus the notehead that says
// which of the pair it is — hollow natural, filled chromatic variant. Same rule
// semiOf() reads in the other direction.
const TONE = [
  [0,'o'],[1,'f'],[1,'o'],[2,'f'],[2,'o'],[3,'o'],
  [3,'f'],[4,'o'],[5,'f'],[5,'o'],[6,'f'],[6,'o'],
];

const REST_OF = Object.fromEntries(
  Object.entries(REST_MAP).map(([rest, sound]) => [sound, rest]));

const events = VOICE
  .map(([time, midi, dur = D]) => ({
    at:   Math.round(time / UNIT),
    midi,
    held: Math.max(1, Math.round(dur / UNIT)),
  }))
  .sort((a, b) => a.at - b.at);

const notes = [];
let at = events[0].at;   // the score starts on the first sung note

function writeRests(units) {
  for (const rest of padRests(units, at % TIME_UNITS_PER_BEAT)) {
    notes.push(rest);
    at += Math.round(rest.dur * TIME_UNITS_PER_BEAT);
  }
}

events.forEach((event, i) => {
  const next = events[i + 1];
  writeRests(event.at - at);

  // A note runs to the next onset, so the line reads legato — except across a
  // real pause, where it keeps one beat and the silence is written as rests.
  const span = next ? next.at - event.at : event.held;
  const units = span <= TIME_UNITS_PER_BEAT
    ? span
    : Math.max(event.held, TIME_UNITS_PER_BEAT);

  const g = glyphFor(units);
  const semi = ((event.midi - SA_MIDI) % 12 + 12) % 12;
  const [svaraIndex, head] = TONE[semi];
  notes.push({
    type: 'note',
    svaraIndex,
    oct:  Math.floor((event.midi - SA_MIDI) / 12),
    head,
    sym:  g.sym,
    dot:  !!g.dot,
    dur:  SOUND[g.sym].dur * (g.dot ? 1.5 : 1),
    deco: SOUND[g.sym].deco,
  });
  at += g.units;
  writeRests(units - g.units);
});

const dng = {
  title: TITLE,
  tala:  'adi',
  scale: 'Mayamalavagowla',
  bpm:   BPM,
  saMidi: SA_MIDI,
  notes,
  bars:  [],
  breaks: [],
  transcription: 'Melody ("Voice") track of a MIDI arrangement of Ed Sheeran — '
    + 'Shape of You, quantised to the danta grid. Sa = C#5.',
};

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'Files');
await mkdir(outDir, { recursive: true });
const out = resolve(outDir, 'Shape_of_You.dng.json');
await writeFile(out, JSON.stringify(dng, null, 2));

const beats = notes.reduce((b, n) => b + n.dur, 0);
console.log(`${notes.length} events (${events.length} notes, `
  + `${notes.length - events.length} rests), ${beats} beats -> ${out}`);
