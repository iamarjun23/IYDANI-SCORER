import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TPQ = 480;
const EIGHTH = TPQ / 2;
const QUARTER = TPQ;
const BPM = 111;

// The supplied notation covers this complete chorus/refrain passage. A comma
// lengthens the preceding syllable; it does not insert a dead-air rest.
const phrases = [
  ['Premalokadinda tanda Premada sandesha', 'F#4 F#4 F#4, E4 F#4 A4 B4, A4 B4 A4 F#4 E4 F#4', 240, 480],
  ['bhoomiyalli haadi tilisona', 'F#4 F#4, F#4 C#5, C#5 E5 C#5 B4 C#5', 240, 480],
  ['preeti hanchona, aananda padeyona', 'B4 C#5 E5 F#5 E5, A4 B4 C#5 B4 A4 F#4', 240, 480],
  ['banni Prema Rahasya Helona', 'C#4 C#4, C#5 C#5, B4 C#5 B4 A4 E4 F#4', 480, 720],

  ['jeevanavendare', 'F#5 E5 C#5 E5 F#5', 120, 720],
  ['preeti Ennona', 'A4 F#4 A4 B4 A4 F#4', 240, 480],
  ['lokada srushtige', 'A4 F#4 A4 B4 C#5', 120, 480],
  ['preeti kaarana', 'C#4 A4 G#4 F#4 E4 F#4', 480, 720],

  ['jeevanavendare', 'F#5 E5 C#5 E5 F#5', 120, 720],
  ['preeti Ennona', 'A4 F#4 A4 B4 A4 F#4', 240, 480],
  ['lokada srushtige', 'A4 F#4 A4 B4 C#5', 120, 480],
  ['preeti kaarana', 'C#4 A4 G#4 F#4 E4 F#4', 480, 720],

  ['Premalokadinda tanda Premada sandesha', 'F#4 F#4 F#4, E4 F#4 A4 B4, A4 B4 A4 F#4 E4 F#4', 960, 960],
];

const pitchClass = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function parseNotation(text) {
  return text.match(/[A-G](?:#|b)?\d|,/g) || [];
}

function midiOf(token) {
  const match = /^([A-G])(#|b)?(\d)$/.exec(token);
  if (!match) throw new Error(`Invalid note: ${token}`);
  const accidental = match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0;
  return 12 * (Number(match[3]) + 1) + pitchClass[match[1]] + accidental;
}

function vlq(value) {
  let buffer = value & 0x7f;
  const out = [];
  while ((value >>= 7)) buffer = (buffer << 8) | ((value & 0x7f) | 0x80);
  while (true) {
    out.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>= 8;
    else return out;
  }
}

const be16 = value => [(value >>> 8) & 0xff, value & 0xff];
const be32 = value => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];

function metaText(type, text) {
  const bytes = new TextEncoder().encode(text);
  return [0xff, type, ...vlq(bytes.length), ...bytes];
}

const events = [];
let tick = 0;
for (const [lyric, notation, phraseGap, finalDuration] of phrases) {
  events.push({ tick, order: 0, bytes: metaText(0x05, lyric) });
  const tokens = parseNotation(notation);
  const noteTokenIndexes = tokens
    .map((token, index) => token === ',' ? -1 : index)
    .filter(index => index >= 0);
  const lastTokenIndex = noteTokenIndexes.at(-1);

  tokens.forEach((token, index) => {
    if (token === ',') return;
    const beforeComma = tokens[index + 1] === ',';
    const duration = index === lastTokenIndex ? finalDuration : beforeComma ? QUARTER : EIGHTH;
    const pitch = midiOf(token);
    events.push({ tick, order: 2, bytes: [0x90, pitch, 92] });
    events.push({ tick: tick + Math.max(1, duration - 18), order: 1, bytes: [0x80, pitch, 0] });
    tick += duration;
  });
  tick += phraseGap;
}

events.sort((a, b) => a.tick - b.tick || a.order - b.order);
const micros = Math.round(60000000 / BPM);
const track = [
  0, ...metaText(0x03, 'Premalokadinda Tanda - melody'),
  0, 0xff, 0x51, 0x03, (micros >>> 16) & 0xff, (micros >>> 8) & 0xff, micros & 0xff,
  0, 0xff, 0x58, 0x04, 4, 2, 24, 8,
  0, 0xc0, 0x00,
];

let previous = 0;
for (const event of events) {
  track.push(...vlq(event.tick - previous), ...event.bytes);
  previous = event.tick;
}
track.push(...vlq(Math.max(0, tick - previous)), 0xff, 0x2f, 0x00);

const midi = Uint8Array.from([
  0x4d, 0x54, 0x68, 0x64, ...be32(6), ...be16(0), ...be16(1), ...be16(TPQ),
  0x4d, 0x54, 0x72, 0x6b, ...be32(track.length), ...track,
]);

const toolDir = dirname(fileURLToPath(import.meta.url));
const outputDir = resolve(toolDir, '..', '..', 'Files');
await mkdir(outputDir, { recursive: true });
const output = resolve(outputDir, 'Premalokadinda_Proper_Timing.mid');
await writeFile(output, midi);
console.log(JSON.stringify({
  output,
  bytes: midi.length,
  notes: events.filter(event => event.bytes[0] === 0x90).length,
  bpm: BPM,
  durationSeconds: Number((tick / TPQ * 60 / BPM).toFixed(2)),
}));
