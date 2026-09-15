import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMidiFile } from '../src/renderer/midi-file.js';

const phrases = [
  // Prelude
  { notes: 'SRgSN', start: 60 },
  { notes: 'SRgSNPPMgRg', start: 60 },
  { notes: 'PMgRSRgMPdnS', start: 55 },
  { notes: 'SRgSN', start: 60 },
  { notes: 'SRgSNMPdnSndndP', start: 60 },
  { notes: 'ndPMgRS', start: 58 },
  { notes: 'SRgMPdnSR', start: 48, sectionEnd: true },

  // Second prelude
  { notes: 'PdPgSNMg', start: 67 },
  { notes: 'PndPgSNMdPMg', start: 67 },
  { notes: 'MPMgRggMgRgRRgRSNSP', start: 65 },
  { notes: 'RgRSNRS', start: 62, sectionEnd: true },

  // Anisuthide Yaako Indu
  { notes: 'PdPgSPPMdP', start: 67 },
  { notes: 'PSSSNSPPPMd', start: 67 },
  { notes: 'PdPgSPMdPP', start: 67 },
  { notes: 'PSSSNSPPPMd', start: 67 },
  { notes: 'MMgRgMMMMndP', start: 65 },
  { notes: 'PRRSRgRSnSgSnd', start: 67 },
  { notes: 'NNSRSRPdPMgP', start: 59 },
  { notes: 'gggMMndPPMgRggMMndP', start: 63 },
  { notes: 'ggMMndPPdMPgMRggMnSdP', start: 63 },
  { notes: 'SSSSSRNSNdPPP', start: 60 },
  { notes: 'SRRRRRRgSRRRR', start: 60 },
  { notes: 'MgPMgRgMMMndP', start: 65 },
  { notes: 'PRRSRgRSnSgSnd', start: 67 },
  { notes: 'NNSRSRPdPMgP', start: 59, sectionEnd: true },
];

const tone = {
  S: { pc: 0, svaraIndex: 0, head: 'o' },
  R: { pc: 2, svaraIndex: 1, head: 'o' },
  g: { pc: 3, svaraIndex: 2, head: 'f' },
  M: { pc: 5, svaraIndex: 3, head: 'o' },
  P: { pc: 7, svaraIndex: 4, head: 'o' },
  d: { pc: 8, svaraIndex: 5, head: 'f' },
  n: { pc: 10, svaraIndex: 6, head: 'f' },
  N: { pc: 11, svaraIndex: 6, head: 'o' },
};

function nearestMidi(pc, previous) {
  const candidates = [];
  for (let midi = 48 + pc; midi <= 83; midi += 12) candidates.push(midi);
  return candidates.sort((a, b) => Math.abs(a - previous) - Math.abs(b - previous) || b - a)[0];
}

const scoreNotes = [];
for (const phrase of phrases) {
  const symbols = [...phrase.notes].filter(symbol => tone[symbol]);
  let midi = phrase.start;
  symbols.forEach((symbol, index) => {
    const spec = tone[symbol];
    if (index > 0) midi = nearestMidi(spec.pc, midi);
    if (midi % 12 !== spec.pc) throw new Error(`Bad starting pitch for ${phrase.notes}`);
    const last = index === symbols.length - 1;
    scoreNotes.push({
      type: 'note',
      svaraIndex: spec.svaraIndex,
      oct: Math.floor((midi - 60) / 12),
      head: spec.head,
      sym: last ? 'bindu' : 'vasu',
      dot: false,
      dur: last ? 1 : 0.5,
      deco: last ? 'none' : 'bar1',
    });
  });
  scoreNotes.push(phrase.sectionEnd
    ? { type: 'rest', sym: 'rest_5', dur: 2 }
    : { type: 'rest', sym: 'rest_2', dur: 0.5 });
}

const title = 'Anisuthide Yaako Indu';
const bpm = 72;
const dng = {
  title,
  tala: 'adi',
  scale: 'Mayamalavagowla',
  bpm,
  saMidi: 60,
  notes: scoreNotes,
  bars: [],
  transcription: 'User-provided svara transcription; vasu notes with phrase-ending bindu holds.',
};

const toolDir = dirname(fileURLToPath(import.meta.url));
const outputDir = resolve(toolDir, '..', '..', 'Files');
await mkdir(outputDir, { recursive: true });
await writeFile(resolve(outputDir, 'Anisuthide_Yaako_Indu.dng.json'), JSON.stringify(dng, null, 2));
await writeFile(resolve(outputDir, 'Anisuthide_Yaako_Indu.mid'), buildMidiFile(
  scoreNotes.map((n, i) => ({ n, i, at: i })),
  { bpm, saMidi: 60, title },
));

console.log(`Generated ${scoreNotes.length} score events in ${outputDir}`);
