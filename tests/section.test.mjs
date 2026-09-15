// npm run test:section
//
// The section panel is a piano roll over one division, and two separate things
// in it can be wrong without throwing: WHERE a note is drawn (its lane) and
// WHAT a drag does to the score. Both are pure here — rollModel() takes rows
// and returns geometry, and the three mutations take an index and return what
// they did — so both are driven directly rather than through a pointer.
//
// The mutations re-render, so the document is stubbed the way metro-entry does
// it: what is under test is what lands in state.notes.

const el = new Proxy(function () {}, {
  get: (t, k) => (k === 'length' ? 0 : k === Symbol.toPrimitive ? () => '' : el),
  set: () => true,
  apply: () => el,
});
globalThis.document = new Proxy({}, { get: () => el, set: () => true });

const assert = (await import('node:assert/strict')).default;
const { state } = await import('../src/renderer/state.js');
const {
  SOUND, REST_MAP, TIME_UNITS_PER_BEAT, SVARA_RUNG,
} = await import('../src/renderer/config.js');
const { scoreRows, noteY } = await import('../src/renderer/notation.js');
const { boxUnits } = await import('../src/renderer/timesig.js');
const {
  laneList, laneOf, rowOfLane, landingRow, rollModel,
  LANE_TOP, LANE_BOT, LANE_COUNT,
} = await import('../src/renderer/section.js');
const {
  setNotePitch, setNoteHead, nudgeNote, nudgeRoom, moveNote,
} = await import('../src/renderer/score.js');

let checks = 0;
const is = (a, b, m) => { checks += 1; assert.equal(a, b, m); };
const ok = (v, m) => { checks += 1; assert.ok(v, m); };
const eq = (a, b, m) => { checks += 1; assert.deepEqual(a, b, m); };

const note = (svaraIndex = 0, oct = 0, sym = 'bindu') => ({
  type: 'note', svaraIndex, oct, head: '', sym, dur: SOUND[sym].dur,
});
const unitsOf = n => Math.round(n.dur * TIME_UNITS_PER_BEAT);
const totalUnits = () => state.notes.reduce((u, n) => u + unitsOf(n), 0);
const before = i => state.notes.slice(0, i).reduce((u, n) => u + unitsOf(n), 0);

const fresh = notes => {
  state.notes = notes;
  state.bars = [];
  state.breaks = [];
  state.hist = [];
  state.future = [];
  state.fill = 'auto';
};

// ---- the ladder, as lanes -------------------------------------------------
//
// A lane is a RUNG, not a semitone, and the whole point of that choice is that
// this file can check the roll against noteY() — the staff's own placement —
// rather than against a second table that could drift away from it.

const lanes = laneList();
is(lanes.length, LANE_COUNT, 'three sthayis of eight rungs');
is(LANE_COUNT, 24, '...which is 24 lanes');
eq(lanes.filter(l => l.dead).map(l => l.pos), [11, 3, -5],
  'the magic line and its two octave echoes are the dead lanes');
is(lanes.filter(l => !l.dead).length, 21, '21 lanes can be written on');

// Reading the letters down the gutter gives the ladder three times over. The
// gap sits between Ma and Ga, which is the rung SVARA_RUNG skips.
is(lanes.map(l => (l.dead ? '-' : l.letter)).join(''),
  'NDPM-GRSNDPM-GRSNDPM-GRS', 'every band reads the same way down');
is(SVARA_RUNG[3] - SVARA_RUNG[2], 2, 'Ga to Ma is the double step that leaves it');

is(laneOf(0, 0), 0, 'madhya Sa is the origin of the ladder');
is(laneOf(0, 1) - laneOf(0, 0), 8, 'an octave is 8 lanes going up');
is(laneOf(0, 0) - laneOf(0, -1), 8, '...and 8 going down');
is(laneOf(6, 1), LANE_TOP, 'taara Ni is the top lane');
is(laneOf(0, -1), LANE_BOT, 'mandra Sa is the bottom one');

// The roll and the staff must order pitch identically: a higher lane is a
// higher note, and the same rung is the same note. Sá of one sthayi is Sa of
// the next and lands on ONE lane, exactly as it lands on one staff line.
for (let oct = -1; oct <= 1; oct += 1) {
  for (let svi = 0; svi < 7; svi += 1) {
    const row = rowOfLane(laneOf(svi, oct));
    ok(row >= 0 && row < LANE_COUNT, `${svi}/${oct} lands on a lane`);
    ok(!lanes[row].dead, `${svi}/${oct} never lands on a dead lane`);
    is(lanes[row].svi, svi, `${svi}/${oct} keeps its svara`);
    is(lanes[row].oct, oct, `${svi}/${oct} keeps its sthayi`);
    if (svi < 6) {
      // Higher pitch is a smaller y on the staff and a smaller row here.
      const next = rowOfLane(laneOf(svi + 1, oct));
      ok(next < row, `${svi + 1} sits above ${svi} in the gutter`);
      ok(noteY(svi + 1, oct) < noteY(svi, oct), '...as it does on the staff');
    }
  }
}

// A drag onto a dead lane is not refused — it steps over, in the direction of
// travel. Refusing would make the empty rung a wall two lanes thick, when what
// it is on the staff is a line you pass through.
is(landingRow(rowOfLane(3), 1), rowOfLane(3) + 1, 'a downward drag passes the dead lane');
is(landingRow(rowOfLane(3), -1), rowOfLane(3) - 1, 'an upward drag passes it the other way');
is(landingRow(rowOfLane(0), 1), rowOfLane(0), 'a live lane is left where it is');
is(landingRow(-5, -1), 0, 'the top of the ladder clamps');
is(landingRow(99, 1), LANE_COUNT - 1, '...and so does the bottom');

// ---- the model ------------------------------------------------------------

const cap = boxUnits();
const modelOf = at => {
  const rows = scoreRows();
  const box = rows.flatMap(r => r.boxes).find(b => Number(b.at) === at);
  return rollModel(box, rows, cap);
};

fresh([note(0), note(2), note(4, 1), note(0, -1)]);   // Sa Ga taara-Pa mandra-Sa
{
  const m = modelOf(0);
  is(m.notes.length, 4, 'four notes in the division');
  is(m.rests.length, 0, 'and no silence to fill');
  // Pa is rung 5, not 4: the ladder takes a double step between Ga and Ma, so
  // the two above it are not where counting svaras would put them.
  eq(m.notes.map(p => p.lane), [0, 2, 13, -8], 'each on its own rung');
  eq(m.notes.map(p => p.row), [15, 13, 2, 23], 'drawn top-down from the highest');
  is(m.notes[0].filled, false, 'Sa is hollow');
  ok(m.notes.every(p => !p.offLadder), 'nothing is off the ladder');
}

fresh([note(1), note(5)]);                            // Ri Da, both auto-filled
{
  const m = modelOf(0);
  eq(m.notes.map(p => p.filled), [true, true],
    'auto resolves to the LOWERED form on Ri and Da, as the staff draws them');
  is(m.rests.length, 2, 'the half-empty division is padded with rests');
  ok(m.rests.every(p => p.index == null), '...and the padding is derived, not score');
}

// A note too long for the room left is split at the box line and arrives here
// as a tail. It is ONE block reporting the WHOLE note, or a drag on it would
// truncate the note by the act of looking at it.
fresh([note(0, 0, 'bindu'), note(2, 0, 'Maguru')]);
{
  const first = modelOf(0);
  const second = modelOf(cap);
  is(first.notes.length, 2, 'the Maguru starts in the first division');
  const tail = second.notes[0];
  is(tail.index, 1, 'and continues as the same source note');
  ok(tail.before > 0, 'the tail knows what came before it');
  is(tail.total, unitsOf(state.notes[1]), '...and reports the whole played length');
  is(tail.lane, laneOf(2, 0), 'a split note keeps its rung on both sides of the seam');
}

// ---- moving a note --------------------------------------------------------
//
// The gap in front of the note is what a sideways drag edits, so what it must
// never do is invent or destroy anything else: the note count either side of
// it is the same, and the silence it writes is legal silence.

const restsAreLegal = m => state.notes.every(n => n.type !== 'rest'
  || SOUND[REST_MAP[n.sym]].dur === n.dur);

fresh([note(0), note(2)]);
{
  const notes0 = totalUnits();
  is(nudgeRoom(1, 4), 4, 'silence can always be inserted');
  is(nudgeNote(1, 4), 4, 'the note moves four dantas later');
  is(before(state.notes.findIndex(n => n.svaraIndex === 2)), unitsOf(note(0)) + 4,
    'and now starts four units further on');
  is(totalUnits(), notes0 + 4, 'the score is longer by exactly the gap');
  ok(restsAreLegal(), 'every rest it wrote has a dur its symbol can draw');
  is(state.notes.filter(n => n.type === 'note').length, 2, 'no note was invented or lost');
  is(state.hist.length, 1, 'one drag, one undo');
}
{
  // ...and straight back out again. A nudge is reversible by nudging.
  const i = state.notes.findIndex(n => n.svaraIndex === 2);
  is(nudgeNote(i, -4), -4, 'the gap is absorbed again');
  is(state.notes.length, 2, 'the rests it had written are gone');
  is(before(1), unitsOf(note(0)), 'the note is back where it started');
}

fresh([note(0), note(2)]);
{
  // The wall. There is no silence in front of note 1 — only a note — and
  // swallowing that would delete music to satisfy a drag.
  is(nudgeRoom(1, -4), 0, 'nothing to absorb, so nothing to give');
  is(nudgeNote(1, -4), 0, 'the drag stops dead');
  is(state.notes.length, 2, 'the score is untouched');
  is(state.hist.length, 0, '...and takes no history entry for doing nothing');
}

fresh([note(0), note(2)]);
{
  // A partial absorb has to re-express what stays behind, or the leftover rest
  // would keep a dur its glyph no longer stands for.
  nudgeNote(1, 8);
  const i = state.notes.findIndex(n => n.svaraIndex === 2);
  is(nudgeNote(i, -3), -3, 'three of the eight units come back out');
  ok(restsAreLegal(), 'the five that stay are still legal rests');
  is(before(state.notes.findIndex(n => n.svaraIndex === 2)), unitsOf(note(0)) + 5,
    'and measure exactly five units');
}

fresh([note(0), note(2)]);
{
  // The drag cannot absorb more than there is, however far it is pulled.
  nudgeNote(1, 4);
  const i = state.notes.findIndex(n => n.svaraIndex === 2);
  is(nudgeRoom(i, -40), -4, 'the room is what exists, not what was asked for');
  is(nudgeNote(i, -40), -4, '...and that is what moves');
  is(state.notes.length, 2, 'the gap closed completely');
}

// ---- pitch and notehead ---------------------------------------------------

fresh([note(0)]);
is(setNotePitch(0, 4, 1), true, 'a note can be dragged to another rung');
is(state.notes[0].svaraIndex, 4, 'it took the svara');
is(state.notes[0].oct, 1, '...and the sthayi');
is(setNotePitch(0, 4, 1), false, 'dropping it where it already is changes nothing');
is(state.hist.length, 1, '...and takes no history entry for it');
is(setNotePitch(0, 9, 0), false, 'a svara off the ladder is refused');
is(setNotePitch(0, 0, 3), false, 'so is a fourth sthayi');

fresh([note(1)]);
is(setNoteHead(0, 'o'), true, 'Ri can be written as its natural');
is(state.notes[0].head, 'o', '...and says so');
is(setNoteHead(0, 'o'), false, 'flipping it to what it already is does nothing');
is(setNoteHead(0, 'f'), true, 'and back to the lowered form');

fresh([note(0)]);
is(setNoteHead(0, 'f'), false, 'Sa has no lowered form, so the flip is a no-op');
is(state.hist.length, 0, '...and no undo entry is left behind for it');

// A note dragged onto Sa or Pa cannot keep a filled goli: it would be drawn as
// a variant the svara does not have, and sounded as the natural it is not.
fresh([{ ...note(1), head: 'f' }]);
setNotePitch(0, 0, 0);
is(state.notes[0].head, 'o', 'the notehead is dropped along with the rung');

// ---- one gesture, one undo ------------------------------------------------

fresh([note(0), note(2)]);
{
  is(moveNote(1, { svaraIndex: 5, oct: 1, delta: 4 }), true, 'pitch and position together');
  const i = state.notes.findIndex(n => n.type === 'note' && n.svaraIndex === 5);
  is(state.notes[i].oct, 1, 'the sthayi took');
  is(before(i), unitsOf(note(0)) + 4, 'and so did the move');
  is(state.hist.length, 1, 'ONE history entry for the whole drag');
  is(moveNote(1, {}), false, 'a drag that changed nothing writes nothing');
  is(state.hist.length, 1, '...and leaves the stack alone');
}

console.log(`section: ${checks} checks passed`);
