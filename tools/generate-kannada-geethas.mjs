// Purandara Dasa's Malahari geethas as .dng.json scores, into songs/.
//
// Malahari (S R1 M1 P D1 S / S D1 P M1 G3 R1 S) is a janya of Mayamalavagowla,
// the app's base scale, so every svara takes its scale notehead.
//
// Notation: one svara per akshara, `,` holds the previous svara one more
// akshara, a trailing ' is taara and a trailing . is mandra; `|` is ignored.
// Sri Gananatha is the NIOS Carnatic Music course text (KCM-4); Kunda Gowra is
// dhanyasy.org's, whose taara marks were not printed and are restored where
// the phrase descends onto D P.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SVARAS } from '../src/renderer/config.js';

// Geetham Rupaka is counted drutam first: 2 + 4.
const timeSig = { key: 'rupaka_geetham', label: 'RUPAKA (GEETHAM)', formula: '2+4', groups: [2, 4] };

const lambodara = [
  "S R | M , G R | S R | G R S ,",
  "R M | P D M P | D P | M G R S",
  "S R | M , G R | S R | G R S ,",
];

const songs = [
  {
    file: 'Sri_Gananatha', title: 'Sri Gananatha',
    lines: [
      "M P | D S' S' R' | R' S' | D P M P", "R M | P D M P | D P | M G R S", ...lambodara,
      "M P | D S' S' R' | R' S' | D P M P", "R M | P D M P | D P | M G R S", ...lambodara,
      "M P | D S' S' R' | R' S' | D P M P", "R M | P D M P | D P | M G R S", ...lambodara,
    ],
  },
  {
    file: 'Kunda_Gowra', title: 'Kunda Gowra',
    lines: [
      "D P | M G R S", "R M | P D M P", "D R' | R' S' D P", "D P | M G R S",
      "S' , | R' , R' ,", "D P | M G R S", "S R | M , G R", "S R | G R S ,",
      "D P | M G R S", "R M | P D M P", "D R' | R' S' D P", "D P | M G R S",
      "D P | M G R S", "R M | P D M P", "D R' | R' S' D P", "D P | M G R S",
    ],
  },
];

const SYMBOL = { 1: ['bindu', false], 2: ['guru', false], 3: ['guru', true], 4: ['Maguru', false] };
const SVARA = 'SRGMPDN';

function parseLine(line) {
  const notes = [];
  for (const tok of line.split(/\s+/)) {
    if (!tok || tok === '|') continue;
    if (tok === ',') {
      const last = notes.at(-1);
      if (!last) throw new Error(`hold with nothing to hold: ${line}`);
      last.dur += 1;
      continue;
    }
    const svaraIndex = SVARA.indexOf(tok[0]);
    if (svaraIndex < 0 || !/^[SRGMPDN]['.]?$/.test(tok)) throw new Error(`bad svara ${tok} in: ${line}`);
    const oct = tok[1] === "'" ? 1 : tok[1] === '.' ? -1 : 0;
    notes.push({ type: 'note', svaraIndex, oct, head: SVARAS[svaraIndex].filled ? 'f' : 'o', dur: 1 });
  }
  return notes.map(n => {
    const [sym, dot] = SYMBOL[n.dur];
    return { ...n, sym, dot, deco: sym === 'guru' ? 'curl' : sym === 'Maguru' ? 'ring' : 'none' };
  });
}

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'songs');
await mkdir(outDir, { recursive: true });
for (const s of songs) {
  const notes = s.lines.flatMap(parseLine);
  const beats = notes.reduce((t, n) => t + n.dur, 0);
  if (beats % 6) throw new Error(`${s.title}: ${beats} aksharas is not whole Rupaka cycles`);
  const dng = {
    title: s.title, tala: timeSig.key, timeSig, scale: 'Mayamalavagowla', bpm: 80, saMidi: 60,
    notes, bars: [], transcription: 'Purandara Dasa, raga Malahari, Rupaka tala — see tools/generate-kannada-geethas.mjs',
  };
  await writeFile(resolve(outDir, `${s.file}.dng.json`), JSON.stringify(dng, null, 2));
  console.log(`${s.file}.dng.json: ${notes.length} notes, ${beats / 6} cycles`);
}
