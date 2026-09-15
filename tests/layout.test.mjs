// Layout self-check. Run with: npm run test:layout
//
// Covers the pure parts of notation.js — rest fill, box packing, row wrapping
// and where repeat marks sit on the clock. No DOM, no Electron. Everything asserted here is
// a rule from docs/reference/DNG-BOX-LAYOUT.md.

import assert from 'node:assert/strict';
import { padRests, scoreRows, expandScore, boxUnits, usableWidth } from '../src/renderer/notation.js';
import {
  SOUND, TIME_UNITS_PER_BEAT, BOXES_PER_ROW, GLYPH_W, GLYPH_W_OF, BOX_PAD, GLYPH_GAP,
  VW, BX0, toMM, PAGE_W_MM, PAGE_H_MM, SHEET_PAD_X, SHEET_W_MM,
  SHEET_PAD_TOP, SHEET_PAD_BOT, PILL_BOTTOM, PILL_H_MM,
  rgb, SHEET_INK, TONE_BG, TONE_LINE, BRAND_COLOR,
} from '../src/renderer/config.js';

const units = sym => Math.round(SOUND[sym].dur * TIME_UNITS_PER_BEAT);
const note = (sym = 'bindu', svaraIndex = 0) => ({
  type: 'note', svaraIndex, oct: 0, head: 'auto', sym, dur: SOUND[sym].dur, deco: SOUND[sym].deco,
});
const restUnits = list => list.reduce((n, r) => n + Math.round(r.dur * TIME_UNITS_PER_BEAT), 0);
const CAP = boxUnits();

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };

console.log('\npadRests');

check('empty when nothing is left over', () => {
  assert.deepEqual(padRests(0), []);
});

check("one Bindu leaves three beat-countable Bindu rests", () => {
  const out = padRests(CAP - units('bindu'));          // 32 - 8 = 24
  assert.equal(out.length, 3);
  assert.deepEqual(out.map(r => r.dur), [SOUND.bindu.dur, SOUND.bindu.dur, SOUND.bindu.dur]);
  assert.equal(restUnits(out), 24);
});

check('beat-countable rests, largest aligned value first', () => {
  // 31 units => 3 Bindus + Vasu + Praya + Danta. Derived padding caps
  // rests at one beat so the pulse remains visible.
  const out = padRests(31);
  assert.deepEqual(out.map(r => r.dur), [
    SOUND.bindu.dur, SOUND.bindu.dur, SOUND.bindu.dur,
    SOUND.vasu.dur, SOUND.praya.dur, SOUND.danta.dur,
  ]);
  assert.equal(restUnits(out), 31);
});

check('every remainder is expressible exactly', () => {
  for (let n = 0; n <= CAP; n++) assert.equal(restUnits(padRests(n)), n, 'failed at ' + n);
});

check('rests carry a key restMark can resolve', () => {
  for (const r of padRests(31)) assert.equal(typeof r.sym, 'string');
});

console.log('\nbox packing');

const boxesOf = rows => rows.flatMap(r => r.boxes).filter(b => b.entries.length);

check('a lone Maguru fills its box, so no padding', () => {
  const boxes = boxesOf(scoreRows([note('Maguru')], []));
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].entries.length, 1);
});

check('a lone Bindu is padded to capacity with 3 beat rests', () => {
  const boxes = boxesOf(scoreRows([note('bindu')], []));
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].entries.length, 4);            // Bindu + three Bindu rests
  assert.equal(boxes[0].entries[0].index, 0);
  assert.deepEqual(boxes[0].entries.slice(1).map(e => e.index), [null, null, null]);
});

check('every box sums to exactly capacity once padded', () => {
  const score = [note('bindu'), note('danta'), note('guru'), note('praya'), note('Maguru')];
  for (const b of boxesOf(scoreRows(score, []))) {
    const total = b.entries.reduce((n, e) => n + Math.round(e.note.dur * TIME_UNITS_PER_BEAT), 0);
    assert.equal(total, CAP);
  }
});

check('a symbol crossing a boundary is split and tied', () => {
  // Guru (16) then Maguru (32): half of Maguru fills box one and continues.
  const boxes = boxesOf(scoreRows([note('guru'), note('Maguru')], []));
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0].entries[0].index, 0);
  assert.equal(boxes[0].entries[1].index, 1);
  assert.equal(boxes[1].entries[0].index, 1);
  assert.ok(boxes[1].entries[0].tie);
});

check('four Bindu fill one box with no padding', () => {
  const boxes = boxesOf(scoreRows([0, 1, 2, 3].map(() => note('bindu')), []));
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].entries.length, 4);
  assert.ok(boxes[0].entries.every(e => e.index != null));
});

console.log('\nwidths and rows');

check('the cells exactly fill a division, less its padding', () => {
  const [b] = boxesOf(scoreRows([note('bindu')], []));
  const rendered = b.entries.reduce((sum, entry) => sum + entry.w, 0);
  // Summing scaled parts drifts in the last bits of a double; anything the
  // page could show would be far larger than this.
  assert.ok(Math.abs((b.width - 2 * BOX_PAD) - rendered) < 1e-9,
    `${rendered} != ${b.width} - 2x${BOX_PAD}`);
});

// The notation is written INSIDE the division, not against its lines. Glyphs
// are drawn centred in their cells, so with no inset the ink of an edge glyph
// sat about 3 units off the division line in a packed box and read as if it
// were hanging on it.
check('every division leaves room at both ends', () => {
  // Sparse and dense together: the inset has to survive both the box that is
  // scaled UP to fill its quarter and the one that takes the room it needs.
  const score = [note('bindu'), note('bindu'), note('bindu'), note('bindu')]
    .concat(Array.from({ length: CAP }, () => note('danta')))
    .concat([note('Maguru')]);
  for (const b of boxesOf(scoreRows(score, []))) {
    const first = b.entries[0];
    const last = b.entries[b.entries.length - 1];
    assert.ok(Math.abs((first.x - b.x) - BOX_PAD) < 1e-9,
      `left inset ${first.x - b.x} != ${BOX_PAD}`);
    assert.ok(Math.abs((b.x + b.width) - (last.x + last.w) - BOX_PAD) < 1e-9,
      `right inset ${(b.x + b.width) - (last.x + last.w)} != ${BOX_PAD}`);
  }
});

// The inset must not eat into the symbols: a division too full for its quarter
// grows by the padding rather than squeezing the cells to make room for it.
check('a dense division keeps its cells and grows for the padding instead', () => {
  const dense = boxesOf(scoreRows(Array.from({ length: CAP }, () => note('danta')), []))[0];
  // At least: a row a dense division cut short is then stretched back out to
  // the staff edge, which can only give it MORE than the minimum.
  assert.ok(dense.width >= dense.content + 2 * BOX_PAD - 1e-9,
    `${dense.width} < ${dense.content} + 2x${BOX_PAD}`);
  for (const e of dense.entries) {
    assert.ok(e.w >= GLYPH_W + 2 * GLYPH_GAP - 1e-9,
      `a padded dense cell shrank to ${e.w}`);
  }
});

// Every symbol keeps air on BOTH sides of it, not only the two at a division's
// ends — a cell is its scaled share plus an absolute gap. Without it the floor
// was the bare share, and a danta's 15.75-unit bar in a 22-unit cell left half
// a millimetre between one symbol's bars and the next one's: a packed run read
// as one comb of ink rather than as separate notes.
check('every symbol keeps air on both sides of it, at any density', () => {
  // Sparse, exactly-a-quarter, over-full, and over-full enough to take a whole
  // row: the gap has to survive a box scaled up and a box taking its own room.
  const scores = [
    [note('bindu')],
    Array.from({ length: 4 }, () => note('bindu')),
    Array.from({ length: 8 }, () => note('vasu')),
    Array.from({ length: CAP }, () => note('danta')),
  ];
  for (const score of scores) {
    for (const r of scoreRows(score, [])) {
      for (const b of r.boxes) {
        for (const e of b.entries) {
          const share = (GLYPH_W_OF[e.note.type === 'rest' ? '' : e.note.sym] || GLYPH_W);
          assert.ok(e.w >= share + 2 * GLYPH_GAP - 1e-9,
            `cell ${e.w} leaves no air beside a ${e.note.sym} (share ${share})`);
        }
      }
    }
  }
});

// The gap is ABSOLUTE and the share is SCALED, and they stay two different
// things: a Maguru needs more room than a bindu because it carries more ink,
// but the air beside them is about clearance, not duration, so it is the same
// width beside both.
check('the air is the same beside every symbol; only the shares differ', () => {
  // A guru and two bindus are four beats, so all three share one division.
  const [b] = boxesOf(scoreRows([note('guru'), note('bindu'), note('bindu')], []));
  const [wide, plain] = b.entries;
  // cell = share x k + 2 x gap, so the DIFFERENCE is pure share.
  const k = (wide.w - plain.w) / (GLYPH_W_OF.guru - GLYPH_W);
  assert.ok(k > 0, 'the wider symbol still gets the wider cell');
  assert.ok(Math.abs((plain.w - GLYPH_W * k) - 2 * GLYPH_GAP) < 1e-9,
    `bindu air ${plain.w - GLYPH_W * k} != ${2 * GLYPH_GAP}`);
  assert.ok(Math.abs((wide.w - GLYPH_W_OF.guru * k) - 2 * GLYPH_GAP) < 1e-9,
    `guru air ${wide.w - GLYPH_W_OF.guru * k} != ${2 * GLYPH_GAP}`);
});

// The 18 cm is the one thing that never gives. A single division can ask for
// more than the whole staff - six beats of dantas is 48 glyphs, which wanted
// 1068 units against the staff's 905 and drew straight past the closing
// barline - so the row justifier runs in both directions.
check('a division too big for the staff is packed into it, not drawn past it', () => {
  const maxW = usableWidth();
  const huge = Array.from({ length: 48 }, () => note('danta'));
  // 48 dantas is a six-beat division; ask for one directly by handing
  // scoreRows a capacity it cannot fit in a quarter.
  for (const r of scoreRows(huge, [])) {
    assert.ok(r.width <= maxW + 0.001, `row ${r.width} runs past the staff`);
    for (const b of r.boxes) {
      const last = b.entries[b.entries.length - 1];
      if (!last) continue;
      assert.ok(last.x + last.w <= r.width + 0.001,
        `a cell ends at ${last.x + last.w}, past the row's ${r.width}`);
    }
  }
});

// The grid: every division is the same width whatever is written in it, and a
// row holds a fixed number of them. These two are the layout rule, and the one
// thing that overrides them is legibility - see the dense-division checks.
const QUARTER = usableWidth() / BOXES_PER_ROW;

check('every division is the same width, whatever is in it', () => {
  const score = [note('Maguru')]                       // one division, 1 glyph
    .concat([note('guru'), note('guru')])              // one, 2 glyphs
    .concat([note('bindu'), note('bindu'), note('bindu'), note('bindu')]);
  for (const b of boxesOf(scoreRows(score, []))) {
    assert.equal(Math.round(b.width), Math.round(QUARTER));
  }
});

check('a row holds BOXES_PER_ROW divisions and then wraps', () => {
  // One Maguru fills a division, so twelve of them are twelve divisions - which
  // used to draw as one row of narrow boxes and is now three rows of four.
  const score = Array.from({ length: 12 }, () => note('Maguru'));
  const rows = scoreRows(score, []);
  assert.equal(rows.length, 12 / BOXES_PER_ROW);
  for (const r of rows) assert.equal(r.boxes.length, BOXES_PER_ROW);
});

// The grid is a maximum, not a promise: a division holding more glyphs than a
// quarter of the staff can carry takes the room it needs. Squeezing a dense run
// into a quarter drew 15.75-unit bars in 16-unit cells - a fence of ink rather
// than notes - which is the one thing the grid is not worth.
check('a division too full for its quarter takes the room it needs', () => {
  const dense = boxesOf(scoreRows(Array.from({ length: CAP }, () => note('danta')), []))[0];
  assert.ok(dense.width > QUARTER, `${dense.width} !> ${QUARTER}`);
  assert.ok(dense.width >= dense.content, 'and never less than its symbols ask for');
});

check('no cell is ever narrower than its symbol asks for', () => {
  // Every symbol, dense and sparse, across several rows.
  const score = Array.from({ length: CAP }, () => note('danta'))
    .concat(Array.from({ length: 16 }, () => note('praya')))
    .concat([note('bindu'), note('guru'), note('Maguru')]);
  for (const r of scoreRows(score, [])) {
    for (const b of r.boxes) {
      for (const e of b.entries) {
        assert.ok(e.w >= GLYPH_W - 0.001, `cell ${e.w} < ${GLYPH_W}`);
      }
    }
  }
});

check('a row a dense division cut short is stretched to the staff edge', () => {
  // 32 dantas fill a division and ask for 704 units, so a second one will not
  // fit beside it. The row it leaves half empty is stretched out, since that
  // staff is nobody's intent.
  const score = Array.from({ length: 2 * CAP }, () => note('danta'));
  const rows = scoreRows(score, []);
  assert.ok(rows.length > 1, 'two dense divisions do not share a row');
  assert.equal(Math.round(rows[0].width), Math.round(usableWidth()));
  assert.equal(rows[0].boxes.length, 1);
});

check('a full row is exactly the usable width', () => {
  const score = Array.from({ length: 40 }, () => note('bindu'));
  for (const r of scoreRows(score, [])) {
    assert.equal(Math.round(r.width), Math.round(usableWidth()));
  }
});

check('the divisions of a row do not overlap and end on its edge', () => {
  const score = Array.from({ length: 40 }, () => note('bindu'));
  for (const r of scoreRows(score, [])) {
    let x = 0;
    for (const b of r.boxes) {
      assert.equal(Math.round(b.x), Math.round(x));
      x += b.width;
    }
    assert.equal(Math.round(x), Math.round(r.width));
  }
});

// Inside a division the symbols keep the room they asked for, in ratio: what
// the equal-width grid changes is the division, not what is in it. The ratio
// is between the SHARES — each cell also carries an absolute GLYPH_GAP of air
// that is the same beside every symbol, which the check above pins.
check('a lone cell fills its division, and equal symbols share it equally', () => {
  const [box] = boxesOf(scoreRows([note('Maguru')], []));
  const [wide] = box.entries;
  const [pair] = boxesOf(scoreRows([note('guru'), note('guru')], []));
  // The lone cell fills the division's INNER width — the box less the pad at
  // each end, which is the space the cells are scaled into.
  assert.equal(Math.round(wide.w), Math.round(box.width - 2 * BOX_PAD));
  assert.equal(Math.round(pair.entries[0].w), Math.round(pair.entries[1].w));
});

check('an empty score still yields one row', () => {
  const rows = scoreRows([], []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].boxes.length, BOXES_PER_ROW);
  assert.ok(rows[0].boxes.every(b => b.entries.length === 0));
});

console.log('\nexpandScore');

check('pad rests are materialised into the note list', () => {
  const { notes, sourceIndex } = expandScore([note('bindu')], []);
  assert.equal(notes.length, 4);
  assert.deepEqual(sourceIndex, [0, null, null, null]);
  assert.equal(notes[1].type, 'rest');
});

check('state.notes order is preserved in the expansion', () => {
  const score = [note('bindu', 0), note('bindu', 4)];
  const { notes, sourceIndex } = expandScore(score, []);
  assert.equal(notes[sourceIndex.indexOf(0)].svaraIndex, 0);
  assert.equal(notes[sourceIndex.indexOf(1)].svaraIndex, 4);
});

check('a repeat mark still points at its note after padding', () => {
  // Bindu, Guru, Bindu with a close mark on the third. A mark is anchored to
  // the CLOCK, and padding fills time that was already on the clock — so the
  // mark neither moves nor needs remapping, which a note index would have.
  const score = [note('bindu'), note('guru'), note('bindu')];
  const at = 3 * TIME_UNITS_PER_BEAT;
  const bars = [{ unit: at, kind: 'close', count: 2 }];
  const { notes, bars: out, sourceIndex, unitAt } = expandScore(score, bars);
  assert.equal(out[0].unit, at);
  const k = unitAt.indexOf(at);
  assert.equal(notes[k].type, 'note');
  assert.equal(sourceIndex[k], 2);
});

check('a mark past the written music stays where it was put', () => {
  // One bindu fills a quarter of its division; the rest is pad rests. A mark
  // parked out in that silence is still at the point it was dropped on.
  const at = CAP - TIME_UNITS_PER_BEAT;
  const { bars: out, unitAt } = expandScore([note('bindu')], [{ unit: at, kind: 'open', count: 2 }]);
  assert.equal(out[0].unit, at);
  assert.ok(unitAt.includes(at));
});

console.log('\nmanual breaks');

// One Maguru fills a division, so N of them are N divisions — enough to fill a
// row several times over without any of them wrapping mid-box.
const divisions = n => Array.from({ length: n }, () => note('Maguru'));
const ordsOf = rows => rows.map(r => r.boxes.map(b => b.ord));

check('every division is numbered once, in order, across the whole sheet', () => {
  const flat = ordsOf(scoreRows(divisions(6), [], [])).flat();
  assert.deepEqual(flat, flat.map((_, i) => i));
});

check('a break moves its division, and everything after it, to a new row', () => {
  const plain = scoreRows(divisions(6), [], []);
  const broken = scoreRows(divisions(6), [], [2]);
  // Division 2 sat on the first row unbroken; now it starts the second, and
  // everything after it followed.
  assert.ok(plain[0].boxes.length > 2, 'the unbroken row holds division 2');
  assert.equal(broken[0].boxes.length, 2);
  assert.equal(broken[1].boxes[0].ord, 2);
  assert.equal(broken[1].brk, true);
  assert.equal(broken[1].brkOrd, 2);
});

// A break used to end its row early, leaving the rest of the staff blank, to
// protect the column grid — the third division of one row under the third of
// the row above. Ending the LINE early is what a break asks for; leaving half a
// staff empty is not, and that space is exactly what the music on the line
// should be using. So a broken row justifies like any other short row: the
// grid gives way, the 18cm does not.
check('a row cut short by a break is stretched out to the staff edge', () => {
  const broken = scoreRows(divisions(6), [], [2]);
  assert.equal(broken[0].boxes.length, 2);
  assert.equal(Math.round(broken[0].width), Math.round(usableWidth()));
  const half = usableWidth() / 2;
  for (const b of broken[0].boxes) assert.equal(Math.round(b.width), Math.round(half));
});

// ONE common factor, not "give the leftover to the last division" — a row of
// unequal divisions has to come out of the stretch with the same shape it went
// in with, or a dense division would quietly take all the new room.
check('justifying a broken row keeps its divisions in proportion', () => {
  // A division of 16 dantas asks for more than a quarter; the Maguru beside it
  // asks for far less. Their RATIO is what must survive.
  const score = [...Array.from({ length: 16 }, () => note('danta')), note('Maguru'), note('Maguru')];
  const plain = scoreRows(score, [], []);
  const broken = scoreRows(score, [], [2]);
  const ratio = r => r.boxes[0].width / r.boxes[1].width;
  assert.equal(broken[0].boxes.length, 2);
  assert.equal(Math.round(broken[0].width), Math.round(usableWidth()));
  assert.ok(Math.abs(ratio(broken[0]) - ratio(plain[0])) < 0.001,
    `proportions changed: ${ratio(broken[0])} vs ${ratio(plain[0])}`);
});

// The row that ENDS in a break is the one that draws the end-of-line bracket,
// and the flags live on the row the break STARTS — so the row above has to be
// told, or nothing on a justified row says the line was cut.
check('the row before a break knows it ends in one', () => {
  const broken = scoreRows(divisions(6), [], [2]);
  assert.equal(broken[0].brkAfter, 2);
  assert.equal(broken[1].brkAfter, null);
});

check('a break at the very first division is ignored', () => {
  assert.deepEqual(ordsOf(scoreRows(divisions(4), [], [0])),
    ordsOf(scoreRows(divisions(4), [], [])));
});

check('breaks move the music, they do not change it', () => {
  const score = divisions(6);
  const times = rows => rows.flatMap(r => r.boxes.flatMap(b => b.entries.map(e => e.at)));
  assert.deepEqual(times(scoreRows(score, [], [2])), times(scoreRows(score, [], [])));
});

check('a repeat mark follows its note onto the broken row', () => {
  const bars = [{ at: 3, kind: 'close', count: 2 }];
  const rows = scoreRows(divisions(6), bars, [2]);
  const marked = rows.filter(r => r.bars.length);
  assert.equal(marked.length, 1);
  assert.ok(marked[0].boxes.some(b => b.ord === 3));
});

console.log('\nthe printed page');

// The sheet's side padding, the row's width and the 18cm staff are one system:
// .sheet is 21cm wide with 1.1952cm of padding, the row SVG is exactly that
// content width, and the staff sits BX0 of bleed inside the row. If any of the
// three moves, the staff stops landing 1.5cm from the paper edge — on screen,
// in print AND in the PDF, which now measures its page from these same numbers.
check('the row is exactly the sheet content width', () => {
  assert.ok(Math.abs(toMM(VW) - SHEET_W_MM) < 0.01);
  assert.ok(Math.abs(SHEET_W_MM - (PAGE_W_MM - 2 * SHEET_PAD_X)) < 1e-9);
});

check('which puts the staff 15mm from each paper edge', () => {
  assert.ok(Math.abs(SHEET_PAD_X + toMM(BX0) - 15) < 0.01);
});

// Every colour the PDF hands jsPDF has to come out as three real channels.
// setDrawColor answers a NaN with "Invalid argument passed to jsPDF.f2" thrown
// several calls away from the constant that caused it, and the stylesheet
// writes shorthand (#111) as freely as it writes six digits.
check('every sheet colour converts to three real channels', () => {
  for (const c of [SHEET_INK, TONE_BG, TONE_LINE, BRAND_COLOR]) {
    const ch = rgb(c);
    assert.equal(ch.length, 3, `${c} gives three channels`);
    for (const v of ch) {
      assert.ok(Number.isFinite(v) && v >= 0 && v <= 255, `${c} channel ${v} is a byte`);
    }
  }
  assert.deepEqual(rgb('#111'), [17, 17, 17], 'shorthand is expanded, not sliced');
  assert.deepEqual(rgb('#fdf5c4'), [253, 245, 196]);
});

check('and the page pill, not the padding, sets the bottom of the type area', () => {
  assert.ok(PILL_BOTTOM + PILL_H_MM > SHEET_PAD_BOT);
  assert.ok(SHEET_PAD_TOP + PILL_BOTTOM + PILL_H_MM < PAGE_H_MM);
});

console.log(`\n${passed} checks passed\n`);
