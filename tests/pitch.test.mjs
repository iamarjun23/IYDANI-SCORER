// One notehead, one pitch.
//
// semiOf() is the single answer to "what does this written note sound", and
// every path that makes a sound has to ask it rather than re-deriving the
// rule. addNote() re-derived it and got `head: 'auto'` wrong — it read auto as
// hollow, while notation.js (which DRAWS the goli), the inspector and playback
// all read auto as SVARAS[svi].filled.
//
// That struck R and D and nothing else, because Ri and Da are the only two
// svaras whose auto notehead is the filled one — the base scale is
// Mayamalavagowla, whose Ri and Da are R1 and D1. So a note entered in auto
// sounded R2/D2 on the way in and R1/D1 on the way out, a semitone apart.

import assert from 'node:assert/strict';
import { SVARAS, SVARA_TONES, semiOf, TONE_LETTER } from '../src/renderer/config.js';

let checks = 0;
const is = (a, b, m) => { checks++; assert.equal(a, b, m); };

const NAMES = ['Sa', 'Ri', 'Ga', 'Ma', 'Pa', 'Da', 'Ni'];

// ---------- the twelve svarasthanas, by their standard semitone ----------
//
// Written out rather than derived, so a change to SVARA_TONES has to argue
// with the tuning system rather than quietly redefine it.

const STANDARD = {
  0: 'Sa', 1: 'R1', 2: 'R2', 3: 'G2', 4: 'G3', 5: 'M1',
  6: 'M2', 7: 'P', 8: 'D1', 9: 'D2', 10: 'N2', 11: 'N3',
};

// Ri and Da are the pair the client heard wrong, and the pair every 'auto' bug
// lands on. Pin their four semitones explicitly.
is(semiOf(1, 'f'), 1, 'R1 (filled Ri) must be one semitone above Sa');
is(semiOf(1, 'o'), 2, 'R2 (hollow Ri) must be two semitones above Sa');
is(semiOf(5, 'f'), 8, 'D1 (filled Da) must be eight semitones above Sa');
is(semiOf(5, 'o'), 9, 'D2 (hollow Da) must be nine semitones above Sa');

// ...and the letters printed beside them agree.
is(TONE_LETTER[1], 'r', 'semitone 1 is lettered r (R1)');
is(TONE_LETTER[2], 'R', 'semitone 2 is lettered R (R2)');
is(TONE_LETTER[8], 'd', 'semitone 8 is lettered d (D1)');
is(TONE_LETTER[9], 'D', 'semitone 9 is lettered D (D2)');

// Every semitone is reachable exactly once, hollow or filled.
const reached = new Map();
for (let svi = 0; svi < 7; svi++) {
  for (const head of ['o', 'f']) {
    const semi = semiOf(svi, head);
    if (head === 'f' && SVARA_TONES[svi].variant == null) continue;  // Sa, Pa
    if (!reached.has(semi)) reached.set(semi, `${NAMES[svi]}/${head}`);
  }
}
for (let semi = 0; semi < 12; semi++) {
  assert.ok(reached.has(semi), `semitone ${semi} (${STANDARD[semi]}) cannot be written`);
  checks++;
}

// ---------- 'auto' is the DRAWN notehead, everywhere ----------
//
// notation.js:1141 draws `head === 'f' ? true : head === 'o' ? false :
// SVARAS[svi].filled`. semiOf must resolve auto the same way, or the goli on
// the page and the pitch in the speakers disagree.

for (let svi = 0; svi < 7; svi++) {
  const drawnFilled = SVARAS[svi].filled;
  is(semiOf(svi, 'auto'), semiOf(svi, drawnFilled ? 'f' : 'o'),
    `${NAMES[svi]}: an auto note sounds unlike the goli it is drawn with`);
  is(semiOf(svi, undefined), semiOf(svi, 'auto'),
    `${NAMES[svi]}: a note with no head set sounds unlike an auto one`);
}

// The two that carry it: in Mayamalavagowla, auto Ri is R1 and auto Da is D1.
is(semiOf(1, 'auto'), 1, 'auto Ri must be R1 — the base scale is Mayamalavagowla');
is(semiOf(5, 'auto'), 8, 'auto Da must be D1 — the base scale is Mayamalavagowla');
// ...and they are the ONLY two that differ between auto and hollow, which is
// why every mishandling of auto shows up on R and D alone.
const differ = [];
for (let svi = 0; svi < 7; svi++) if (semiOf(svi, 'auto') !== semiOf(svi, 'o')) differ.push(NAMES[svi]);
assert.deepEqual(differ, ['Ri', 'Da'],
  `auto and hollow differ on ${differ.join(',')} — expected exactly Ri and Da`);
checks++;

// ---------- Ma is the one variant that is SHARP ----------

is(semiOf(3, 'o'), 5, 'M1 is five semitones above Sa');
is(semiOf(3, 'f'), 6, 'M2 is SIX — Ma is the one svara whose variant is raised');

// ---------- Sa and Pa have no variant to write ----------

is(semiOf(0, 'f'), 0, 'Sa has no lowered variant');
is(semiOf(4, 'f'), 7, 'Pa has no lowered variant');

console.log(`pitch: ${checks} checks passed`);

// ---------- the letter row writes THE SCALE ----------
//
// Reported from the field as "R1 and R2 in madhya are replaced, and D1 and D2
// in madhya are replaced" — and they were, on the letter keyboard.
//
// keyboard.js wrote a hollow goli on a plain key and a filled one on Shift,
// for every svara. Mayamalavagowla takes the HOLLOW form of Ga, Ma and Ni but
// the FILLED form of Ri and Da — which is exactly what SVARAS marks — so
// plain-is-hollow was right for five keys and inverted for two. The plain key
// wrote R2 and D2 where the scale has R1 and D1, and Shift wrote R1 and D1:
// interchanged, on those two alone, against every other key on the row.

// What keyboard.js does now, reproduced from SVARAS.
const plainHead = svi => (SVARAS[svi].filled ? 'f' : 'o');
const shiftHead = svi => (SVARAS[svi].filled ? 'o' : 'f');

// The plain row IS the scale, svara for svara.
for (let svi = 0; svi < 7; svi++) {
  is(semiOf(svi, plainHead(svi)), SVARAS[svi].semi,
    `${NAMES[svi]}: the plain key does not write the scale's own svara`);
}
assert.deepEqual(
  [0, 1, 2, 3, 4, 5, 6].map(svi => semiOf(svi, plainHead(svi))),
  [0, 1, 4, 5, 7, 8, 11],
  'the plain letter row must spell Mayamalavagowla — the scale the file is saved as',
);
checks++;

// The four the client named, the right way round.
is(semiOf(1, plainHead(1)), 1, 'plain Ri must be R1');
is(semiOf(1, shiftHead(1)), 2, 'Shift+Ri must be R2');
is(semiOf(5, plainHead(5)), 8, 'plain Da must be D1');
is(semiOf(5, shiftHead(5)), 9, 'Shift+Da must be D2');

// Shift always writes the OTHER one — never the same note twice.
for (let svi = 0; svi < 7; svi++) {
  if (SVARA_TONES[svi].variant == null) continue;      // Sa and Pa: Shift is inert
  assert.notEqual(semiOf(svi, plainHead(svi)), semiOf(svi, shiftHead(svi)),
    `${NAMES[svi]}: Shift writes the same pitch as the plain key`);
  checks++;
}

// And the plain key agrees with the goli the staff draws for an auto note —
// they are the same rule, so a typed note and a preset note match.
for (let svi = 0; svi < 7; svi++) {
  is(semiOf(svi, plainHead(svi)), semiOf(svi, 'auto'),
    `${NAMES[svi]}: a typed note and an auto note disagree`);
}

console.log(`pitch: letter row ok`);
