import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TITLE = 'Nee En Sangeedham';
const BPM = 72;
const SA_MIDI = 60; // C4

// A comma lengthens the preceding note. Each lyric line is separated by a
// short rest; sectionEnd adds a longer rest between the Malayalam verse and
// the repeated Mehbooba refrain.
const phrases = [
  ['Nee En Sangeedham', 'A4 G#4 F#4 E4 F#4'],
  ['Inni Nee En Sallabham', 'F#4 G#4 A4 G#4 F#4 E4 F#4'],
  ['Nee En Sreeragam', 'A4 G#4 F#4 E4 F#4'],
  ['Alonjiruyum Anuragam', 'F#4 E4, E4 E4 F#4 G#4 A4 F#4'],

  ['Nee Mizhakaliloorum Sneham', 'A4 A4 B4 A4 G#4 F#4 E4 F#4'],
  ['En Kanavil Viriyum Moham', 'F#4 E4, E4 F#4 G#4 F#4, F#4 G#4 B4 A4 G#4 F#4'],
  ['Nin Kaykalil Cherum Neram', 'A4 A4 B4 A4 G#4 F#4 E4 F#4'],
  ['Njan Panineer Malaragam', 'F#4 E4 F#4 G#4, F#4 G#4 B4 A4 G#4', true],

  ['Mehabooba Main Teri Mehbooba', 'E4 F#4 A4 G#4 F#4, A4 G#4 F#4 E4, E4 F#4 F#4 G#4 G#4'],
  ['Mehbooba Main Teri Mehbooba', 'E4 F#4 A4 G#4 F#4, B4 G#4 F#4 E4, E4 E4 E4 F#4 F#4'],
  ['Mehabooba Main Teri Mehbooba', 'E4 F#4 A4 G#4 F#4, A4 G#4 F#4 E4, E4 F#4 F#4 G#4 G#4'],
  ['Mehbooba Main Teri Mehbooba', 'E4 F#4 A4 G#4 F#4, B4 G#4 F#4 E4, E4 E4 E4 F#4 F#4', true],
];

const pitchClass = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const tone = [
  [0, 'o'], [1, 'f'], [1, 'o'], [2, 'f'], [2, 'o'], [3, 'o'],
  [3, 'f'], [4, 'o'], [5, 'f'], [5, 'o'], [6, 'f'], [6, 'o'],
];

function midiOf(token) {
  const match = /^([A-G])(#|b)?(\d)$/.exec(token);
  if (!match) throw new Error(`Invalid note: ${token}`);
  const accidental = match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0;
  return 12 * (Number(match[3]) + 1) + pitchClass[match[1]] + accidental;
}

function writtenNote(token, held) {
  const midi = midiOf(token);
  const relative = midi - SA_MIDI;
  const semi = ((relative % 12) + 12) % 12;
  const [svaraIndex, head] = tone[semi];
  return {
    type: 'note',
    svaraIndex,
    oct: Math.floor(relative / 12),
    head,
    sym: held ? 'bindu' : 'vasu',
    dot: false,
    dur: held ? 1 : 0.5,
    deco: held ? 'none' : 'bar1',
  };
}

const notes = [];
for (const [, notation, sectionEnd] of phrases) {
  const tokens = notation.match(/[A-G](?:#|b)?\d|,/g) || [];
  tokens.forEach((token, index) => {
    if (token === ',') return;
    const held = tokens[index + 1] === ',' || index === tokens.length - 1;
    notes.push(writtenNote(token, held));
  });
  notes.push(sectionEnd
    ? { type: 'rest', sym: 'rest_5', dur: 2 }
    : { type: 'rest', sym: 'rest_2', dur: 0.5 });
}

const song = {
  title: TITLE,
  tala: 'chatusra',
  scale: 'Mayamalavagowla',
  bpm: BPM,
  saMidi: SA_MIDI,
  notes,
  bars: [],
  breaks: [],
  transcription: 'User-provided Western-note transcription. Half-beat default notes; commas and phrase endings are one-beat holds. Sa=C4.',
  lyrics: phrases.map(([lyric, notation]) => ({ lyric, notation })),
};

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(projectDir, 'Nee_En_Sangeedham.dng.json');
await writeFile(output, `${JSON.stringify(song, null, 2)}\n`);

console.log(`Generated ${notes.length} score events -> ${output}`);
