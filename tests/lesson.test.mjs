// Play-along judging: every key marks the note hit or missed and moves on,
// rests are skipped, and nothing is judged outside play-along.

import assert from 'node:assert/strict';
import { state } from '../src/renderer/state.js';
import { startLesson, lessonKey, lessonScore, endLesson } from '../src/renderer/lesson.js';

const note = (svaraIndex, oct = 0) => ({ type: 'note', svaraIndex, oct, head: 'auto', sym: 'bindu', dur: 1 });
const rest = { type: 'rest', sym: 'bindu_rest', dur: 1 };

// Sa, (rest), Ri, upper Sá
state.notes = [note(0), rest, note(1), note(7)];

startLesson('x', 'listen');
lessonKey(0, 'auto', 0);
assert.equal(state.lesson.pos, 0, 'listen mode judges nothing');

startLesson('x', 'play');
lessonKey(0, 'auto', 0);
assert.equal(state.lesson.marks[0], 'hit');
assert.equal(state.lesson.pos, 2, 'the rest is skipped');

lessonKey(2, 'auto', 0);
assert.equal(state.lesson.marks[2], 'miss');
assert.equal(state.lesson.pos, 3, 'a wrong key is marked and the lesson moves on');

lessonKey(0, 'auto', 1);
assert.equal(state.lesson.marks[3], 'hit', 'taara Sa is the same key as madhya upper Sa');
assert.equal(state.lesson.pos, -1, 'finished');
assert.deepEqual(lessonScore(), { hits: 2, total: 3 });

lessonKey(0, 'auto', 0);
assert.equal(state.lesson.pos, -1, 'keys after the end are ignored');

endLesson();
assert.equal(state.lesson, null);
console.log('lesson: ok');
