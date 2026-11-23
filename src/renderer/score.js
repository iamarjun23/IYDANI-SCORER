// Score mutations. Every public function here pushes a history snapshot
// first, then mutates state, then re-renders.

import { state } from './state.js';
import {
  BPM, DOT_MULT, ENTRY_BEAT_MS, HOLD_CAP_BEATS, HOLD_TICK_UNITS, SOUND, REST_MAP,
  SVARAS, beatSeconds,
  SVARA_TONES, PRESETS, PRESET_BPM, TITLES, TIME_UNITS_PER_BEAT, semiOf,
  isFilled, hasVariant, SVARA_RUNG,
} from './config.js';
import { pushHist, updateUndoButtons } from './history.js';
import { pluck, freqOf } from './audio.js';
import { render, renderSoon, padRests, glyphFor } from './notation.js';
import { newBarId, repeatPairs } from './repeat-model.js';
import { lessonKey } from './lesson.js';
import { boxUnits } from './timesig.js';

// Metronome entry state. It stays dormant until the first note is entered
// while the standalone metronome is running.
const metroEntry = {
  armed: false,
  // How many keys are down, not WHETHER one is. A chord releases one key at a
  // time, and a boolean here let the first release un-arm the metronome while
  // the other keys were still sounding — so it started writing rests
  // underneath a note that had not stopped. MIDI makes a chord trivial to
  // play; the on-screen piano reaches the same state with two fingers.
  held: 0,
  // Silence accrued but not yet written, in TIMING UNITS, plus the wall clock
  // it was last measured at. Units, not beats, because a note is worth as
  // little as a danta — an eighth of a beat — so silence measured to the beat
  // could not describe the gaps between the notes it sits among. See
  // accrueIdle().
  idleUnits: 0,
  idleAt: null,
};

// True while any key is still down. Derived, so it cannot disagree with the
// count.
const keyIsHeld = () => metroEntry.held > 0;

// Held notes grow on their own clock, ticking one danta (an eighth of a beat)
// at a time. Each entry accumulates how much time it has actually been held,
// in timing units, rather than counting ticks — so setTimeout drift and a BPM
// change part-way through a hold both come out right.
const heldPromotions = new Map();
// The staff reads this to draw a held note as a length bar (see state.holding).
state.holding = heldPromotions;
let holdTimer = null;

// LIVE ENTRY (state.entering). Starts at the first key, stays on while keys
// keep coming, and ends ENTRY_SETTLE_MS after the last key comes up — at which
// point the page reflows once into its normal spacing, the way Logic tidies
// the score when recording stops rather than on every note.
// ponytail: fixed 1.5 s settle, make it a setting if players pause longer mid-phrase.
const ENTRY_SETTLE_MS = 1500;
let settleTimer = null;
function touchEntry(from) {
  if (!state.entering) { state.entering = true; state.entryFrom = from ?? totalUnits(); }
  clearTimeout(settleTimer);
  settleTimer = null;
  if (heldPromotions.size) return;
  settleTimer = setTimeout(() => {
    settleTimer = null;
    if (heldPromotions.size) return;
    state.entering = false;
    renderSoon();
  }, ENTRY_SETTLE_MS);
}
let holdLast = 0;

// THE TAKE'S GRID — where a key lands is decided by WHEN it was pressed against
// the metronome, the way a DAW records against its bar, not by adding up the
// lengths of everything played before it. `units` is the written position at
// wall time `at`, counted at `beat` ms a beat. Chaining durations let every
// note's rounding carry into the next (hold 4.6 dantas, rest 3.4, and the
// staff ran 0.4 of a danta ahead of the clicks per note); measuring each onset
// from one origin cannot drift. Only under metro fill, the one mode that
// writes the silence a placed onset needs. Rebased on every clock tick so a
// tempo change applies from where it happened.
let grid = null;
let lastClickAt = null;
const TAKE_IDLE_BEATS = 8;
const gridPos = t => grid.units + ((t - grid.at) / grid.beat) * TIME_UNITS_PER_BEAT;
const totalUnits = () => state.notes.reduce((u, n) => u + unitsOfNote(n), 0);

// INPUT QUANTIZE, as Logic's record quantize does it: every edge a key puts on
// the grid — where a note starts, where it ends — is rounded to the chosen
// value instead of to the danta. A danta (1) is the finest the notation writes,
// so it is "off"; praya (2), vasu (4) and bindu (8) are the coarser grids. At
// fast tempos half a danta is under 32 ms, tighter than a player's hands, and
// the staff filled with praya·danta splits nobody meant.
// And, as in Logic, it is NON-DESTRUCTIVE: every recorded note keeps its raw
// edges in `note.take` ({id, from, on, off, at, min}, absolute timing units on
// the take's clock), so requantizeTakes() can re-snap a take at any grid —
// including back to off — after it was played. See requantizeTakes().
const quantum = () => ([1, 2, 4, 8].includes(state.quantize) ? state.quantize : 1);
// The raw onset of the key closeMetronomeSilence() just placed, waiting for
// startHoldPromotion() to learn which note it became.
let pendingRaw = null;
let takeSeq = 0;
const snap = u => Math.round(u / quantum()) * quantum();
// The shortest a recorded note may be: one quantum (and never under a danta).
const minRecorded = () => Math.max(MIN_HOLD_UNITS, quantum());

// The shortest single glyph the notation has — a danta, one unit. Derived
// rather than written as 1 so that adding a shorter SOUND lowers the floor with
// it instead of leaving a value nothing can play.
const MIN_HOLD_UNITS = Math.max(1, Math.min(
  ...Object.values(SOUND).map(v => Math.round(v.dur * TIME_UNITS_PER_BEAT)),
));

const beatMs = () => beatSeconds(state.bpm) * 1000;

// How long ONE BEAT is for ENTRY — how long a key has to be held to earn a
// bindu, and how long a gap has to be to earn a bindu rest. See ENTRY_BEAT_MS
// for why that is a flat second with no metronome running and the tempo when
// there is one.
export const entryBeatMs = () => (state.metroOn ? beatMs() : ENTRY_BEAT_MS);

const holdTickMs = () => (entryBeatMs() / TIME_UNITS_PER_BEAT) * HOLD_TICK_UNITS;
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function stopHoldClock() {
  if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
}

function appendRest(sym) {
  const sound = REST_MAP[sym] || 'bindu';
  const sd = SOUND[sound] || SOUND.bindu;
  state.notes.push({ type: 'rest', sym, dur: sd.dur });
}

// `head` and `oct` default to the sidebar/selector state, but the keyboard
// passes both explicitly: the letter row decides the sthayi, and Shift decides
// whether the goli is filled.
export function addNote(svi, {
  playSound = true, sym = state.sym, head = state.head, oct = state.oct, vel = null,
} = {}) {
  // A lesson is open: the key is sounded and judged, never written.
  if (state.lesson) {
    if (playSound) pluck(freqOf(semiOf(svi, head), oct));
    lessonKey(svi, head, oct);
    return null;
  }
  pushHist();
  state.preset = null;
  const symKey = SOUND[sym] ? sym : 'bindu';
  const sd = SOUND[symKey];
  const note = {
    type: 'note',
    svaraIndex: svi,
    oct,
    head,
    sym:  symKey,
    dot:  false,
    dur:  sd.dur,
    deco: sd.deco,
  };
  // How hard the key was struck, kept only when a KEYBOARD said so. A note
  // typed or clicked has no dynamic to record, and writing a default onto it
  // would make every score claim a dynamic it never played. Saved files carry
  // the field verbatim, so a recorded take exports with its dynamics intact.
  if (vel != null) note.vel = Math.max(1, Math.min(127, Math.round(vel)));
  state.notes.push(note);
  // semiOf() and nothing else — the notehead a note is DRAWN with is what it
  // sounds, and there is one function that answers that.
  //
  // This used to recompute the rule inline and got `head: 'auto'` wrong: it
  // treated auto as hollow, while notation.js, the inspector and playback all
  // read it as SVARAS[svi].filled. Ri and Da are the only two svaras whose
  // auto notehead IS filled — the base scale is Mayamalavagowla — so this
  // struck exactly R and D and nothing else, sounding R2/D2 on entry for a
  // note drawn as R1/D1 and played back as R1/D1.
  if (playSound) pluck(freqOf(semiOf(svi, head), oct));
  state.hlIndex = state.notes.length - 1;
  renderSoon();
  setTimeout(() => { state.hlIndex = null; renderSoon(); }, 230);
  return state.notes.length - 1;
}

// A held key's EXACT length, in dantas. The head is the largest glyph that
// fits and `dur` is the whole hold, so 11 dantas is drawn bindu + praya + danta
// (the layout's greedy walk) and plays 11 dantas — nothing is rounded away.
function setHeldUnits(index, units) {
  const note = state.notes[index];
  if (!note || note.type !== 'note') return;
  if (writeUnits(note, units)) renderSoon();
}

function writeUnits(note, units) {
  const dur = units / TIME_UNITS_PER_BEAT;
  if (note.dur === dur) return false;
  const g = glyphFor(units);
  note.sym = g.sym;
  note.dot = g.dot;
  note.deco = SOUND[g.sym].deco;
  note.dur = dur;
  return true;
}

// Edit a note's played length from the inspector. Durations are stored in the
// same eighth-beat units used by notation and playback, so arbitrary values
// still reflow cleanly across boxes and remain undoable.
export function setNoteDuration(index, beats) {
  const note = state.notes[index];
  const n = Math.round(Number(beats) * TIME_UNITS_PER_BEAT) / TIME_UNITS_PER_BEAT;
  if (!note || !Number.isFinite(n) || n <= 0 || n > 64 || note.dur === n) return false;
  pushHist();
  note.dur = n;
  render();
  return true;
}

// ---- editing a note from the section roll ------------------------------
//
// The roll is a piano roll over a division: a block's height is its pitch, its
// width the length it plays, and its left edge the silence in front of it. So
// three things can be dragged, and all three end here — one place per question,
// the way setNoteDuration() is the one answer to "how long".
//
// The internals below do NOT push history or render. A single drag can change
// pitch and position at once, and two snapshots for one gesture would take two
// undos to put back; the exported wrappers each take one snapshot and the
// combined moveNote() takes exactly one for the pair.

const unitsOfNote = n => Math.round((Number(n.dur) || 0) * TIME_UNITS_PER_BEAT);

const unitsBefore = index => state.notes
  .slice(0, index)
  .reduce((u, n) => u + unitsOfNote(n), 0);

// Whether a pitch is one the staff can write, and one this note is not
// already at. Asked BEFORE any snapshot is taken: pushHist() clears the redo
// stack, so pushing for an edit that turns out to be a no-op throws away a
// perfectly good redo and leaves an undo that undoes nothing.
function pitchChanges(note, svaraIndex, oct) {
  const svi = Number(svaraIndex);
  const o = Number(oct);
  if (!Number.isInteger(svi) || svi < 0 || svi > 6) return false;
  if (!Number.isInteger(o) || o < -1 || o > 1) return false;
  return note.svaraIndex !== svi || note.oct !== o;
}

function applyPitch(note, svaraIndex, oct) {
  const svi = Number(svaraIndex);
  const o = Number(oct);
  if (!pitchChanges(note, svi, o)) return false;
  note.svaraIndex = svi;
  note.oct = o;
  // A notehead the new svara cannot take is dropped rather than carried: Sa
  // and Pa have no lowered form, so a filled goli dragged onto one would be
  // drawn as a variant and sounded as the natural.
  if (!hasVariant(svi) && note.head === 'f') note.head = 'o';
  return true;
}

// Move a note along the clock by editing the SILENCE in front of it.
//
// The score is a sequence — a note has no x of its own, only the durations
// stacked up before it — so there is nothing to write a new position into.
// What there is, is the gap: dragging right inserts rests, dragging left takes
// them back out, and the note travels because the gap changed size. Both
// directions go through padRests(), the same writer the metronome fill uses,
// so silence placed by a drag is beat-aligned exactly like silence played in.
//
// It STOPS at the previous note. There is no silence there to absorb, and
// swallowing a note to make room would delete music to satisfy a drag. The
// applied delta is returned rather than the requested one, so the caller can
// draw the wall instead of pretending the note moved.
//
// Everything after the note shifts with it. That is inherent to a sequence and
// is not hidden: the roll slides the downstream blocks during the drag.
// How far the note could actually go, without moving anything. The drag reads
// this on every pointermove to clamp its own preview, so the block stops
// against the previous note on screen at the same place it would stop in the
// score — a preview that slides past the wall and snaps back on release is
// just a lie told for the length of a gesture.
export function nudgeRoom(index, delta) {
  const notes = state.notes;
  const d = Math.round(Number(delta));
  if (!notes[index] || !Number.isFinite(d) || d === 0) return 0;
  if (d > 0) return d;                      // silence can always be inserted
  let start = index;
  let pool = 0;
  while (start > 0 && notes[start - 1].type === 'rest' && pool < -d) {
    pool += unitsOfNote(notes[start - 1]);
    start -= 1;
  }
  const room = Math.min(-d, pool);
  return room ? -room : 0;          // never -0, which reads back as a move
}

function applyNudge(index, delta) {
  const notes = state.notes;
  const note = notes[index];
  const d = Math.round(Number(delta));
  if (!note || !Number.isFinite(d) || d === 0) return 0;

  if (d > 0) {
    const rests = padRests(d, unitsBefore(index) % TIME_UNITS_PER_BEAT);
    if (!rests.length) return 0;
    notes.splice(index, 0, ...rests);
    return d;
  }

  // Walk back over the silence immediately in front of the note, gathering
  // whole rests until there is enough to cover the drag or a note stops it.
  const want = -d;
  let start = index;
  let pool = 0;
  while (start > 0 && notes[start - 1].type === 'rest' && pool < want) {
    pool += unitsOfNote(notes[start - 1]);
    start -= 1;
  }
  if (pool <= 0) return 0;
  const take = Math.min(want, pool);
  // The rests are re-written rather than trimmed: what stays behind has to be
  // legal silence — real symbols, aligned to where it now begins — and a rest
  // whose dur no longer matches its glyph would draw one value and play another.
  const keep = pool - take;
  const repl = keep ? padRests(keep, unitsBefore(start) % TIME_UNITS_PER_BEAT) : [];
  notes.splice(start, index - start, ...repl);
  return -take;
}

// Drag a block up or down: same note, different rung.
export function setNotePitch(index, svaraIndex, oct) {
  const note = state.notes[index];
  if (!note || note.type !== 'note') return false;
  if (!pitchChanges(note, svaraIndex, oct)) return false;
  pushHist();
  applyPitch(note, svaraIndex, oct);
  state.preset = null;
  render();
  return true;
}

// One rung up (dir 1) or down (-1) on the staff's own ladder, skipping the
// dead rung (the magic line and its octave echoes) the way noteY() does.
// Null at the edge of the three sthayis. Pure; tests/pitch.test.mjs drives it.
export function stepRung(svaraIndex, oct, dir) {
  let pos = oct * 8 + SVARA_RUNG[svaraIndex] + dir;
  if (((pos % 8) + 8) % 8 === 3) pos += dir;
  if (pos < -8 || pos > 15) return null;
  const o = Math.floor(pos / 8);
  return { svaraIndex: SVARA_RUNG.indexOf(pos - o * 8), oct: o };
}

// Alt+↑/↓: the note at `index` one svara higher or lower, sounded so the move
// is heard. One keypress, one undo.
export function stepNotePitch(index, dir) {
  const note = state.notes[index];
  if (!note || note.type !== 'note') return false;
  const to = stepRung(note.svaraIndex, note.oct, dir);
  if (!to || !setNotePitch(index, to.svaraIndex, to.oct)) return false;
  pluck(freqOf(semiOf(note.svaraIndex, note.head), note.oct));
  return true;
}

// Flip the notehead — the natural against its chromatic variant. This is what
// a shared rung costs and what pays it back: R1 and R2 sit on the same line of
// the roll because they sit on the same line of the staff, so the panel has to
// offer the distinction the notehead makes.
export function setNoteHead(index, head) {
  const note = state.notes[index];
  const h = head === 'f' ? 'f' : 'o';
  if (!note || note.type !== 'note') return false;
  if (h === 'f' && !hasVariant(note.svaraIndex)) return false;
  if (isFilled(note.svaraIndex, note.head) === (h === 'f')) return false;
  pushHist();
  note.head = h;
  state.preset = null;
  render();
  return true;
}

// Drag a block sideways. Returns the units it actually moved.
export function nudgeNote(index, delta) {
  if (!state.notes[index] || !nudgeRoom(index, delta)) return 0;
  pushHist();
  const moved = applyNudge(index, delta);
  state.preset = null;
  render();
  return moved;
}

// One drag, one undo. The pitch is applied first: applyNudge() splices rests in
// front of the note, so doing it the other way round would leave `index`
// pointing at a rest that has just been inserted.
export function moveNote(index, { svaraIndex = null, oct = null, delta = 0 } = {}) {
  const note = state.notes[index];
  if (!note || note.type !== 'note') return false;
  const willPitch = svaraIndex != null
    && pitchChanges(note, svaraIndex, oct == null ? note.oct : oct);
  const willMove = nudgeRoom(index, delta);
  if (!willPitch && !willMove) return false;
  pushHist();
  if (willPitch) applyPitch(note, svaraIndex, oct == null ? note.oct : oct);
  applyNudge(index, delta);
  state.preset = null;
  render();
  return true;
}

// Index a note would be inserted at to start at `unit` on the clock. A point
// inside a note goes to whichever of its edges is nearer.
export function insertIndexAt(notes, unit) {
  let at = 0;
  for (let i = 0; i < notes.length; i++) {
    const len = unitsOfNote(notes[i]);
    if (unit <= at) return i;
    if (unit < at + len) return unit - at < len / 2 ? i : i + 1;
    at += len;
  }
  return notes.length;
}

// Drag-and-drop on the sheet: put `item` at `unit`, pushing everything after
// it along. With `from`, the note at that index is MOVED (taken out first, so
// the music closes over where it was) — and given the pitch `item` carries.
// A drop past the written music pads the gap with rests, so the note lands
// where it was dropped. One gesture, one undo.
export function placeAt(item, unit, from = null) {
  const notes = state.notes.slice();
  let u = Math.max(0, Math.round(Number(unit) || 0));
  let moving = null;
  if (from != null) {
    moving = notes[from];
    if (!moving || moving.type !== 'note') return false;
    const start = unitsBefore(from);
    if (u > start) u = Math.max(start, u - unitsOfNote(moving));
    notes.splice(from, 1);
  }
  let idx = insertIndexAt(notes, u);
  if (idx === notes.length) {
    const total = notes.reduce((s, n) => s + unitsOfNote(n), 0);
    // Past the music, snap to the symbol's own value (at most a division), so a
    // Maguru dropped on an empty 4/4 staff starts the division instead of
    // being split across its line behind a run of odd rests.
    const grid = Math.max(1, Math.min(boxUnits(), unitsOfNote(moving || item)));
    u = Math.max(total, Math.floor(u / grid) * grid);
    if (u > total) notes.push(...padRests(u - total, total % TIME_UNITS_PER_BEAT));
    idx = notes.length;
  }
  let put = item;
  if (moving) {
    const same = idx === from && moving.svaraIndex === item.svaraIndex
      && moving.oct === item.oct && moving.head === item.head;
    if (same) return false;
    put = { ...moving, svaraIndex: item.svaraIndex, oct: item.oct, head: item.head };
  }
  notes.splice(idx, 0, put);
  pushHist();
  state.notes.splice(0, state.notes.length, ...notes);
  state.preset = null;
  render();
  return true;
}

// Delete from the roll. A NOTE becomes the silence it was taking up, so nothing
// after it moves; a REST is taken out and the music closes over it — which is
// the only thing deleting silence can mean in a sequence.
export function removeNote(index) {
  const note = state.notes[index];
  if (!note) return false;
  pushHist();
  const rests = note.type === 'rest' ? []
    : padRests(unitsOfNote(note), unitsBefore(index) % TIME_UNITS_PER_BEAT);
  state.notes.splice(index, 1, ...rests);
  state.preset = null;
  render();
  return true;
}

// Register a held note for beat-driven growth. A returned cleanup function
// finalizes the note on key release.
//
// WHAT THE FLOOR IS, and why it is a danta by default.
//
// This used to floor every hold at the SELECTED palette symbol, so a hold could
// only ever make a note longer. With the default selection of bindu — one whole
// beat — that put danta, praya, praya•, vasu and vasu• below the floor and made
// them unreachable by playing: `Math.max(floorUnits, …)` in
// advanceHoldPromotions() could never return less than 8 units, so however
// briefly a key was tapped it still wrote a bindu. Every short value in the
// notation was unplayable, which is not a rounding error but a whole half of
// the ladder missing.
//
// So the floor is now ONE DANTA, the shortest glyph there is, and how long the
// key is actually down picks the symbol outright. state.holdWrites === 'palette'
// restores the old rule for anyone who wants to place a long value by tapping
// rather than by holding for it.
//
// THREE MODES, and they differ only in what this function does:
//
//   'time'     the floor is one danta and the hold picks the symbol outright
//   'palette'  the selected symbol is a FLOOR a hold can grow past
//   'fixed'    the selected symbol IS the value; nothing grows at all
//
// 'fixed' is for entering an even run — pick bindu and every key you play
// writes a bindu, whether you stab it or lean on it. That is a different job
// from playing a piece in: there the timing is the music and 'time' is right,
// but when you are typing out a scale or a lesson the hold length is noise and
// having it change the glyph is the thing getting in the way.
//
// `pressedAt` (and the release handler's `releasedAt`) is the MIDI event's own
// timestamp. The handler that receives a key shares the main thread with
// render(), which costs 13-25 ms on a long score, so reading the clock when the
// handler finally runs measures the frame the key landed in, not the key: at
// 120bpm a danta is 62.5 ms and that lag alone moved holds across a symbol.
// Callers with no timestamp (the on-screen piano, the letter keys) pass
// nothing and are measured at the call, as before.
export function startHoldPromotion(index, initialSym = state.sym, pressedAt) {
  // Nothing to do in fixed mode. addNote() has ALREADY written the selected
  // symbol, so the note is finished the moment it is entered: no growth
  // record, no clock, and a release handler with nothing to finalize. Note
  // this must not fall through to the code below — that would register the
  // note and let the release handler rewrite it from the wall clock, which is
  // exactly what this mode exists to stop.
  //
  // The metronome's silence clock is untouched by this. It is armed by
  // begin/endMetronomeEntry() and counts keys through metroEntry.held, which
  // has never had anything to do with heldPromotions, and endMetronomeEntry()
  // starts the shared clock itself.
  if (!state.lesson) touchEntry(unitsBefore(index));
  const base = SOUND[initialSym] ? initialSym : 'bindu';
  const floorUnits = state.holdWrites === 'palette'
    ? Math.round(SOUND[base].dur * TIME_UNITS_PER_BEAT)
    : minRecorded();
  // Raw timing for re-quantizing later. `at` is where the note actually landed,
  // so a later edit ahead of the take shows up as a shift and is carried along.
  // A fixed-mode note keeps no `off`: its length is the palette's, not played.
  const raw = pendingRaw;
  pendingRaw = null;
  if (raw && state.notes[index]?.type === 'note') {
    state.notes[index].take = {
      ...raw, at: unitsBefore(index),
      ...(state.holdWrites === 'palette' ? { min: floorUnits } : {}),
    };
  }
  if (state.holdWrites === 'fixed') return () => {};
  // `at` is the wall clock this hold was last MEASURED at, exactly as
  // metroEntry.idleAt is for silence. `units` is what has already been counted
  // against it, tempo by tempo; the two together are the whole record, and
  // there is deliberately no "started at" — see the release handler.
  heldPromotions.set(index, { units: 0, floorUnits, at: eventTime(pressedAt) ?? nowMs() });
  // In time mode the note is written as the palette's symbol by addNote() and
  // only corrected on the first tick, so a bindu would flash on the staff for
  // an eighth of a beat before shrinking. Put it on the floor immediately.
  if (floorUnits < Math.round(SOUND[base].dur * TIME_UNITS_PER_BEAT)) {
    setHeldUnits(index, floorUnits);
  }
  ensureHoldPromotionClock();

  return (releasedAt) => {
    // FINALIZE on release rather than leaving whatever the last tick set. The
    // clock ticks once a danta, so a tap shorter than one tick never reached
    // advanceHoldPromotions() at all and would keep the symbol addNote() wrote.
    //
    // What is finalized is the units ALREADY COUNTED plus the slice since the
    // last tick, each valued at the tempo that was in force across it. This
    // used to re-derive the whole hold from a `startedAt` against beatMs() as
    // read AT RELEASE, which made a tempo change retroactive over the entire
    // note: one beat at 72 followed by two at 144 is three beats played and
    // came out a Maguru, and the same hold slowing down came out a guru. The
    // per-tick accumulation was already right and was being thrown away. It is
    // the same fault accrueIdle() was fixed for on the silence side, so it is
    // now fixed the same way — measure each slice under its own tempo.
    const promotion = heldPromotions.get(index);
    if (promotion) {
      // Never negative: advanceHoldPromotions() is exported and a caller may
      // pump time the wall clock has not actually moved through, which would
      // otherwise subtract from what those ticks legitimately counted.
      // A release TIMESTAMP may legitimately land before the last tick: the
      // tick timer and the queued key-up race through the same busy frame, and
      // when the tick wins it has counted time the key was no longer down for.
      // That is taken back; the floor below still bounds the result.
      const end = eventTime(releasedAt);
      const since = end != null ? end - promotion.at : Math.max(0, nowMs() - promotion.at);
      // On the grid the RELEASE is placed too, so the length is where the key
      // came up minus where the note starts — both edges on the clock.
      const take = state.notes[index]?.take;
      if (grid && take) take.off = gridPos(end ?? nowMs());
      const elapsed = grid
        ? snap(gridPos(end ?? nowMs())) - unitsBefore(index)
        : snap(heldUnits(promotion, since));
      const held = Math.min(
        HOLD_CAP_BEATS * TIME_UNITS_PER_BEAT,
        Math.max(promotion.floorUnits, elapsed),
      );
      setHeldUnits(index, held);
    }
    heldPromotions.delete(index);
    if (!heldPromotions.size && !idleAccruing()) stopHoldClock();
    // The length bar becomes the written symbol now, and the settle starts.
    touchEntry();
    renderSoon();
  };
}

// A MIDI event's timestamp, when it can be believed: a finite reading of the
// same clock as nowMs(), not in the future, and no older than a stalled frame
// explains. Anything else (a device or test stamping 0, a value from another
// clock) is null and the caller falls back to the clock.
const EVENT_STALE_MS = 1000;
function eventTime(at) {
  const now = nowMs();
  return Number.isFinite(at) && at <= now && now - at < EVENT_STALE_MS ? at : null;
}

// What a held note is worth RIGHT NOW, in timing units, plus `extraMs` of
// holding the clock has not been asked about yet. Measured in dantas whether
// or not the metronome is on — the metronome only sets how long a danta is.
function heldUnits(promotion, extraMs = 0) {
  return promotion.units + (extraMs / entryBeatMs()) * TIME_UNITS_PER_BEAT;
}

// `dtMs` of holding has elapsed. Each held note is rewritten as the largest
// exact number of dantas it has been down for — see setHeldUnits().
//
// Because the tick is one danta rather than one beat, the short values are
// reachable too: from the danta floor the run is danta, praya, praya•, vasu,
// vasu•, bindu, bindu•, guru, guru•, Maguru. A note never shrinks below its
// floor — see startHoldPromotion() for what that floor is and why.
//
// The release handler finalizes against the wall clock, so this loop only has
// to keep the staff honest WHILE a key is down; it is not the last word.
export function advanceHoldPromotions(dtMs = entryBeatMs()) {
  const capUnits = HOLD_CAP_BEATS * TIME_UNITS_PER_BEAT;
  const grown = (dtMs / entryBeatMs()) * TIME_UNITS_PER_BEAT;

  heldPromotions.forEach((promotion, index) => {
    promotion.units += grown;
    // Advanced by the interval that was just COUNTED, not set to nowMs(): the
    // dt is the caller's measurement, and the release handler adds only what
    // has gone by since. Setting it from the clock would double-count for any
    // caller whose dt is not the wall time it just waited.
    promotion.at += dtMs;
    const held = Math.min(
      capUnits,
      Math.max(promotion.floorUnits, Math.floor(heldUnits(promotion) + 1e-9)),
    );
    setHeldUnits(index, held);
    if (held >= capUnits) { heldPromotions.delete(index); touchEntry(); }
  });

  if (!heldPromotions.size && !idleAccruing()) stopHoldClock();
}

// The growth clock. It runs only while something is held, ticks one danta at a
// time, and re-reads the tempo every tick so changing BPM mid-hold takes effect
// immediately. It is deliberately NOT the metronome: a metronome tick cannot
// subdivide a beat, and holding has to resolve to an eighth of one.
export function ensureHoldPromotionClock() {
  if ((!heldPromotions.size && !idleAccruing()) || holdTimer) return;
  holdLast = nowMs();
  const tick = () => {
    holdTimer = null;
    const t = nowMs();
    const dt = t - holdLast;
    holdLast = t;
    tickScoreClock(dt);
    if (heldPromotions.size || idleAccruing()) holdTimer = setTimeout(tick, holdTickMs());
  };
  holdTimer = setTimeout(tick, holdTickMs());
}

// One tick of the score clock, at danta resolution.
//
// SOUND and SILENCE are measured here together, off one interval and one
// reading of the tempo, which is the whole point: a held note growing and a
// rest running on are the same measurement pointed at different things, and
// splitting them across two clocks is what let the notes be resolved to an
// eighth of a beat while the gaps between them were resolved to a whole one.
//
// Exported so the tests can pump the clock without waiting on a real timer.
export function tickScoreClock(dtMs) {
  if (grid) {
    const now = nowMs();
    grid = { ...grid, at: now, units: gridPos(now), beat: entryBeatMs() };
  }
  advanceHoldPromotions(dtMs);
  // Only MEASURED here, not written: a rest reaches the staff on a metronome
  // beat or in front of the next note, which is where a reader expects to see
  // one appear.
  accrueIdle(dtMs);
}

export function addRest(sym) {
  if (state.lesson) return;
  pushHist();
  state.preset = null;
  appendRest(sym);
  render();
}

// Called by piano/keyboard input — these only track whether a key is down.
// The rest value is not captured here: it is read live from the sidebar
// selection on each tick, so changing the selection changes what gets filled.
export function beginMetronomeEntry() {
  if (!state.metroOn) return;
  metroEntry.armed = true;
  metroEntry.held += 1;
  metroEntry.idleAt = null;         // a key is down: nothing is accruing now
}

// Only the LAST key up ends the entry. The floor at zero matters because the
// metronome can be switched on part-way through a hold, in which case the
// begin that would have paired with this end never ran.
export function endMetronomeEntry() {
  if (!metroEntry.armed) return;
  metroEntry.held = Math.max(0, metroEntry.held - 1);
  if (keyIsHeld()) return;
  // The silence starts HERE, at the release, not at the next metronome beat.
  metroEntry.idleAt = nowMs();
  // Silence rides the same clock the held notes do, so it is measured against
  // the tempo in force moment by moment rather than at the flush.
  ensureHoldPromotionClock();
}

// How much silence has gone by since it was last measured, in timing units.
//
// Read off the wall clock against the CURRENT tempo — the same conversion
// startHoldPromotion() uses to decide what a held key is worth — so a note and
// the silence beside it are measured the same way and by the same beat. beatMs()
// is re-read on every call rather than captured, so changing the tempo part-way
// through a rest is accounted for exactly as it is part-way through a hold.
function accrueIdle(dtMs = null) {
  if (!idleAccruing()) return;
  const now = nowMs();
  if (grid) {
    // The silence is simply how far the clock is past the written music.
    metroEntry.idleUnits = Math.max(0, gridPos(now) - totalUnits());
    metroEntry.idleAt = now;
    return;
  }
  // The clock passes the interval it just waited; a flush passes nothing and
  // means "bring this up to now". beatMs() is read HERE either way, so each
  // slice of silence is valued at the tempo that was in force across it.
  const dt = dtMs == null ? now - metroEntry.idleAt : dtMs;
  metroEntry.idleUnits += (dt / entryBeatMs()) * TIME_UNITS_PER_BEAT;
  metroEntry.idleAt = now;
}

// Whether silence is running right now. The danta clock reads this to decide
// whether to keep ticking, so the accrual above is sampled at least once a
// danta and a tempo changed part-way through a rest is applied only to the time
// that actually elapsed under it — exactly as advanceHoldPromotions() treats a
// tempo change part-way through a hold. Sampling only at the flush points made
// the NEW tempo retroactive over the whole gap.
function idleAccruing() {
  return state.fill === 'metro' && state.metroOn
    && metroEntry.armed && !keyIsHeld() && metroEntry.idleAt != null;
}

// Write out whole units of accrued silence, stopping at each beat line so
// padRests() can pick the same beat-aligned values the 'auto' fill derives.
// The fractional remainder is KEPT, so silence written always adds up to the
// time that actually elapsed instead of rounding away a danta at a time.
//
// A click writes only silence that FINISHES a beat of the written music; what
// is left over waits for the next click. Only a note about to be written
// (`all`) takes the part-beat in front of it. A key is released anywhere
// between two clicks, so the written music and the clicks are out of phase by
// that much, and a click that wrote everything it had cut every beat of
// silence in two at the click: release half a beat after one and the staff
// filled with pairs of vasu rests instead of one bindu rest a beat.
function flushIdle(all = false) {
  let wrote = false;
  while (metroEntry.idleUnits + 1e-9 >= 1) {
    const used = usedInBeat();
    const room = TIME_UNITS_PER_BEAT - used;
    const have = Math.floor(metroEntry.idleUnits + 1e-9);
    if (!all && have < room) break;
    const take = Math.min(room, have);
    if (take < 1) break;
    if (!wrote) pushHist();
    for (const rest of padRests(take, used)) state.notes.push(rest);
    metroEntry.idleUnits -= take;
    wrote = true;
  }
  return wrote;
}

// A key is about to write a note: close out the silence in front of it FIRST,
// so the gap lands between the two notes rather than being swallowed.
//
// Without this, silence was only ever written when a metronome tick fired —
// once a beat — so any gap SHORTER than the distance to the next beat line
// simply vanished and the two notes came out touching. Play two dantas a
// danta-rest apart and the score read as two dantas in a row: the notes were
// measured to an eighth of a beat while the space between them was measured to
// a whole one.
export function closeMetronomeSilence(pressedAt) {
  // With the metronome off there is no click, so the grid is an invisible one
  // started by the first key, at entryBeatMs() — the same one-beat-a-second
  // rule a held key is already valued by. With it on, metro fill decides.
  pendingRaw = null;
  if (state.lesson || (state.metroOn && state.fill !== 'metro')) {
    // No take grid here, but the hand-off still holds: a key still down ends
    // where the next one starts. Left growing, it kept lengthening underneath
    // every note written after it and pushed them all along the sheet.
    heldPromotions.forEach((p, i) => {
      setHeldUnits(i, Math.max(p.floorUnits, Math.floor(heldUnits(p, Math.max(0, nowMs() - p.at)) + 1e-9)));
      heldPromotions.delete(i);
    });
    grid = null;
    return;
  }
  const t = eventTime(pressedAt) ?? nowMs();
  const end = totalUnits();
  // A pause this long is the player stopping, not a rest: start a new take
  // rather than writing a page of silence.
  // ponytail: fixed 8 beats, make it a setting if someone records long rests by hand.
  if (grid && gridPos(t) - end > TAKE_IDLE_BEATS * TIME_UNITS_PER_BEAT) grid = null;
  // The beat changed with no tick to rebase it: the metronome was switched on
  // or off between keys. That is a new take, on the new ruler.
  if (grid && grid.beat !== entryBeatMs()) grid = null;
  if (!grid) {
    // A take starts on the click NEAREST the first key, so a key played a
    // hair before the click is on it rather than a whole beat after the last.
    const beat = entryBeatMs();
    let origin = t;
    // No click heard yet (the metronome has only just been switched on): the
    // key is the best guess, and the first click to arrive corrects it — see
    // onMetronomeTick(). Without that, a key played ahead of that first click
    // timed the whole take from the key and not from the count.
    let free = state.metroOn;
    if (lastClickAt != null && Math.abs(t - lastClickAt) < 2 * beat) {
      origin = lastClickAt + Math.round((t - lastClickAt) / beat) * beat;
      free = false;
    }
    grid = {
      at: origin, units: Math.ceil(end / TIME_UNITS_PER_BEAT) * TIME_UNITS_PER_BEAT, beat, free,
      id: `${Date.now().toString(36)}.${++takeSeq}`, from: end,
    };
    // Never behind the music already written: the take starts after it. By
    // WHOLE dantas, and only when the ROUNDED onset is behind: a first key a
    // hair before the downbeat rounds onto it, and shifting by the raw fraction
    // moved the whole take that much late, so a later key played slightly late
    // tipped into the next danta.
    const lag = end - snap(gridPos(t));
    if (lag > 0) grid.units += lag;
  }
  const onset = snap(gridPos(t));
  pendingRaw = { id: grid.id, from: grid.from, on: gridPos(t) };
  // A key still down (legato) ends where this one starts. Floored at a danta,
  // NOT at the quantum: the next key is what ends it, and holding it to a whole
  // quantum pushed every following note later — under a bindu grid a quick run
  // ran beats ahead of the metronome and swallowed the rests between phrases.
  heldPromotions.forEach((p, i) => {
    if (state.notes[i]?.take) state.notes[i].take.off = pendingRaw.on;
    setHeldUnits(i, Math.max(MIN_HOLD_UNITS, onset - unitsBefore(i)));
    heldPromotions.delete(i);
  });
  metroEntry.idleUnits = 0;
  metroEntry.idleAt = null;
  const now = totalUnits();
  const last = state.notes[state.notes.length - 1];
  if (onset > now) {
    pushHist();
    for (const rest of padRests(onset - now, now % TIME_UNITS_PER_BEAT)) state.notes.push(rest);
  } else if (onset < now && last?.type === 'note') {
    // The last note's release rounded past this onset: it ends here.
    setHeldUnits(state.notes.length - 1,
      Math.max(MIN_HOLD_UNITS, onset - unitsBefore(state.notes.length - 1)));
  } else return;
  state.preset = null;
  render();
}

// How far into the current beat the written music ends, in timing units.
function usedInBeat() {
  const units = state.notes.reduce(
    (u, n) => u + Math.round((Number(n.dur) || 0) * TIME_UNITS_PER_BEAT), 0);
  return ((units % TIME_UNITS_PER_BEAT) + TIME_UNITS_PER_BEAT) % TIME_UNITS_PER_BEAT;
}

// Called once per metronome beat. It fills only the time after a released
// note, writing the same beat-aligned silence padRests() derives in 'auto':
// finish the beat the note stopped inside, then one bindu rest per beat.
export function onMetronomeTick(heardAt) {
  lastClickAt = Number.isFinite(heardAt) ? heardAt : nowMs();
  // The first click of a take that started before any click was heard: move
  // the take's ruler (not the music already written) so this click is on a
  // beat line — but only by under a quarter beat. That is a player coming in a
  // little ahead of the count; a key and a click further apart than that are
  // not one beat played early, and the key's own timing stands.
  if (grid?.free) {
    const p = gridPos(lastClickAt);
    const shift = Math.round(p / TIME_UNITS_PER_BEAT) * TIME_UNITS_PER_BEAT - p;
    if (Math.abs(shift) < TIME_UNITS_PER_BEAT / 4) {
      grid.units += shift;
      // Raw edges already taken on the old ruler move with it.
      for (const n of state.notes) {
        if (n.take?.id !== grid.id) continue;
        n.take.on += shift;
        if (n.take.off != null) n.take.off += shift;
      }
    }
    grid.free = false;
  }
  if (state.fill !== 'metro' || state.lesson) return;
  if (!state.metroOn || !metroEntry.armed || keyIsHeld()) return;
  // The tick no longer COUNTS the silence — it only asks the clock how much has
  // gone by, the same question closeMetronomeSilence() asks. Counting ticks made
  // the beat the smallest measurable rest and tied the answer to a click that
  // fires on its own schedule; reading the clock makes a tick just one of two
  // moments the same measurement gets flushed.
  accrueIdle();
  if (flushIdle()) {
    // Rests the metronome writes between phrases keep a live take live.
    if (state.entering) touchEntry();
    state.preset = null;
    render();
  }
}

// REGION QUANTIZE, Logic's non-destructive kind: re-snap every recorded take
// from the raw edges its notes kept, at the current state.quantize. Picking
// "off" puts a take back at danta resolution, so nothing is ever lost to a
// coarse grid. One undo for the lot; false when nothing moved.
export function requantizeTakes() {
  const before = JSON.stringify(state.notes);
  const ids = new Set(state.notes.filter(n => n.take).map(n => n.take.id));
  ids.forEach(requantizeTake);
  const after = state.notes;
  if (JSON.stringify(after) === before) return false;
  state.notes = JSON.parse(before);
  pushHist();
  state.notes = after;
  state.preset = null;
  render();
  return true;
}

function requantizeTake(id) {
  const notes = state.notes;
  const first = notes.findIndex(n => n.take?.id === id);
  let last = notes.length - 1;
  while (notes[last].take?.id !== id) last--;
  // A note written some other way sits inside the take: the take is no longer
  // the player's alone, so it is left as it stands.
  for (let i = first; i <= last; i++) {
    if (notes[i].type === 'note' && notes[i].take?.id !== id) return;
  }
  // An edit ahead of the take moved it; the raw edges move with it.
  const shift = unitsBefore(first) - notes[first].take.at;
  // The silence the take opened with is the take's too.
  let start = first;
  const from = notes[first].take.from + shift;
  while (start > 0 && notes[start - 1].type === 'rest' && unitsBefore(start - 1) >= from) start--;

  const played = notes.slice(first, last + 1).filter(n => n.type === 'note');
  // Bake the shift into the raw edges, so the next requantize starts from here.
  for (const n of played) {
    n.take.on += shift;
    n.take.from += shift;
    if (n.take.off != null) n.take.off += shift;
  }
  const ons = played.map(n => snap(n.take.on));
  let cursor = unitsBefore(start);
  const out = [];
  played.forEach((n, k) => {
    const on = Math.max(cursor, ons[k]);
    if (on > cursor) out.push(...padRests(on - cursor, cursor % TIME_UNITS_PER_BEAT));
    let len = n.take.off != null ? snap(n.take.off) - on : unitsOfNote(n);
    len = Math.max(n.take.min ?? 0, minRecorded(), len);
    // The next note's onset ends it, as it does live — see closeMetronomeSilence().
    if (k + 1 < played.length) len = Math.max(MIN_HOLD_UNITS, Math.min(len, ons[k + 1] - on));
    len = Math.min(HOLD_CAP_BEATS * TIME_UNITS_PER_BEAT, len);
    writeUnits(n, len);
    n.take.at = on;
    out.push(n);
    cursor = on + len;
  });
  notes.splice(start, last - start + 1, ...out);
}

export function stopMetronomeEntry() {
  metroEntry.armed = false;
  metroEntry.held = 0;
  metroEntry.idleUnits = 0;
  metroEntry.idleAt = null;
  grid = null;
  lastClickAt = null;
  ensureHoldPromotionClock();
}

// A repeat is placed as a PAIR, by two clicks of the armed tool or by one
// drag. An open never arrives alone: an unmatched brace draws perfectly and
// plays nothing, so the close comes with it, and either end can be dragged
// afterwards.
export function addRepeatPair(openUnit, closeUnit, count = 2) {
  pushHist();
  const a = Math.max(0, Number(openUnit) || 0);
  const b = Math.max(a, Number(closeUnit) || 0);
  state.bars.push({ id: newBarId(), unit: a, kind: 'open', count });
  state.bars.push({ id: newBarId(), unit: b, kind: 'close', count });
  render();
}

// Marks are placed freely, so a move is just a new position on the clock —
// nothing is snapped to a division and nothing is clamped to the written
// music. Rounded to the danta, the smallest thing the notation counts.
export function moveBar(id, unit) {
  const bar = state.bars.find(b => b.id === id);
  if (!bar) return false;
  const to = Math.max(0, Math.round(Number(unit) || 0));
  if (bar.unit === to) return false;
  pushHist();
  bar.unit = to;
  render();
  return true;
}

export function removeBar(id) {
  const i = state.bars.findIndex(b => b.id === id);
  if (i < 0) return false;
  pushHist();
  state.bars.splice(i, 1);
  if (state.selBar === id) state.selBar = null;
  render();
  return true;
}

// A repeat's count is edited in place rather than by deleting and re-dragging.
// Both ends of a pair carry it, so they are set together — a brace that says
// x2 closing a repeat that says x3 is not a thing the sheet can mean.
export function setBarCount(id, count) {
  const bar = state.bars.find(b => b.id === id);
  if (!bar) return false;
  const c = Math.max(2, Math.min(4, Number(count) || 2));
  if (bar.count === c) return false;
  pushHist();
  const pair = repeatPairs(state.bars).find(p => p.openId === id || p.closeId === id);
  bar.count = c;
  if (pair) {
    for (const b of state.bars) {
      if (b.id === pair.openId || b.id === pair.closeId) b.count = c;
    }
  }
  render();
  return true;
}

export function clearBars() {
  pushHist();
  state.bars = [];
  state.selBar = null;
  render();
}

export function clearAll() {
  pushHist();
  state.notes  = [];
  state.bars   = [];
  state.breaks = [];
  state.selBar = null;
  state.preset = null;
  render();
}

export function deleteLast() {
  if (state.lesson) return;
  pushHist();
  state.notes.pop();
  render();
}

export function loadPreset(name) {
  state.notes = [];
  state.bars  = [];
  state.breaks = [];
  const sthayi = name === 'mandra' ? -1 : name === 'tara' ? 1 : 0;

  PRESETS[name].forEach(entry => {
    // Bare index = the varase form: this preset's sthayi, one bindu, and the
    // notehead the scale says. The array form carries its own.
    if (!Array.isArray(entry)) {
      state.notes.push({
        type: 'note', svaraIndex: entry, oct: sthayi, head: 'auto',
        sym: 'bindu', dot: false, dur: 1, deco: 'none',
      });
      return;
    }
    const [svi, oct = 0, sym = 'bindu', dot = false, head = 'o'] = entry;
    const sd = SOUND[sym] || SOUND.bindu;
    state.notes.push({
      type: 'note', svaraIndex: svi, oct, head,
      sym, dot: !!dot, dur: sd.dur * (dot ? DOT_MULT : 1), deco: sd.deco,
    });
  });

  if (PRESET_BPM[name]) {
    state.bpm = PRESET_BPM[name];
    const el = document.getElementById('bpmVal');
    if (el) el.value = state.bpm;
  }

  state.preset = name;
  state.title  = TITLES[name];
  state.file   = '';
  document.getElementById('titleVal').textContent = TITLES[name];
  state.hist   = [];
  state.future = [];
  updateUndoButtons();
  render();
}
