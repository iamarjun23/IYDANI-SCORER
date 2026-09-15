// The device layer is pure — no Web MIDI, no DOM — so the parts that decide
// what the MIDI keyboard looks like can be driven directly.
//
// Web MIDI reports no key count at all, so these three rules are the whole
// answer: parse the name, widen by what was played, and place the staff's
// 36 writable semitones over the middle of the device by whole octaves.

import assert from 'node:assert/strict';
import {
  WRITABLE_SPAN, STANDARD_SIZES, DEFAULT_KEYS, guessKeyCount, lowNoteFor,
  noteName, isWhiteNote, newRangeTracker, resetRangeTracker, noteSeen, resolveDeviceRange,
  autoOctaveShift, writableWindow, isWritable, blackKeyBox, BLACK_KEY_W,
} from '../src/renderer/midi-device.js';

let checks = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
const ok = (c, m) => { assert.ok(c, m); checks++; };

// ---- names -----------------------------------------------------------------
eq(guessKeyCount('KOMPLETE KONTROL M32'), 32, 'a bare size is read');
eq(guessKeyCount('Keystation 61 MK3'), 61, 'size wins over a trailing MK3');
eq(guessKeyCount('Launchkey Mini 25'), 25, 'Launchkey 25');
eq(guessKeyCount('MPK249'), 49, 'the tail of a model number');
eq(guessKeyCount('Akai MPK Mini MK3'), null, 'MK3 is not a 3-key keyboard');
eq(guessKeyCount('USB MIDI Device'), null, 'no digits, no guess');
eq(guessKeyCount(''), null, 'empty name');
eq(guessKeyCount(undefined), null, 'missing name');
ok(STANDARD_SIZES.every(n => Number.isFinite(lowNoteFor(n))), 'every size has a start note');
eq(lowNoteFor(88), 21, '88 starts at A0');
eq(lowNoteFor(61), 36, '61 starts at C2');

// ---- note names ------------------------------------------------------------
eq(noteName(60), 'C4', 'middle C is C4');
eq(noteName(21), 'A0', 'the bottom of an 88');
eq(noteName(61), 'C#4', 'a black key');
ok(isWhiteNote(60) && !isWhiteNote(61), 'white/black split');

// ---- learning from what was played -----------------------------------------
const t = newRangeTracker();
eq([t.low, t.high], [null, null], 'a fresh tracker knows nothing');
noteSeen(t, 60); noteSeen(t, 48); noteSeen(t, 72);
eq([t.low, t.high], [48, 72], 'it keeps the extremes');
noteSeen(t, 60);
eq([t.low, t.high], [48, 72], 'a note inside changes nothing');
noteSeen(t, NaN);
eq([t.low, t.high], [48, 72], 'junk is ignored');

// ---- resolving the drawn range ---------------------------------------------
const named = resolveDeviceRange({ name: 'M32' });
eq([named.low, named.keys, named.source], [48, 32, 'name'], '32 keys from C3');
ok(isWhiteNote(named.low) && isWhiteNote(named.high), 'the drawn range opens and closes white');

const picked = resolveDeviceRange({ name: 'M32', override: 61 });
eq([picked.keys, picked.source], [61, 'picked'], 'the dock override beats the name');

const unknown = resolveDeviceRange({ name: 'USB MIDI Device' });
eq([unknown.keys, unknown.source], [DEFAULT_KEYS, 'default'], 'unknown falls back to 49');

// A note played outside the drawn range widens it — that is the one source of
// truth that cannot be wrong.
const wide = resolveDeviceRange({ name: 'M32', learned: { low: 36, high: 96 } });
ok(wide.low <= 36 && wide.high >= 96, 'the range grew to cover what was played');
ok(wide.source.endsWith('+played'), 'and says so');

const narrow = resolveDeviceRange({ name: 'M32', learned: { low: 55, high: 60 } });
eq([narrow.low, narrow.keys], [48, 32], 'playing inside never shrinks the keyboard');

// ---- placing the writable window -------------------------------------------
eq(writableWindow(60, 0), { low: 48, high: 83 }, 'Sa=C4 writes C3..B5');
eq(writableWindow(60, 0).high - writableWindow(60, 0).low + 1, WRITABLE_SPAN, '36 semitones');

// A 61-key board from C2 sits low, so the window drops to meet it.
const k61 = resolveDeviceRange({ name: 'Keystation 61' });
const s61 = autoOctaveShift(k61, 60);
const w61 = writableWindow(60, s61);
ok(w61.low >= k61.low && w61.high <= k61.high, 'the window lands inside a 61-key board');

// On a 32-key board the window is wider than the device, so it straddles it.
const k32 = resolveDeviceRange({ name: 'M32' });
const s32 = autoOctaveShift(k32, 60);
const w32 = writableWindow(60, s32);
ok(w32.low <= k32.low && w32.high >= k32.high, '32 keys all fall inside the window');
ok(Number.isInteger(s32), 'the shift is whole octaves');

// Every key of a 32 is therefore writable; the top of an 88 is not.
const k88 = resolveDeviceRange({ name: 'Keystation 88' });
const s88 = autoOctaveShift(k88, 60);
let writable = 0;
for (let m = k88.low; m <= k88.high; m++) if (isWritable(m, 60, s88)) writable++;
eq(writable, WRITABLE_SPAN, 'an 88 has exactly 36 writable keys');
for (let m = k32.low; m <= k32.high; m++) ok(isWritable(m, 60, s32), `32-key note ${m} is writable`);

// ---- one stray note, and the way back from it -------------------------------
//
// Reported from the field as two keys below C2 on a keyboard that starts at
// C2. The mechanism is the ratchet: a single note from below the instrument —
// a second port being listened to, a device left transposed, an octave button
// pressed by accident — is treated as proof the drawn keyboard is too small,
// and nothing ever narrows it again. It survives the relaunch, because the
// store is what makes the measurement worth having.
{
  const t = newRangeTracker();
  const clean = resolveDeviceRange({ name: 'Keystation 61', learned: t });
  eq([clean.low, clean.high], [36, 96], 'a 61 starts on C2');

  noteSeen(t, 34);                          // one A#1, from wherever
  const dirty = resolveDeviceRange({ name: 'Keystation 61', learned: t });
  eq(dirty.low, 33, 'the stray note opens the keyboard on the white below it');
  const whites = r => {
    let n = 0;
    for (let m = r.low; m <= r.high; m++) if (isWhiteNote(m)) n++;
    return n;
  };
  eq(whites(dirty) - whites(clean), 2, 'which is the two extra keys that were reported');
  eq(dirty.source, 'name+played', 'and the dock can say where they came from');

  // Picking a size cannot shift them on its own — the learned range widens
  // straight back past whatever count is chosen. That is why the picker
  // forgets first, and why forgetting has to exist at all.
  const picked = resolveDeviceRange({ name: 'Keystation 61', override: 61, learned: t });
  eq(picked.low, 33, 'a picked size alone does not undo a learned note');

  resetRangeTracker(t);
  eq(t, { low: null, high: null }, 'the tracker empties');
  const fixed = resolveDeviceRange({ name: 'Keystation 61', override: 61, learned: t });
  eq([fixed.low, fixed.high], [36, 96], 'and the keyboard is a 61 again');
  eq(fixed.source, 'picked', 'stated as picked, with nothing played into it');
}

// ---- where the black keys sit ----------------------------------------------
//
// The failure this pins is one nobody can see in a number: a black key centred
// on the boundary between its two whites draws a keyboard whose C and E tops
// are twice the width of D, and whose F and B tops are twice G and A. It reads
// as an evenly-spaced comb, not as a keyboard, and it is what the drawn dock
// shipped with. What the rule guarantees is the thing a player actually reads
// the keyboard by: within a GROUP the visible white tops are all the same
// width. So that is what is measured here, off the boxes themselves.

// One octave of whites, so a percentage is a white-key width / 7 * 100.
const OCT = 100 / 7;
const box = (after, midi) => blackKeyBox(after, 7, midi);

// The tops of C, D, E — the black keys of the 2-group take their bites out of
// the middle of a 3-white span.
{
  const cs = box(0, 1), ds = box(1, 3);
  const cTop = cs.left;                       // C's left edge is 0
  const dTop = ds.left - (cs.left + cs.width);
  const eTop = 3 * OCT - (ds.left + ds.width);
  ok(Math.abs(cTop - dTop) < 1e-9 && Math.abs(dTop - eTop) < 1e-9,
    'C, D and E are the same width where they show');
}

// The tops of F, G, A, B, over a 4-white span starting at 3 white widths.
{
  const fs = box(3, 6), gs = box(4, 8), as = box(5, 10);
  const fTop = fs.left - 3 * OCT;
  const gTop = gs.left - (fs.left + fs.width);
  const aTop = as.left - (gs.left + gs.width);
  const bTop = 7 * OCT - (as.left + as.width);
  ok([gTop, aTop, bTop].every(t => Math.abs(t - fTop) < 1e-9),
    'F, G, A and B are the same width where they show');
}

// G# is the one black key that DOES land on its boundary — the sign the rule
// is the real keyboard's and not an arbitrary nudge.
{
  const gs = box(4, 8);
  eq(gs.left + gs.width / 2, 5 * OCT, 'G# is centred on the G/A boundary');
  const cs = box(0, 1), as = box(5, 10);
  ok(cs.left + cs.width / 2 < OCT, 'C# sits left of the C/D boundary');
  ok(as.left + as.width / 2 > 6 * OCT, 'A# sits right of the A/B boundary');
}

// Nothing may hang off either end, whatever window it is drawn in.
for (const n of [7, 15, 36, 52]) {
  for (let midi = 0; midi < 12 * 5; midi++) {
    if (isWhiteNote(midi)) continue;
    let after = -1, whites = 0;
    for (let m = 0; m < 12 * 5; m++) {
      if (!isWhiteNote(m)) continue;
      if (whites >= n) break;
      if (m < midi) after = whites;
      whites++;
    }
    if (after < 0 || after + 1 >= n) continue;
    const b = blackKeyBox(after, n, midi);
    ok(b.left >= 0 && b.left + b.width <= 100.0000001,
      `black key ${midi} stays on the keyboard at ${n} whites`);
    eq(b.width, (100 / n) * BLACK_KEY_W, 'a black key is a fixed share of a white');
  }
}

console.log(`midi-device: ${checks} checks passed`);
