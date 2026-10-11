// Play-along: a student plays a score a teacher handed them, and each note is
// marked hit or missed. Pure — no DOM, no audio — so tests/lesson.test.mjs can
// drive it; cowork.js is the page and the bar that sit on top.
//
// `state.lesson` is `{ id, mode, pos, marks }` while a lesson is open and null
// otherwise. `pos` is an index into state.notes (the note being waited for, -1
// once the piece is finished) and `marks` maps a note index to 'hit' | 'miss'.
//
// ONE KEY, ONE NOTE: every key played is judged against the note being waited
// for and the lesson moves on either way, right or wrong. It waited on a wrong
// key at first — the note went red and stayed put until the right key was
// found — and that was reported from the field as the lesson getting stuck.
// There is no clock: the student sets the pace.

import { state } from './state.js';
import { semiOf } from './config.js';

// Absolute, so Sá of one sthayi and Sa of the next are the same key.
const pitchOf = n => n.oct * 12 + semiOf(n.svaraIndex, n.head);

const nextNote = from => state.notes.findIndex((n, i) => i >= from && n.type === 'note');

function changed() {
  globalThis.document?.dispatchEvent(new Event('lesson:changed'));
}

export function startLesson(id, mode = 'listen') {
  state.lesson = { id, mode, pos: nextNote(0), marks: {} };
  changed();
}

export function endLesson() {
  if (!state.lesson) return;
  state.lesson = null;
  changed();
}

// Switching mode starts the piece again: a half-marked run is not a score.
export function setLessonMode(mode) {
  if (state.lesson) startLesson(state.lesson.id, mode);
}

export function lessonScore() {
  const hits = Object.values(state.lesson?.marks || {}).filter(m => m === 'hit').length;
  return { hits, total: state.notes.filter(n => n.type === 'note').length };
}

// A key was played while a lesson is open. Nothing is ever written; in
// play-along the key is judged against the note being waited for.
// ponytail: walks state.notes in order, so a repeat is played once. Expand
// through buildPlaySeq() if lessons with repeat marks need them counted.
export function lessonKey(svaraIndex, head, oct) {
  const L = state.lesson;
  const want = L && L.mode === 'play' ? state.notes[L.pos] : null;
  if (!want) return;
  L.marks[L.pos] = pitchOf({ svaraIndex, head, oct }) === pitchOf(want) ? 'hit' : 'miss';
  L.pos = nextNote(L.pos + 1);
  changed();
}
