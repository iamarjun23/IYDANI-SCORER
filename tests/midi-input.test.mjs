// The live-MIDI pitch mapping — the one the app actually runs.
//
// This used to drive a pure midiToWritten() in midi-input.js that NOTHING
// called: the live path has long gone through writtenFor() in piano.js, and
// the two had drifted into opposite behaviours (one folded an out-of-range key
// into the staff, the other refused to write it) with every assertion here
// passing. So the subject is now writtenFor()/writtenNoteFor() themselves.
//
// What a physical key writes must agree with what that written note sounds
// back as, otherwise the player hears one note and reads another.

import assert from 'node:assert/strict';
import { state } from '../src/renderer/state.js';
import { writtenFor, deviceFreq, deviceShift } from '../src/renderer/piano.js';
import { writtenNoteFor } from '../src/renderer/midi-input.js';
import { semiOf } from '../src/renderer/config.js';
import { writableWindow } from '../src/renderer/midi-device.js';

let checks = 0;
const is = (a, b, m) => { checks++; assert.equal(a, b, m); };

// A device whose name says 61 keys, so the window lands where the drawing
// says it does and the numbers below are stable.
function device({ name = 'Keystation 61', saMidi = 60, override = null } = {}) {
  state.midiDeviceName = name;
  state.midiKeyOverride = override;
  state.saMidi = saMidi;
  state.midiLearned = { low: null, high: null };
  state.midiShiftKey = null;          // drop the latch, as a new device would
  state.midiShift = 0;
}

const midiOfFreq = f => Math.round(69 + 12 * Math.log2(f / 440));

// ---------- every writable key reads back as itself ----------

device();
const win = writableWindow(60, deviceShift());
for (let midi = win.low; midi <= win.high; midi++) {
  const w = writtenNoteFor(midi);
  assert.ok(w, `MIDI ${midi} is inside the window but was not placed`);
  is(semiOf(w.svaraIndex, w.head), w.semi,
    `MIDI ${midi} writes a note that sounds ${semiOf(w.svaraIndex, w.head)}, not ${w.semi}`);
  assert.ok(w.oct >= -1 && w.oct <= 1, `MIDI ${midi} landed in sthayi ${w.oct}`);
}

// ---------- a C major scale is written as a C major scale ----------
//
// Not snapped to Mayamalavagowla, which is what the on-screen piano's
// nearest-scale table would do with the naturals it does not carry.

const major = [60, 62, 64, 65, 67, 69, 71, 72];
assert.deepEqual(
  major.map(m => { const w = writtenNoteFor(m); return semiOf(w.svaraIndex, w.head) + 12 * w.oct; }),
  major.map(m => m - 60),
);
checks++;

// ---------- octave is floor division from Sa, and the boundary is Sa ----------

is(writtenFor(60).oct, 0);      // madhya Sa
is(writtenFor(71).oct, 0);      // madhya Ni
is(writtenFor(72).oct, 1);      // taara Sa
is(writtenFor(59).oct, -1);     // mandra Ni
is(writtenFor(48).oct, -1);     // mandra Sa

// ---------- black keys write the variant with a filled goli ----------

const black = { 61: 1, 63: 2, 66: 3, 68: 5, 70: 6 };   // MIDI -> svara index
for (const [midi, svaraIndex] of Object.entries(black)) {
  const w = writtenNoteFor(+midi);
  is(w.head, 'f', `MIDI ${midi} should write a filled goli`);
  is(w.svaraIndex, svaraIndex);
}
// ...and white keys the natural with a hollow one.
for (const midi of [60, 62, 64, 65, 67, 69, 71]) is(writtenNoteFor(midi).head, 'o');

// ---------- outside the window a key is HEARD, not written ----------
//
// It is not folded in. The dock draws such a key with no svara on it, and a
// key whose label promises it writes nothing must not quietly write something.

is(writtenFor(win.low - 1), null, 'a key below the window writes nothing');
is(writtenFor(win.high + 1), null, 'a key above the window writes nothing');
is(writtenNoteFor(win.high + 1), null);

// ---------- pitch is intervallic from Sa, not from middle C ----------

device({ saMidi: 62 });
const inD = writtenNoteFor(62);
is(inD.svaraIndex, 0);
is(inD.semi, 0);
is(inD.oct, 0);
is(inD.head, 'o');
// And C below it is Ni of the mandra sthayi, not Sa.
is(writtenFor(60).oct, -1);
is(writtenFor(60).semi, 10);

// ---------- REGRESSION: a played note must not move the writable window ----------
//
// deviceRange() widens as keys get played, and auto-centre used to be
// recomputed from it on every note. So one stray low key re-pitched the whole
// keyboard mid-take: before it, middle C wrote madhya Sa; after it, the same
// key wrote taara Sa. Widening the DRAWN keyboard is right — it is a picture.
// Moving the window is not, because the player is holding the same keys.

device({ name: 'KOMPLETE KONTROL M32' });
const beforeShift = deviceShift();
const beforeC = writtenFor(60);

// What noteOn() does: widen the tracker, publish it, then place.
state.midiLearned = { low: 24, high: 79 };

is(deviceShift(), beforeShift, 'a played note moved the auto-centre shift');
assert.deepEqual(writtenFor(60), beforeC, 'a played note re-pitched middle C');
checks++;

// Picking a size in the dock IS allowed to re-centre — that is the escape hatch.
state.midiKeyOverride = 88;
assert.notEqual(state.midiShiftKey, null);
checks++;

// ---------- REGRESSION: no pitch cliff at the edge of the window ----------
//
// A writable key sounds the note the staff shows, which is the key transposed
// by the auto-centre shift. An unwritable one used to sound its own
// untransposed pitch, so an ascending physical scale fell 11 semitones the
// moment it crossed the edge: keys 69,70,71 sounded 81,82,83 and key 72
// sounded 72.

device({ name: 'Digital Piano' });
state.midiLearned = { low: null, high: null };
state.midiShiftKey = null;
state.midiShift = -1;                     // latch a shift so the bug can show
state.midiShiftKey = 'Digital Piano||60';

const edge = writableWindow(60, -1);
for (const m of [edge.high - 1, edge.high, edge.high + 1, edge.high + 2]) {
  is(midiOfFreq(deviceFreq(m)), m + 12,
    `key ${m} sounds ${midiOfFreq(deviceFreq(m))}, breaking the run across the window edge`);
}
// Consecutive keys are always one semitone apart, written or not.
for (let m = edge.high - 3; m < edge.high + 3; m++) {
  is(midiOfFreq(deviceFreq(m + 1)) - midiOfFreq(deviceFreq(m)), 1,
    `keys ${m} and ${m + 1} are not a semitone apart`);
}

console.log(`midi-input: ${checks} checks passed`);
