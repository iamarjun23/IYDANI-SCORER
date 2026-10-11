// Score mutations. Every public function here pushes a history snapshot
// first, then mutates state, then re-renders.

import { state, toneOn } from './state.js';
import {
  BPM, DOT_MULT, ENTRY_BEAT_MS, HOLD_CAP_BEATS, HOLD_TICK_UNITS, SOUND, REST_MAP,
  SVARAS, beatSeconds,
  SVARA_TONES, PRESETS, PRESET_BPM, TITLES, TIME_UNITS_PER_BEAT, semiOf,
  isFilled, hasVariant,
} from './config.js';
import { pushHist, updateUndoButtons } from './history.js';
import { pluck, freqOf } from './audio.js';
import { render, padRests, glyphFor } from './notation.js';
import { newBarId, repeatPairs } from './repeat-model.js';
import { lessonKey } from './lesson.js';

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
let holdTimer = null;
let holdLast = 0;

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
const entryBeatMs = () => (state.metroOn ? beatMs() : ENTRY_BEAT_MS);

// Is a beat being SOUNDED? Then the clicks, and not any clock, are what a hold
// is measured against: each one a key is still down through is one more beat of
// value, so the faster the metronome the sooner a held key reaches a guru. What
// appears on the staff is then exactly what was counted out loud, which is the
// whole reason for having the metronome on while writing music in.
//
// This is deliberately state.metroOn and not followingClock() or the fill mode:
// the question is whether the player can HEAR the count they are playing to. A
// grid nobody can hear is not something to snap to.
const beatSnapping = () => state.metroOn === true;

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
  // A tone switched off in the sheet's legend is heard and not written. Null
  // tells the caller there is no note to grow and no key to count as held.
  if (!toneOn(semiOf(svi, head), oct)) {
    if (playSound) pluck(freqOf(semiOf(svi, head), oct));
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
  render();
  setTimeout(() => { state.hlIndex = null; render(); }, 230);
  return state.notes.length - 1;
}

// Change the visual duration of a note already entered by a held key. This
// deliberately does not create another history entry: one hold is one note.
export function setNoteSymbol(index, sym, dot = false) {
  const note = state.notes[index];
  const sd = SOUND[sym];
  if (!note || note.type !== 'note' || !sd) return;
  if (note.sym === sym && !!note.dot === !!dot) return;
  note.sym = sym;
  note.dot = !!dot;
  note.dur = sd.dur * (dot ? DOT_MULT : 1);
  note.deco = sd.deco;
  render();
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
export function startHoldPromotion(index, initialSym = state.sym) {
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
  if (state.holdWrites === 'fixed') return () => {};

  const base = SOUND[initialSym] ? initialSym : 'bindu';
  const floorUnits = state.holdWrites === 'palette'
    ? Math.round(SOUND[base].dur * TIME_UNITS_PER_BEAT)
    : MIN_HOLD_UNITS;
  // `at` is the wall clock this hold was last MEASURED at, exactly as
  // metroEntry.idleAt is for silence. `units` is what has already been counted
  // against it, tempo by tempo; the two together are the whole record, and
  // there is deliberately no "started at" — see the release handler.
  heldPromotions.set(index, { units: 0, subUnits: 0, floorUnits, at: nowMs() });
  // In time mode the note is written as the palette's symbol by addNote() and
  // only corrected on the first tick, so a bindu would flash on the staff for
  // an eighth of a beat before shrinking. Put it on the floor immediately.
  if (floorUnits < Math.round(SOUND[base].dur * TIME_UNITS_PER_BEAT)) {
    const g = glyphFor(floorUnits);
    setNoteSymbol(index, g.sym, g.dot);
  }
  ensureHoldPromotionClock();

  return () => {
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
      const since = Math.max(0, nowMs() - promotion.at);
      const elapsed = heldUnits(promotion, since);
      const held = Math.min(
        HOLD_CAP_BEATS * TIME_UNITS_PER_BEAT,
        Math.max(promotion.floorUnits, Math.round(elapsed)),
      );
      const g = glyphFor(held);
      setNoteSymbol(index, g.sym, g.dot);
    }
    heldPromotions.delete(index);
    if (!heldPromotions.size && !idleAccruing()) stopHoldClock();
  };
}

// What a held note is worth RIGHT NOW, in timing units, plus `extraMs` of
// holding the clock has not been asked about yet.
//
// Under the metronome `units` is fed one whole beat at a time by the clicks and
// by nothing else, so a held note can only be 1, 2, 3 or 4 beats — that is what
// snapping to the count means, and a value between two clicks is one nobody
// heard. `subUnits` is the wall clock running underneath, and it is read ONLY
// while no click has landed yet: a tap that begins and ends between two clicks
// never earned a beat, so it resolves to the short symbols instead, and it is
// held below a whole beat because a whole beat is the clicks' to give.
function heldUnits(promotion, extraMs = 0) {
  const grown = (extraMs / entryBeatMs()) * TIME_UNITS_PER_BEAT;
  if (beatSnapping()) {
    return promotion.units > 0
      ? promotion.units
      : Math.min(TIME_UNITS_PER_BEAT - 1, promotion.subUnits + grown);
  }
  return promotion.units + grown;
}

// One METRONOME BEAT has been heard, and every key still down has just earned
// it. This is the whole of "the beat is the clock": a hold grows ON the clicks,
// in whole beats. Between two clicks a held note does not change, because
// nothing has been counted yet for it to show.
export function advanceHeldByBeat() {
  if (!heldPromotions.size || !beatSnapping()) return;
  const capUnits = HOLD_CAP_BEATS * TIME_UNITS_PER_BEAT;
  heldPromotions.forEach((promotion, index) => {
    promotion.units += TIME_UNITS_PER_BEAT;
    // The sub-beat measure is spent. It only ever answers for a tap that ended
    // before the first click, and a click has now landed.
    promotion.subUnits = 0;
    const held = Math.min(capUnits, Math.max(promotion.floorUnits, promotion.units));
    const g = glyphFor(held);
    setNoteSymbol(index, g.sym, g.dot);
    if (held >= capUnits) heldPromotions.delete(index);
  });
  if (!heldPromotions.size && !idleAccruing()) stopHoldClock();
}

// `dtMs` of holding has elapsed. Each held note is rewritten as the largest
// single glyph its elapsed time has actually reached, chukkis included — so a
// hold through 3 beats lands on guru + chukki (2 + 1) rather than rounding back
// to a plain guru or running on to Maguru.
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
  const snap = beatSnapping();
  const grown = (dtMs / entryBeatMs()) * TIME_UNITS_PER_BEAT;

  heldPromotions.forEach((promotion, index) => {
    // Under the metronome the clicks own the whole beats and this clock keeps
    // only the sub-beat measure a tap released before the first click resolves
    // against. It must not add to `units` as well, or every beat would be
    // counted twice — once when it went by and once when it was heard.
    if (snap) promotion.subUnits += grown;
    else promotion.units += grown;
    // Advanced by the interval that was just COUNTED, not set to nowMs(): the
    // dt is the caller's measurement, and the release handler adds only what
    // has gone by since. Setting it from the clock would double-count for any
    // caller whose dt is not the wall time it just waited.
    promotion.at += dtMs;
    const held = Math.min(
      capUnits,
      Math.max(promotion.floorUnits, Math.floor(heldUnits(promotion) + 1e-9)),
    );
    const g = glyphFor(held);
    setNoteSymbol(index, g.sym, g.dot);
    if (held >= capUnits) heldPromotions.delete(index);
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
export function closeMetronomeSilence() {
  if (state.fill !== 'metro' || state.lesson) return;
  if (!state.metroOn || !metroEntry.armed || keyIsHeld()) return;
  accrueIdle();
  if (flushIdle(true)) {
    state.preset = null;
    render();
  }
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
export function onMetronomeTick() {
  // A beat has been HEARD, so every key still down has just earned one — see
  // advanceHeldByBeat(). It runs before anything below because it has nothing
  // to do with the fill mode: whether silence is written for you is one
  // question, and what the count is worth to a key you are holding is another.
  // The danta clock stands down from whole beats while this is running, so the
  // two cannot both count the same beat.
  advanceHeldByBeat();
  if (state.fill !== 'metro' || state.lesson) return;
  if (!state.metroOn || !metroEntry.armed || keyIsHeld()) return;
  // The tick no longer COUNTS the silence — it only asks the clock how much has
  // gone by, the same question closeMetronomeSilence() asks. Counting ticks made
  // the beat the smallest measurable rest and tied the answer to a click that
  // fires on its own schedule; reading the clock makes a tick just one of two
  // moments the same measurement gets flushed.
  accrueIdle();
  if (flushIdle()) {
    state.preset = null;
    render();
  }
}

export function stopMetronomeEntry() {
  metroEntry.armed = false;
  metroEntry.held = 0;
  metroEntry.idleUnits = 0;
  metroEntry.idleAt = null;
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
