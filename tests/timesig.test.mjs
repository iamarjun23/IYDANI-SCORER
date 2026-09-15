// The metre and the repeat model are both pure — no DOM, no localStorage
// needed — so the rules that matter can be driven directly:
//   · a formula is the whole definition: the sum is the division, the interior
//     edges are the group lines and the metronome accents
//   · a custom metre never shadows a builtin, and a builtin is never deletable
//   · the METRE decides how big a box is, so packing follows the selection
//   · repeats pair the way playback pairs them, and a nest is refused

import assert from 'node:assert/strict';
import { state } from '../src/renderer/state.js';
import {
  TIME_UNITS_PER_BEAT, TALAS, BOXES_PER_ROW, USABLE_W, MIN_BEAT_W,
} from '../src/renderer/config.js';
import {
  parseFormula, formulaError, formulaOf, beatsOf, normaliseTala, groupEdges, isGroupStart,
  allTalas, talaDef, beatsPerBox, boxUnits, boxesPerRow, addTala, updateTala, removeTala,
  registerTala, talaForSave, isCustom, isBuiltin, resetTalas,
} from '../src/renderer/timesig.js';
import {
  scoreRows, unitPos, unitAtX, cellAtX, usableWidth,
} from '../src/renderer/notation.js';
import {
  repeatPairs, validateBars, withBarMoved, withPairAdded, ensureBarIds,
  ensureBarUnits, endUnit, resolveMark,
} from '../src/renderer/repeat-model.js';
import { buildPlaySeq } from '../src/renderer/playback.js';

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };

const note = (svaraIndex = 0, sym = 'bindu', dur = 1) => ({
  type: 'note', svaraIndex, oct: 0, head: 'o', sym, dot: false, dur, deco: 'none',
});

// ---- parsing ---------------------------------------------------------------
eq(parseFormula('3+2+2'), [3, 2, 2], 'plus-separated groups');
eq(parseFormula('4'), [4], 'a single group is a formula too');
eq(parseFormula(' 3 + 2 '), [3, 2], 'spaces around the signs are ignored');
eq(parseFormula('3, 2, 2'), [3, 2, 2], 'commas separate as well');
eq(parseFormula(''), null, 'nothing is not a metre');
eq(parseFormula('0+4'), null, 'a group of no beats is refused');
eq(parseFormula('3.5'), null, 'a fractional beat is refused');
eq(parseFormula('x+2'), null, 'a non-number is refused');
eq(parseFormula('99+99'), null, 'past the sanity bound is refused');
eq(formulaOf([3, 2, 2]), '3+2+2', 'groups print back as the formula');
eq(beatsOf([3, 2, 2]), 7, 'the sum is the division');

// A metre written the way it is PRINTED. `6/4` is how the sheet states this
// metre and how most people write one down, so it must be enterable — it means
// one group of six, exactly as `6` does, and the metronome ticks six times.
eq(parseFormula('6/4'), [6], '6/4 is six beats in one group');
eq(parseFormula('6/4'), parseFormula('6'), '6/4 and 6 are the same metre');
eq(parseFormula('4+2/4'), [4, 2], 'the groups may be written over the denominator too');
eq(parseFormula('6 / 4'), [6], 'spaces around the slash are ignored');
eq(parseFormula('6/8'), null, 'a denominator this app cannot count in is refused');
eq(parseFormula('/4'), null, 'a denominator with no beats is not a metre');
eq(parseFormula('0/4'), null, 'nor is a metre of no beats');

// The dialog must not describe a rule the parser does not enforce, so the
// reason lives beside the rule. A bad denominator gets its own sentence — the
// generic hint reads as if the whole line were gibberish.
eq(formulaError('4+2'), null, 'a good formula has no complaint');
eq(formulaError('6/4'), null, 'and neither does a good time signature');
ok(/Only \/4/.test(formulaError('6/8')), '6/8 is told why it was refused');
ok(formulaError('x+2') && !/Only \/4/.test(formulaError('x+2')),
  'a formula with no denominator gets the general hint instead');
ok(formulaError(''), 'an empty field is reported too');

// It survives the round trip the registry does on everything: a metre entered
// as 6/4 is stored, saved and printed back as its groups.
eq(normaliseTala({ label: 'Six', formula: '6/4' }).formula, '6',
  'a time signature normalises to its groups');
eq(normaliseTala({ label: 'Six', formula: '6/4' }).beats, 6,
  'and to the beat count the metronome will tick');

// A definition is only ever trusted after its own formula is re-read, so a
// hand-edited file cannot claim a length its groups do not add up to.
eq(normaliseTala({ label: 'X', formula: '3+2+2', beats: 99 }).beats, 7,
  'beats are recomputed from the formula, never taken on trust');
eq(normaliseTala({ label: '', formula: '5' }).label, '5',
  'a metre with no name is named after its formula');
eq(normaliseTala({ formula: 'nope' }), null, 'an unparseable formula is not a metre');

// ---- group edges -----------------------------------------------------------
eq(groupEdges([4]), [], 'a single group has no interior edge');
eq(groupEdges([4, 4]), [4], 'ADI rules its division at the fifth beat');
eq(groupEdges([3, 2, 2]), [3, 5], '3+2+2 rules at beats 3 and 5');
ok(isGroupStart(0, [3, 2, 2]), 'the division line is always a group start');
ok(isGroupStart(3, [3, 2, 2]) && isGroupStart(5, [3, 2, 2]), '3+2+2 accents 1, 4 and 6');
ok(!isGroupStart(1, [3, 2, 2]) && !isGroupStart(4, [3, 2, 2]), 'and nothing between them');

// ---- the registry ----------------------------------------------------------
resetTalas();
Object.keys(TALAS).forEach(k => ok(isBuiltin(k) && !isCustom(k), `${k} is a builtin`));
eq(talaDef('nonesuch').key, 'chatusra', 'an unknown key falls back to the plain 4');

const key = addTala({ label: 'My Metre', formula: '3+2+2' });
ok(isCustom(key) && !isBuiltin(key), 'a new metre is custom');
ok(key.startsWith('u-'), 'custom keys are prefixed, so they cannot shadow a builtin');
eq(talaDef(key).beats, 7, 'and it is seven beats long');
eq(Object.keys(allTalas()).length, Object.keys(TALAS).length + 1, 'it joins the list');

const twin = addTala({ label: 'My Metre', formula: '5' });
ok(twin !== key, 'two metres may share a name without sharing a key');

ok(updateTala(key, { label: 'Renamed', formula: '2+2+3' }), 'a custom metre can be edited');
eq(talaDef(key).formula, '2+2+3', 'the edit sticks');
eq(updateTala('adi', { label: 'Nope', formula: '9' }), null, 'a builtin cannot be edited');
eq(removeTala('adi'), false, 'a builtin cannot be deleted — saved files name it');
ok(removeTala(twin), 'a custom metre can be deleted');

// A definition arriving with a document registers under its own key, and never
// overwrites one already in the registry.
resetTalas();
eq(registerTala({ key: 'u-from-file', label: 'From File', formula: '3+4' }), 'u-from-file',
  'a metre travelling in a file is adopted');
eq(talaDef('u-from-file').beats, 7, 'with its own length');
registerTala({ key: 'u-from-file', label: 'Different', formula: '9' });
eq(talaDef('u-from-file').label, 'From File', 'a second file does not rewrite it');
eq(registerTala({ key: 'adi', label: 'Hijack', formula: '9' }), 'adi',
  'and a builtin key is never taken over');
eq(talaDef('adi').formula, '4+4', 'ADI is still ADI');

// ---- the metre drives the staff -------------------------------------------
state.tala = 'chatusra';
eq(beatsPerBox(), 4, 'CHATUSRA is the plain four the staff has always drawn');
eq(boxUnits(), 4 * TIME_UNITS_PER_BEAT, 'a division is its beats in timing units');

const twelve = Array.from({ length: 12 }, () => note());
state.tala = 'chatusra';
let rows = scoreRows(twelve, [], []);
let boxes = rows.flatMap(r => r.boxes).filter(b => b.entries.length);
eq(boxes.length, 3, 'twelve beats fill three divisions of four');

state.tala = 'misra';               // 4+3 — seven beats
eq(beatsPerBox(), 7, 'selecting a tala changes the metre, not just the caption');
rows = scoreRows(twelve, [], []);
boxes = rows.flatMap(r => r.boxes).filter(b => b.entries.length);
eq(boxes.length, 2, 'the same twelve beats fill two divisions of seven');
const used = boxes.map(b => b.entries.reduce((u, e) => u + e.units, 0));
eq(used, [boxUnits(), boxUnits()], 'and every division is padded to the new capacity');

state.tala = 'chatusra';

// ---- and the metre decides how many divisions a row holds ------------------
// A division is one CYCLE, so four of them to a row is four cycles: sixteen
// beats under CHATUSRA and thirty-two under ADI, in the same 18 cm of staff.
// The row is measured in beats instead — a beat never gets less than
// MIN_BEAT_W — so a longer cycle takes fewer divisions rather than halving
// every glyph on the page.
eq(boxesPerRow(4), 4, 'a four-beat cycle still fits four to a row');
eq(boxesPerRow(5), 3, 'KHANDA CHAPU takes three');
eq(boxesPerRow(6), 3, 'RUPAKA takes three');
eq(boxesPerRow(7), 2, 'MISRA CHAPU takes two');
eq(boxesPerRow(8), 2, 'ADI takes two');

for (const [key, def] of Object.entries(TALAS)) {
  const n = boxesPerRow(def.beats);
  ok(USABLE_W / n / def.beats >= MIN_BEAT_W,
    `${key}: a beat keeps its room on the staff`);
  ok(n >= 1 && n <= BOXES_PER_ROW, `${key}: between one division and the ceiling`);
}

eq(boxesPerRow(1), BOXES_PER_ROW, 'and a short cycle is capped, not multiplied out');
eq(boxesPerRow(64), 1, 'while a cycle too long to fit even once still gets its row');
eq(boxesPerRow(0), BOXES_PER_ROW, 'a nonsense beat count falls back rather than dividing by it');
eq(boxesPerRow(NaN), BOXES_PER_ROW, 'and so does NaN');

// Floored, never rounded up: the justifier stretches a short row back out to
// the staff edge, so spacing is the cost of one division too few — crowding is
// the cost of one too many.
ok(boxesPerRow(6) * 6 * MIN_BEAT_W <= USABLE_W, 'RUPAKA does not overrun the floor it was given');

// The rule reaches the staff, not just the arithmetic.
state.tala = 'adi';
const sixteen = Array.from({ length: 16 }, () => note());
rows = scoreRows(sixteen, [], []);
eq(rows[0].boxes.length, 2, 'an ADI row is drawn as two divisions, not four');
ok(Math.abs(rows[0].boxes.reduce((w, b) => w + b.width, 0) - usableWidth()) < 0.001,
  'and a full ADI row still measures the staff exactly');
const empty = scoreRows([], [], []);
eq(empty[0].boxes.length, 2, 'a fresh ADI score opens on two divisions to type into');

state.tala = 'chatusra';
eq(scoreRows([], [], [])[0].boxes.length, 4, 'and CHATUSRA is untouched — still four');

// ---- repeat marks ----------------------------------------------------------
// A mark lives on the CLOCK, not on a note: it can be dropped anywhere, on
// written music or on empty staff, and it stays where it was put.
const bars = ensureBarIds([
  { unit: 0, kind: 'open', count: 2 },
  { unit: 8, kind: 'close', count: 2 },
]);
ok(bars.every(b => b.id), 'every mark gets an id, however old the file is');
eq(repeatPairs(bars).length, 1, 'an open and a later close are one pair');
eq(repeatPairs(bars)[0].closeUnit, 8, 'the pair covers what lies between them');
eq(repeatPairs([bars[0]]).length, 0, 'an unmatched open is not a pair');

// Marks from before repeats moved onto the clock name a note index; converting
// one adds up what the notes in front of it are worth.
const legacy = ensureBarUnits(
  [{ at: 2, kind: 'open', count: 2 }],
  [note(0, 'guru', 2), note(0, 'bindu', 1), note(0)],
  TIME_UNITS_PER_BEAT,
);
eq(legacy[0].unit, 3 * TIME_UNITS_PER_BEAT, 'a note index converts to its point on the clock');
eq(legacy[0].at, undefined, 'and the stale index is left behind');
eq(endUnit([note(), note(0, 'guru', 2)], TIME_UNITS_PER_BEAT), 3 * TIME_UNITS_PER_BEAT,
  'the written music ends where its durations add up to');

ok(validateBars(bars).ok, 'a flat pair reads');
eq(validateBars([{ unit: 0, kind: 'close' }]).reason, 'unopened',
  'a close with nothing open is backwards');
eq(validateBars([
  { unit: 0, kind: 'open' }, { unit: 2, kind: 'open' },
  { unit: 4, kind: 'close' }, { unit: 6, kind: 'close' },
]).reason, 'nested', 'a nested pair is refused — playback expands one pair at a time');
ok(validateBars([
  { unit: 0, kind: 'open' }, { unit: 4, kind: 'close' },
  { unit: 4, kind: 'open' }, { unit: 8, kind: 'close' },
]).ok, 'but one repeat ending where the next begins is fine');

// A drop is judged before it lands, on a copy — the score itself is untouched
// until the move is known to read.
const moved = withBarMoved(bars, bars[1].id, 4);
eq(moved[1].unit, 4, 'the copy carries the move');
eq(bars[1].unit, 8, 'the original is untouched');
ok(!validateBars(withPairAdded(bars, 2, 4, 2)).ok,
  'dropping a pair inside an existing one is refused');
ok(validateBars(withPairAdded(bars, 8, 16, 2)).ok,
  'dropping one after it is allowed');

// ---- placing a mark anywhere -----------------------------------------------
// The staff is a clock in both directions: a point on it draws at a place, and
// a place on it reads back as the same point. Nothing is snapped to a division
// on the way through, which is what "drop it where you like" needs.
state.tala = 'chatusra';
const eight = Array.from({ length: 8 }, () => note());
const laid = scoreRows(eight, [], []);
const CAP = TIME_UNITS_PER_BEAT * 4;

const startPos = unitPos(laid, 0);
eq(startPos.x, 0, 'the start of the score is the left edge of its first division');
ok(unitPos(laid, CAP).x > startPos.x, 'the second division starts further along');

// A point INSIDE a division lands between its edges — a division edge is not
// the only place a mark can be.
const mid = unitPos(laid, Math.round(CAP / 2));
ok(mid.x > unitPos(laid, 0).x && mid.x < unitPos(laid, CAP).x,
  'a mark half-way through a division is drawn half-way through it');

[0, 5, 13, CAP, CAP + 9].forEach(u => {
  const p = unitPos(laid, u);
  const back = Math.round(unitAtX(laid, p.row, p.x));
  eq(back, u, `unit ${u} survives the round trip through the page`);
});

// Empty staff past the written music is still a place: the padding divisions
// carry the clock on, so a brace may be parked out there.
const past = unitPos(laid, CAP * 3 + 4);
ok(past && past.x > 0, 'a mark can sit past the end of the music');

// ---- where a repeat actually cuts ------------------------------------------
// A mark is dropped freely, so it resolves onto the GLYPH it is over rather
// than onto an edge: the note the brace's ink covers is the note in the loop.
// Resolving to an edge was wrong twice over — rounding forward shifted the
// whole segment one note right, and rounding to the nearest edge put a cliff
// down the middle of every note, so aiming at the note you wanted the loop to
// start on and landing in its right half skipped that note.
const cells = [0, 8, 16, 24].map(at => ({ at, units: 8 }));   // four one-beat notes
[0, 1, 4, 6, 7].forEach(u =>
  eq(resolveMark(u, 'open', cells), 0,
    `an opening brace anywhere on the first note (unit ${u}) starts the loop with it`));
[9, 12, 15].forEach(u =>
  eq(resolveMark(u, 'open', cells), 8,
    `and anywhere on the second note (unit ${u}) starts the loop there`));
[1, 4, 7, 8].forEach(u =>
  eq(resolveMark(u, 'close', cells), 8,
    `a closing brace anywhere on the first note (unit ${u}) ends the loop after it`));
eq(resolveMark(8, 'open', cells), 8, 'on an edge, an opening brace takes the note starting there');
eq(resolveMark(8, 'close', cells), 8, 'and a closing brace the note ending there');
eq(resolveMark(40, 'open', cells), 40, 'a mark parked past the music is left where it was put');
eq(resolveMark(5, 'open', []), 5, 'with nothing written there is no glyph to belong to');

// The bug, end to end: eight bindus, a pair laid over the first four. Wherever
// on those notes the braces are aimed, the loop is the same four notes.
state.tala = 'chatusra';
state.notes = [0, 1, 2, 3, 4, 5, 6, 7].map(i => note(i));
const played = (openUnit, closeUnit) => {
  state.bars = [
    { id: 'o', unit: openUnit, kind: 'open', count: 2 },
    { id: 'c', unit: closeUnit, kind: 'close', count: 2 },
  ];
  return buildPlaySeq().map(it => it.n.svaraIndex).join('');
};
[[0, 32], [2, 25], [4, 27], [6, 30], [7, 31]].forEach(([o, c]) =>
  eq(played(o, c), '012301234567',
    `braces aimed at notes 0 and 3 (units ${o}, ${c}) repeat exactly those four`));
eq(played(6, 30), '012301234567',
  'the first note is not skipped when the brace lands in the right half of its cell');
eq(played(16, 47), '012345234567', 'a pair further along repeats the notes it covers');
// Dropped exactly on the edges either side of notes 3 and 4, the loop is those
// two notes and nothing else — an edge still means precisely what it says.
eq(played(24, 40), '0123434567', 'exact edges are honoured exactly');
// A cell is a fixed width on the PAGE but its length on the CLOCK is whatever
// the symbol is worth, so a pointer is resolved against the cells directly.
// Turning x into a time first and rounding it lost short symbols: a danta cell
// is one unit long, so past its midpoint the drop landed on the next note and
// the note it was aimed at was skipped. Dense notation made that most of every
// cell, which is what "placing the mark too close to the notation" hit.
[['danta', 0.125], ['praya', 0.25], ['vasu', 0.5], ['bindu', 1]].forEach(([sym, dur]) => {
  const line = Array.from({ length: 16 }, (_, i) => ({
    type: 'note', svaraIndex: i % 7, oct: 0, head: 'o', sym, dot: false, dur, deco: 'none',
  }));
  const laid = scoreRows(line, [], []);
  let wrong = 0;
  let swept = 0;
  laid.forEach((row, ri) => row.boxes.forEach(b => b.entries.forEach(e => {
    for (let f = 0.02; f < 1; f += 0.04) {
      swept += 1;
      const cell = cellAtX(laid, ri, e.x + e.w * f);
      if (!cell || cell.at !== e.at || cell.units !== e.units) wrong += 1;
    }
  })));
  ok(swept > 0 && wrong === 0,
    `a pointer anywhere on a ${sym} resolves to that ${sym}, wherever it is in the cell`);
});

state.bars = [];
state.notes = [];

console.log(`timesig: ${checks} checks passed`);
