import assert from 'node:assert/strict';
import { buildMidiFile } from '../src/renderer/midi-file.js';
import {
  SEMI_TO_WRITTEN, glyphForUnits, noteFor, restsFor, parseMidi, pickMelody, midiToScore,
  scoreGroup, octaveShiftFor,
} from '../src/renderer/midi-import.js';
import { semiOf, SOUND, REST_MAP, TIME_UNITS_PER_BEAT, DOT_MULT } from '../src/renderer/config.js';
import { scoreRows } from '../src/renderer/notation.js';

// Weight of a written glyph, read the way the packer reads it: a rest carries a
// rest key, so resolve that back to the sound it stands for.
const unitsOf = (n) => {
  const sound = n.type === 'rest' ? (REST_MAP[n.sym] || 'bindu') : n.sym;
  return Math.round(SOUND[sound].dur * (n.dot ? DOT_MULT : 1) * TIME_UNITS_PER_BEAT);
};

// ---------- pitch: every semitone is writable, and sounds back as itself ----------

for (let pc = 0; pc < 12; pc++) {
  const w = SEMI_TO_WRITTEN[pc];
  assert.ok(w, `semitone ${pc} has no written form`);
  assert.equal(semiOf(w.svaraIndex, w.head), pc, `semitone ${pc} sounds as ${semiOf(w.svaraIndex, w.head)}`);
}

// A C major scale from middle C must come back as itself, not snapped to
// Mayamalavagowla (the old converter returned C C# E F G Ab B).
const major = [60, 62, 64, 65, 67, 69, 71, 72];
const written = major.map(m => noteFor(m, 8, 60));
assert.deepEqual(
  written.map(n => semiOf(n.svaraIndex, n.head) + 12 * n.oct),
  major.map(m => m - 60),
);

// Octave is a floor division: madhya Pa stays madhya.
assert.equal(noteFor(67, 8, 60).oct, 0);
assert.equal(noteFor(71, 8, 60).oct, 0);
assert.equal(noteFor(72, 8, 60).oct, 1);
assert.equal(noteFor(59, 8, 60).oct, -1);
assert.equal(noteFor(48, 8, 60).oct, -1);
// Out of the three sthayis, fold to the nearest one rather than transposing.
assert.equal(noteFor(96, 8, 60).oct, 1);
assert.equal(noteFor(24, 8, 60).oct, -1);

// A non-default Sa moves the whole mapping with it.
assert.equal(semiOf(noteFor(62, 8, 62).svaraIndex, noteFor(62, 8, 62).head), 0);

// ---------- duration: the glyph carries the weight it claims ----------

assert.equal(glyphForUnits(8).sym, 'bindu');
assert.equal(glyphForUnits(4).sym, 'vasu');
assert.equal(glyphForUnits(1).sym, 'danta');
assert.equal(glyphForUnits(16).sym, 'guru');
assert.equal(glyphForUnits(32).sym, 'Maguru');
const dotted = glyphForUnits(12);
assert.equal(dotted.sym, 'bindu');
assert.equal(dotted.dot, true);
for (const u of [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48]) {
  assert.equal(glyphForUnits(u).units, u, `${u} units is writable exactly`);
}
for (const n of [noteFor(60, 4), noteFor(60, 12), noteFor(60, 32)]) {
  assert.equal(unitsOf(n), glyphForUnits(unitsOf(n)).units);
}

// Rests fill a span exactly.
assert.equal(restsFor(11).reduce((a, r) => a + r.units, 0), 11);
assert.equal(restsFor(8).length, 1);
assert.ok(restsFor(8)[0].sym in { rest_symbol_1: 1, rest_2: 1, rest_3: 1, rest4: 1, rest_5: 1, rest_6: 1 });

// ---------- parsing ----------

// Round-trip: what MIDI export writes, MIDI import must read back.
const seq = [
  { n: { type: 'note', svaraIndex: 0, head: 'o', oct: 0, dur: 1 } },   // Sa  60
  { n: { type: 'note', svaraIndex: 1, head: 'o', oct: 0, dur: 1 } },   // Ri  62
  { n: { type: 'note', svaraIndex: 2, head: 'o', oct: 0, dur: 2 } },   // Ga  64
  { n: { type: 'note', svaraIndex: 4, head: 'o', oct: 1, dur: 1 } },   // Pa' 79
];
const file = buildMidiFile(seq, { bpm: 72, saMidi: 60, title: 'round trip' });
const parsed = parseMidi(file);
assert.equal(parsed.notes.length, 4);
assert.equal(Math.round(parsed.bpm), 72);
assert.deepEqual(parsed.notes.map(n => n.midi), [60, 62, 64, 79]);

const score = midiToScore(file, { saMidi: 60 });
assert.equal(score.bpm, 72);
const heard = score.notes
  .filter(n => n.type === 'note')
  .map(n => 60 + semiOf(n.svaraIndex, n.head) + 12 * n.oct);
assert.deepEqual(heard, [60, 62, 64, 79], 'imported pitches match the exported ones');
const durs = score.notes.filter(n => n.type === 'note').map(unitsOf);
assert.deepEqual(durs, [8, 8, 16, 8], 'imported durations match the exported ones');

// ---------- polyphony reduces to the top voice ----------

const chord = pickMelody([
  { start: 0, end: 480, midi: 72, track: 1, channel: 0 },
  { start: 0, end: 480, midi: 64, track: 1, channel: 0 },
  { start: 0, end: 480, midi: 60, track: 1, channel: 0 },
  { start: 480, end: 960, midi: 74, track: 1, channel: 0 },
]);
assert.deepEqual(chord.map(n => n.midi), [72, 74]);

// A sustained bass under a melody is dropped, not interleaved.
const withBass = pickMelody([
  { start: 0, end: 1920, midi: 72, track: 1, channel: 0 },
  { start: 0, end: 1920, midi: 48, track: 1, channel: 0 },
  { start: 480, end: 960, midi: 74, track: 1, channel: 0 },
]);
assert.deepEqual(withBass.map(n => n.midi), [72, 74]);

// The drum channel is never the melody.
const drums = pickMelody([
  { start: 0, end: 240, midi: 36, track: 1, channel: 9 },
  { start: 240, end: 480, midi: 38, track: 1, channel: 9 },
  { start: 0, end: 480, midi: 67, track: 2, channel: 0 },
]);
assert.deepEqual(drums.map(n => n.midi), [67]);

// A thin high line beats a busier chord part, whatever the note counts say —
// an arpeggiated accompaniment always has more notes than the tune over it.
{
  const lead = [];
  for (let i = 0; i < 40; i++) lead.push({ start: i * 240, end: i * 240 + 220, midi: 76 + (i % 5) });
  const pad = [];
  for (let i = 0; i < 120; i++) {
    const at = Math.floor(i / 3) * 240;
    pad.push({ start: at, end: at + 700, midi: 52 + (i % 3) * 4 });   // three-note chords
  }
  assert.ok(scoreGroup(lead) > scoreGroup(pad), 'the thin high line wins on shape alone');
  // ...and a file that labels its parts is believed.
  assert.ok(scoreGroup(pad, 'Right hand melody') > scoreGroup(pad, 'Left hand'));
}

// ---------- register: shift by octaves rather than folding notes ----------

// A line an octave above what the staff can write is moved down whole, not
// folded a note at a time — folding breaks the contour mid-phrase.
assert.equal(octaveShiftFor([76, 79, 81, 88, 85], 60), -1);
// Leave a line that already fits exactly where it is.
assert.equal(octaveShiftFor([60, 62, 64, 67, 72], 60), 0);
assert.equal(octaveShiftFor([48, 55, 60, 71, 83], 60), 0);
// The tonic moves the window with it.
assert.equal(octaveShiftFor([76, 79, 81, 88, 85], 72), 0);

// ---------- gaps become rests ----------

const gapped = buildMidiFile([
  { n: { type: 'note', svaraIndex: 0, head: 'o', oct: 0, dur: 1 } },
  { n: { type: 'rest', dur: 1 } },
  { n: { type: 'note', svaraIndex: 4, head: 'o', oct: 0, dur: 1 } },
], { bpm: 96, saMidi: 60, title: 'gap' });
const gapScore = midiToScore(gapped, { saMidi: 60 });
assert.ok(gapScore.notes.some(n => n.type === 'rest'), 'the silent beat comes back as a rest');
assert.equal(gapScore.notes.reduce((a, n) => a + unitsOf(n), 0), 24, 'total written time is 3 beats');

// ---------- the packer can lay out what the converter writes ----------

// Sub-beat durations are the whole point of the rewrite, so put a mixed-weight
// import through scoreRows() and check nothing is lost at a box edge.
const mixed = buildMidiFile([
  { n: { type: 'note', svaraIndex: 0, head: 'o', oct: 0, dur: 0.25 } },
  { n: { type: 'note', svaraIndex: 1, head: 'f', oct: 0, dur: 0.25 } },
  { n: { type: 'note', svaraIndex: 2, head: 'o', oct: -1, dur: 0.5 } },
  { n: { type: 'note', svaraIndex: 6, head: 'o', oct: 1, dur: 3 } },
  { n: { type: 'note', svaraIndex: 4, head: 'o', oct: 0, dur: 2 } },
], { bpm: 100, saMidi: 60, title: 'mixed' });
const mixedScore = midiToScore(mixed, { saMidi: 60 });
assert.deepEqual(
  mixedScore.notes.filter(n => n.type === 'note').map(unitsOf),
  [2, 2, 4, 24, 16],
  'quarter, quarter, eighth, dotted-guru and guru all survive',
);
const rows = scoreRows(mixedScore.notes, []);
const written2 = rows.flatMap(r => r.boxes).flatMap(b => b.entries);
assert.ok(written2.length >= mixedScore.notes.length, 'every glyph reaches a box');
assert.equal(
  written2.filter(e => e.note.type === 'note' && !e.tie).length,
  mixedScore.notes.filter(n => n.type === 'note').length,
  'no note is dropped or double-attacked at a box edge',
);

// ---------- unison doubling must not bury the melody ----------

// Two parts playing the same line into one channel put TWO note-ons on the same
// pitch at the same tick. parseMidi's stuck-note guard closed the first one
// there, yielding a note with start === end; coveredTime() then sorted its close
// before its open, so it entered `active` and never left. `top` stayed pinned at
// that pitch for the whole rest of the file and every real note below it scored
// as fully covered — the melody thinned out as the doublings accumulated and
// then stopped altogether. On a real file (Vivaldi's Winter) that silently threw
// away the last 20 bars and 40% of the notes, with the suite green throughout.
{
  const vlq = (v) => (v < 0x80 ? [v] : [0x80 | (v >> 7), v & 0x7f]);
  const track = [];
  // A rising line, every note DOUBLED in unison, then a lower line after it.
  const seq = [72, 74, 76, 77, 79, 60, 62, 64, 65, 67];
  for (const midi of seq) {
    track.push(...vlq(0), 0x90, midi, 64);
    track.push(...vlq(0), 0x90, midi, 64);      // the doubling: same tick, same pitch
    track.push(...vlq(120), 0x80, midi, 0);
    track.push(...vlq(0), 0x80, midi, 0);
  }
  track.push(...vlq(0), 0xff, 0x2f, 0x00);
  const be32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  const file = Uint8Array.from([
    0x4d, 0x54, 0x68, 0x64, ...be32(6), 0, 0, 0, 1, 0, 120,
    0x4d, 0x54, 0x72, 0x6b, ...be32(track.length), ...track,
  ]);

  const parsed = parseMidi(file);
  assert.equal(
    parsed.notes.filter(n => n.end <= n.start).length, 0,
    'a doubled unison must not produce a zero-length note',
  );
  const line = pickMelody(parsed.notes, new Map());
  assert.deepEqual(
    line.map(n => n.midi), seq,
    'every doubled note survives, including the ones below an earlier doubling',
  );
  // The tail is the part the stuck ceiling used to eat: it sits an octave below
  // the head of the line, so a pinned `top` would have dropped all of it.
  assert.ok(
    line.some(n => n.midi === 67 && n.start === 9 * 120),
    'the line still reaches its last note',
  );
}

// ---------- garbage in ----------

assert.throws(() => parseMidi(new Uint8Array([1, 2, 3, 4])), /MThd/);

console.log('MIDI import tests passed');
