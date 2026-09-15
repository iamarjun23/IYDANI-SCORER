// What the connected MIDI keyboard actually LOOKS like, and where the staff's
// writable range sits on it.
//
// Web MIDI does not say how many keys a device has — a MIDIInput carries id,
// name, manufacturer and state, and nothing else. So the key count is worked
// out three ways, in order of how much they can be trusted:
//
//   picked   the size chosen in the dock — exact, and beats everything
//   name     parsed out of the device name ("M32", "Keystation 61", "MPK249")
//   default  a plain 49 when neither of those knows
//
// and then WIDENED by what has actually been played: a note outside the drawn
// range proves the range is too small, whatever any of the three said. That is
// the one source that cannot be wrong, so it always wins outward.
//
// Pure — no DOM, no Web MIDI, no state mutation beyond the tracker it is
// handed — so tests/midi-device.test.mjs drives all of it.

// The staff writes three sthayis: 36 semitones, mandra Sa to taara Ni.
export const WRITABLE_SPAN = 36;

// Sizes a keyboard is actually sold in, and the note each one starts on.
// Small controllers start on C; the two full sizes do not.
export const STANDARD_SIZES = [25, 32, 37, 49, 61, 76, 88];
const LOW_NOTE = {
  25: 48,   // C3
  32: 48,   // C3
  37: 48,   // C3
  49: 36,   // C2
  61: 36,   // C2
  76: 28,   // E1
  88: 21,   // A0
};
export const DEFAULT_KEYS = 49;

const WHITE_PC = new Set([0, 2, 4, 5, 7, 9, 11]);
export const isWhiteNote = midi => WHITE_PC.has(((midi % 12) + 12) % 12);

// ---------- where a black key actually sits ----------
//
// A black key is NOT centred on the boundary between the two whites it lies
// between. That is the easy thing to draw and it is not what a keyboard looks
// like: it makes C and E twice as wide at the top as D, and F and B twice as
// wide as G and A, so the two groups read as evenly-spaced combs and the hand
// shape a player reads the keyboard by is gone.
//
// The real rule is that the whites of a GROUP are equal where they are visible
// — the three tops of C-D-E share what the two blacks leave them, and the four
// tops of F-G-A-B share what the three blacks leave them. Working the centres
// back out of that gives an offset from the boundary that depends on nothing
// but the black key's own width `b` (in white widths):
//
//   C#  -b/6      D#  +b/6
//   F#  -b/4      G#   0        A#  +b/4
//
// So G# alone lands on its boundary, C#/F# sit left of theirs and D#/A# right
// of theirs — which is exactly what a photograph of a keyboard shows.
export const BLACK_KEY_W = 0.6;          // of a white key's width

const BLACK_NUDGE = {
  1:  -BLACK_KEY_W / 6,
  3:   BLACK_KEY_W / 6,
  6:  -BLACK_KEY_W / 4,
  8:   0,
  10:  BLACK_KEY_W / 4,
};

// Percentages, because both keyboards lay their whites out with flex and place
// the blacks over them absolutely. `after` is the index of the last white
// DRAWN before this black, so a window that starts part-way through an octave
// still measures from the keys it actually has.
export function blackKeyBox(after, whiteCount, midi) {
  const whitePct = 100 / whiteCount;
  const width = whitePct * BLACK_KEY_W;
  const pc = ((midi % 12) + 12) % 12;
  const centre = (after + 1 + (BLACK_NUDGE[pc] ?? 0)) * whitePct;
  return { left: centre - width / 2, width };
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Middle C is C4, which is MIDI 60 — the convention the device's own printed
// key names use.
export function noteName(midi) {
  return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

export function lowNoteFor(count) {
  return LOW_NOTE[count] ?? 36;
}

// Pull a key count out of a device name. Only a standard size counts, so the
// "3" in "MK3" and the "2" in "V2" cannot be mistaken for one.
//
//   "KOMPLETE KONTROL M32"  -> 32   (token is exactly a size)
//   "MPK249"                -> 49   (size is the tail of a model number)
//   "MPK Mini MK3"          -> null (3 is not a size, and 3 is not a tail)
export function guessKeyCount(name) {
  const runs = String(name || '').match(/\d+/g);
  if (!runs) return null;
  // A whole number that IS a size is the strongest reading.
  for (const r of runs) {
    const n = Number(r);
    if (STANDARD_SIZES.includes(n)) return n;
  }
  // Otherwise the last two digits of a longer model number, which is how the
  // Akai/M-Audio families are named.
  for (const r of runs) {
    if (r.length < 3) continue;
    const n = Number(r.slice(-2));
    if (STANDARD_SIZES.includes(n)) return n;
  }
  return null;
}

// ---------- has this keyboard got a velocity sensor? ----------
//
// Web MIDI reports no capabilities, so the only way to know is to watch what
// arrives. A keyboard with no sensor stamps ONE fixed value on every key —
// measured on a CASIO USB-MIDI, every note came in at exactly 100 however hard
// it was struck. A keyboard with a sensor produces a spread almost at once.
//
// So: two different values is proof it HAS one, and one value repeated
// `after` times is proof it has not. Until either lands the verdict is null —
// unknown — and a caller must not write a dynamic it cannot vouch for. That
// asymmetry is the point: guessing "sensitive" stamps invented dynamics onto
// every note, which is precisely the thing addNote() refuses to do for typed
// and clicked notes.
export const VELOCITY_VERDICT_AFTER = 8;

export function newVelocityProbe(verdict = null) {
  return { seen: new Set(), notes: 0, verdict };
}

export function velocitySeen(probe, velocity, after = VELOCITY_VERDICT_AFTER) {
  probe.notes += 1;
  probe.seen.add(velocity);
  if (probe.verdict === null) {
    if (probe.seen.size >= 2) probe.verdict = true;
    else if (probe.notes >= after) probe.verdict = false;
  }
  return probe.verdict;
}

// The velocity to WRITE for this note: the real one once the sensor is proved,
// and nothing at all before that. Null means "no dynamic to record", which is
// what addNote() already does for a note nobody played with a dynamic.
export function velocityToRecord(probe, velocity, after = VELOCITY_VERDICT_AFTER) {
  return velocitySeen(probe, velocity, after) === true ? velocity : null;
}

// The range tracker. One object per session; noteSeen() widens it and is the
// only thing that writes to it.
export function newRangeTracker() {
  return { low: null, high: null };
}

// Empty it again — when the keyboard being listened to CHANGES, and when the
// player asks for the drawn range to be re-measured. Both are cases where what
// is in the tracker was learned about a different instrument, and a tracker
// that only ever widens would carry it across.
export function resetRangeTracker(tracker) {
  if (!tracker) return tracker;
  tracker.low = null;
  tracker.high = null;
  return tracker;
}

export function noteSeen(tracker, midi) {
  if (!tracker || !Number.isFinite(midi)) return tracker;
  if (tracker.low == null || midi < tracker.low) tracker.low = midi;
  if (tracker.high == null || midi > tracker.high) tracker.high = midi;
  return tracker;
}

// The drawn keyboard: which MIDI notes to put on screen, and why.
export function resolveDeviceRange({
  name = '', override = null, learned = null,
} = {}) {
  let count, source;
  if (override && STANDARD_SIZES.includes(override)) { count = override; source = 'picked'; }
  else {
    const guessed = guessKeyCount(name);
    if (guessed) { count = guessed; source = 'name'; }
    else { count = DEFAULT_KEYS; source = 'default'; }
  }

  let low = lowNoteFor(count);
  let high = low + count - 1;

  // Anything played outside that is proof the range is wrong. Widen — never
  // narrow, since a key not yet pressed proves nothing.
  let widened = false;
  if (learned && learned.low != null) {
    if (learned.low < low) { low = learned.low; widened = true; }
    if (learned.high > high) { high = learned.high; widened = true; }
  }

  // Open and close on a white key: a black key at the edge has no white to
  // hang off, the same rule the on-screen piano's window follows.
  while (low > 0 && !isWhiteNote(low)) low--;
  while (high < 127 && !isWhiteNote(high)) high++;

  return {
    low, high,
    keys: high - low + 1,
    source: widened ? `${source}+played` : source,
  };
}

// Where the staff's 36 writable semitones sit on that keyboard.
//
// "Auto-centre": the window is placed over the middle of the device by WHOLE
// octaves, so a 32-key portable is mostly writable without anyone transposing
// anything. Octaves only — shifting by less would change which svara a key
// writes, and the player pressed the key they meant.
export function autoOctaveShift(range, saMidi = 60) {
  if (!range) return 0;
  const deviceMid = (range.low + range.high) / 2;
  const windowMid = saMidi - 12 + (WRITABLE_SPAN - 1) / 2;
  return Math.round((deviceMid - windowMid) / 12);
}

// The writable window in device coordinates: [low, high] inclusive.
export function writableWindow(saMidi = 60, shift = 0) {
  const low = saMidi - 12 + shift * 12;
  return { low, high: low + WRITABLE_SPAN - 1 };
}

export function isWritable(midi, saMidi = 60, shift = 0) {
  const w = writableWindow(saMidi, shift);
  return midi >= w.low && midi <= w.high;
}
