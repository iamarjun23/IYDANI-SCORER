// npm run test:notation
import assert from 'node:assert/strict';
import {
  scoreRows, boxUnits, usableWidth, noteY, ledgerLines, stemPointsDown, stemTip,
  noteGlyph, rowExtent, stemMetrics, restMark, repeatMark, repeatGlyphSVG, rowSVG,
} from '../src/renderer/notation.js';
import {
  SOUND, TIME_UNITS_PER_BEAT, STEP, MAGY, TOPY, GTOP, BOTY,
  STEM_ANCHOR_ABOVE, STEM_ANCHOR_BELOW, GOLI_R, NOTE_SCALE, STAFF,
  STEM_LEN, NOTE_INK_W, MA_INDEX, M2_TRI_H,
  REST_MAP, REST_GEOM, REST_MID, REST_SPIKE_H, REST_BAR_W, REST_RING_R,
  ROW_TOP, ROW_BOT, BOX_PAD,
  REPEAT_MID, REPEAT_WING_X, REPEAT_V_INSET, REPEAT_DOT_R, REPEAT_W, LPAD,
  JOIN_GAP, JOIN_BOW_MIN, JOIN_BOW_MAX,
} from '../src/renderer/config.js';
import { state } from '../src/renderer/state.js';

const note = (svaraIndex, sym) => ({
  type: 'note', svaraIndex, oct: 0, head: '', sym,
  dur: SOUND[sym].dur, deco: SOUND[sym].deco,
});
const units = n => Math.round(n.dur * TIME_UNITS_PER_BEAT);
const flat = rows => rows.flatMap(r => r.boxes.flatMap(b => b.entries));
// Trailing empty divisions are padding, not music — ignore them when checking
// how the notes were packed.
const written = rows => rows.flatMap(r => r.boxes).filter(b => b.entries.length);

// A note that crosses a box boundary is split and tied. No artificial rest is
// inserted at the seam, so its musical duration remains continuous.
{
  const notes = [note(0, 'bindu'), note(1, 'Maguru')];
  const rows = scoreRows(notes, []);
  const boxes = written(rows);
  assert.equal(boxes.length, 2, 'the Maguru continues into a second box');
  assert.equal(boxes[0].entries.length, 2, 'bindu + first Maguru segment');
  assert.ok(boxes[0].entries.every(e => e.note.type === 'note'), 'seam contains no invented rests');
  assert.equal(boxes[0].entries.reduce((u, e) => u + units(e.note), 0), boxUnits());

  const mag = flat(rows).filter(e => e.index === 1);
  assert.equal(mag.length, 2, 'Maguru is represented on both sides of the seam');
  assert.equal(mag.reduce((sum, e) => sum + units(e.note), 0), 32, 'segments preserve its full weight');
  assert.ok(!mag[0].tie && mag[1].tie, 'continuation is tied to the first segment');
}

// A box packed to capacity still takes the next note without a gap.
{
  const notes = [note(0, 'bindu'), note(0, 'bindu'), note(0, 'bindu'), note(0, 'bindu'), note(1, 'Maguru')];
  const boxes = written(scoreRows(notes, []));
  assert.equal(boxes.length, 2, 'exactly two boxes');
  assert.ok(boxes[0].entries.every(e => e.note.type !== 'rest'), 'full box needs no padding');
}

// Two separate notes across a box edge produce no tie — the hold-then-jump case.
{
  const notes = Array.from({ length: 8 }, (_, i) => note(i % 7, 'bindu'));
  const entries = flat(scoreRows(notes, []));
  assert.ok(entries.every(e => !e.tie), 'adjacent distinct notes never tie');
  assert.equal(entries[3].box !== entries[4].box, true, 'and they do cross a box edge');
}

// The row is a GRID of equal divisions: a division packed with four heads is
// exactly as wide as one holding a lone Maguru. What survives the scaling is
// the room the symbols take INSIDE their own division — four bindus take a
// quarter of theirs each, the Maguru takes all of its.
{
  const notes = [note(0, 'bindu'), note(0, 'bindu'), note(0, 'bindu'), note(0, 'bindu'), note(1, 'Maguru')];
  const row = scoreRows(notes, [])[0];
  const [packed, lone] = row.boxes;
  const total = row.boxes.reduce((w, b) => w + b.width, 0);
  assert.ok(Math.abs(total - usableWidth()) < 0.001, 'row ends flush');
  assert.ok(Math.abs(packed.width - lone.width) < 0.001, 'divisions are equal');
  assert.equal(packed.x, 0, 'first box starts at the left edge');
  assert.ok(Math.abs(lone.x - packed.width) < 0.001, 'boxes abut with no gap');
  // What the cells split is the division LESS its padding: the notation is
  // written inside the division, not against its lines. The grid above is
  // untouched by that — the divisions are still equal and still abut.
  const inner = b => b.width - 2 * BOX_PAD;
  for (const e of packed.entries) {
    assert.ok(Math.abs(e.w - inner(packed) / 4) < 0.001, 'four heads split their division');
  }
  assert.ok(Math.abs(lone.entries[0].w - inner(lone)) < 0.001, 'the Maguru fills its own');
}

// A fresh score is not a blank staff, and the empty divisions fill up as notes
// are typed rather than being added on top of them.
{
  const empty = scoreRows([], []);
  assert.equal(empty.length, 1, 'one row');
  assert.equal(empty[0].boxes.length, 4, 'four divisions to type into');
  assert.ok(empty[0].boxes.every(b => b.entries.length === 0), 'all empty');
  assert.ok(Math.abs(empty[0].boxes.reduce((w, b) => w + b.width, 0) - usableWidth()) < 0.001);

  const one = scoreRows([note(0, 'bindu')], [])[0];
  assert.equal(one.boxes.length, 4, 'still four divisions');
  assert.equal(one.boxes[0].entries.length, 4, 'note + three beat-countable rests');
  assert.ok(one.boxes.slice(1).every(b => b.entries.length === 0), 'rest wait empty');
}

// Metro fill: no derived rests, and now that every division is the same width
// the reservation shows up INSIDE the box — the two written notes sit in the
// first half of it, where they would sit if the rests were there, and the rest
// of the division is left blank rather than the notes spreading over it.
{
  const notes = [note(0, 'bindu'), note(1, 'bindu')];
  const auto = written(scoreRows(notes, []))[0];
  state.fill = 'metro';
  const metro = written(scoreRows(notes, []))[0];
  state.fill = 'auto';

  assert.equal(auto.entries.filter(e => e.note.type === 'rest').length, 2, 'auto pads two Bindu rests');
  assert.equal(metro.entries.length, 2, 'metro derives nothing');
  assert.ok(metro.entries.every(e => e.note.type === 'note'));
  assert.equal(metro.width, auto.width, 'the division is the same width either way');
  metro.entries.forEach((e, i) => {
    assert.ok(Math.abs(e.w - auto.entries[i].w) < 0.001, 'and its notes the same size');
    assert.ok(Math.abs(e.x - auto.entries[i].x) < 0.001, 'in the same place');
  });
  const inked = metro.entries.reduce((w, e) => w + e.w, 0);
  assert.ok(Math.abs(inked - (metro.width - 2 * BOX_PAD) / 2) < 0.001,
    'half the division is left for the rests');
}

// ---------- the pitch ladder ----------
//
// Measured off Files/OCTAVES NOTES PLACMENT.svg. The rule under test is that
// EVERY sthayi carries the Ga->Ma double step, not madhya alone.

// Madhya is the printed staff, so it pins the ladder to the four lines.
{
  const madhya = [0, 1, 2, 3, 4, 5, 6, 7].map(i => noteY(i, 0));
  assert.deepEqual(madhya, [107, 100, 93, 79, 72, 65, 58, 51], 'madhya S R G M P D N Sa');
  assert.equal(madhya[1], BOTY, 'Ri sits on the bottom line');
  assert.equal(madhya[4], GTOP, 'Pa sits on the green divider');
  assert.equal(madhya[6], TOPY, 'Ni sits on the top line');
  assert.ok(!madhya.includes(MAGY), 'nothing is written on the magic line');
}

// One octave is 8 rungs — 4 whole STEPs, exactly one staff height — in every
// sthayi. A per-sthayi branch or a single global skip breaks this.
{
  for (const svi of [0, 1, 2, 3, 4, 5, 6]) {
    assert.equal(noteY(svi, -1) - noteY(svi, 0), 4 * STEP, `mandra ${svi} is one staff below madhya`);
    assert.equal(noteY(svi, 0) - noteY(svi, 1), 4 * STEP, `taara ${svi} is one staff above madhya`);
  }
  assert.equal(noteY(0, -1), 163, 'mandra Sa');
  assert.equal(noteY(6, 1), 2, 'taara Ni');
}

// Ga->Ma is the double step, and the rung it steps over carries no notation in
// any sthayi: MAGY inside the staff, a bare ledger line outside it.
{
  const empty = [];
  for (const oct of [-1, 0, 1]) {
    assert.equal(noteY(2, oct) - noteY(3, oct), STEP, `Ga->Ma is a double step in oct ${oct}`);
    for (const svi of [0, 1, 4, 5, 6]) {
      assert.equal(noteY(svi, oct) - noteY(svi + 1, oct), STEP / 2, `single step at ${svi} in oct ${oct}`);
    }
    empty.push(noteY(3, oct) + STEP / 2);
  }
  assert.deepEqual(empty, [142, 86, 30], 'the empty rung: mandra ledger 3, MAGY, taara ledger 2');
}

// The sthayis overlap on one rung rather than butting up against each other, so
// a run across a boundary steps evenly and taara Sa takes no ledger.
{
  assert.equal(noteY(7, -1), noteY(0, 0), 'mandra Sa is madhya Sa');
  assert.equal(noteY(7, 0), noteY(0, 1), 'madhya Sa is taara Sa');
  assert.equal(ledgerLines(0, 0, 1), '', 'taara Sa is the bare space above the top line');
  assert.equal(ledgerLines(0, 0, -1).match(/<line/g).length, 4, 'mandra Sa takes four ledgers');
}


// Stem direction and the two anchors, measured off the same drawing. The flip
// is at GTOP, NOT the magic line: madhya Ma sits between them and its stem runs
// UP, while Pa on GTOP hangs.
{
  assert.equal(stemPointsDown(3, 0), false, 'madhya Ma points up');
  assert.equal(stemPointsDown(4, 0), true, 'madhya Pa hangs');
  for (const svi of [0, 1, 2, 3, 4, 5, 6]) {
    assert.equal(stemPointsDown(svi, -1), false, `mandra ${svi} reaches up to the staff`);
    assert.equal(stemPointsDown(svi, 1), true, `taara ${svi} hangs down to the staff`);
  }
}

// Outside madhya the stem TIP is fixed and the length varies, so an ornament
// lands in the same band whatever the sthayi. Both bands sit between GTOP and
// MAGY, on opposite sides of it.
{
  for (const svi of [0, 3, 6]) {
    assert.equal(stemTip(svi, -1), STEM_ANCHOR_BELOW, `mandra ${svi} ends at the anchor`);
    assert.equal(stemTip(svi, 1), STEM_ANCHOR_ABOVE, `taara ${svi} ends at the anchor`);
  }
  assert.equal(STEM_ANCHOR_BELOW, GTOP, 'mandra stems rise to GTOP');
  assert.equal(STEM_ANCHOR_ABOVE, MAGY, 'taara stems hang to MAGY');
  // Madhya keeps the fixed 0.54cm instead: it is already on the staff, so its
  // tips MOVE with the goli where the outer sthayis' stay put.
  assert.notEqual(stemTip(0, 0), stemTip(2, 0), 'madhya tips follow their golis');
  assert.equal(stemTip(0, 0) - noteY(0, 0), stemTip(2, 0) - noteY(2, 0), 'by one fixed length');
}


// M2's triangle points UP whichever way the stem runs — that is what
// Files/OCTAVES NOTES PLACMENT.svg draws in all three sthayis. Flipping it with
// the stem would give taara Ma a head no other sthayi writes.
{
  const apexY = dir => {
    const pts = noteGlyph(0, 100, 'bindu', false, dir, false, null, true)
      .match(/<polygon points="([^"]+)"/)[1]
      .trim().split(/\s+/).map(p => Number(p.split(',')[1]));
    return { apex: Math.min(...pts), base: Math.max(...pts) };
  };
  for (const dir of [1, -1]) {
    const { apex, base } = apexY(dir);
    assert.ok(apex < 100 && base > 100, `M2 triangle points up with dir ${dir}`);
  }
  assert.deepEqual(apexY(1), apexY(-1), 'the head is identical whichever way the stem runs');
}

// A hollow head is TRANSPARENT, never white: the staff line, the ledger line
// and the green band all have to read straight through it, which is how the
// drawing writes every unfilled goli. A white disc would punch a hole in
// whatever line it sits on.
{
  for (const triangle of [false, true]) {
    const hollow = noteGlyph(0, 100, 'bindu', false, 1, false, null, triangle);
    const solid = noteGlyph(0, 100, 'bindu', true, 1, false, null, triangle);
    assert.ok(!/#fff/i.test(hollow), `hollow head ${triangle ? 'triangle' : 'goli'} is not painted white`);
    assert.ok(/fill="none"/.test(hollow), 'hollow head is transparent');
    assert.ok(solid.includes(`fill="${STAFF.noteInk}"`), 'filled head still takes the ink');
  }
}

// Because the head cannot mask anything under it, the stem stops at its EDGE.
// A stem drawn to the goli's centre would cut visibly across the hollow.
{
  const stemY = dir => {
    const m = noteGlyph(0, 100, 'bindu', false, dir, false, null, false)
      .match(/<line x1="0.0" y1="([-0-9.]+)"/);
    return Number(m[1]);
  };
  const r = GOLI_R * NOTE_SCALE;
  assert.ok(Math.abs(stemY(1) - (100 - r)) < 0.01, 'a rising stem starts at the top of the goli');
  assert.ok(Math.abs(stemY(-1) - (100 + r)) < 0.01, 'a hanging stem starts at the bottom of the goli');
}

// The svara letter is ink too. Leave it out of the row extent and the row box
// crops it — mandra Sa hangs lowest of all and loses its S off the bottom edge.
{
  const notes = [{
    type: 'note', svaraIndex: 0, oct: -1, head: 'o', sym: 'bindu',
    dur: SOUND.bindu.dur, deco: SOUND.bindu.deco,
  }];
  const row = scoreRows(notes, [])[0];
  state.showNames = false;
  const bare = rowExtent(row).yMax;
  state.showNames = true;
  const named = rowExtent(row).yMax;
  state.showNames = false;
  assert.ok(named > bare, 'the row grows to hold the svara letter');
  assert.ok(named > noteY(0, -1) + GOLI_R * NOTE_SCALE, 'and the letter clears the goli');
}

// The letter is the PIANO KEY's — one per semitone, S r R g G m M P d D n N —
// so the pair on one rung is told apart by its letter as well as its head.
{
  const named = heads => {
    const notes = heads.map(([svaraIndex, head]) => ({ ...note(svaraIndex, 'bindu'), head }));
    state.showNames = true;
    const svg = rowSVG(scoreRows(notes, [])[0]);
    state.showNames = false;
    return [...svg.matchAll(/<text[^>]*>([A-Za-z])<\/text>/g)].map(m => m[1]).join('');
  };
  assert.equal(named([[1, 'f'], [1, 'o'], [3, 'o'], [3, 'f']]), 'rRmM',
    'filled Ri is r, hollow Ri is R; shuddha Ma is m, prati Ma is M');
  assert.equal(named([[0, 'o'], [2, 'f'], [5, 'f'], [6, 'f']]), 'Sgdn');
}

// stemMetrics() is what the note inspector quotes, so it has to describe the
// stem noteGlyph() actually draws — foot at the head's edge, tip at the anchor.
// Madhya is the only sthayi where the length is the fixed STEM_LEN.
{
  for (let svi = 0; svi < 7; svi++) {
    const m = stemMetrics(svi, 0);
    assert.ok(Math.abs(m.length - STEM_LEN) < 0.01, `madhya ${svi} keeps the fixed 0.54cm`);
    assert.equal(m.width, NOTE_INK_W, 'the reported width is the drawn ink width');

    // Outside madhya the tip is pinned and the length varies with the goli.
    for (const oct of [-1, 1]) {
      const o = stemMetrics(svi, oct);
      assert.equal(o.tip, oct < 0 ? STEM_ANCHOR_BELOW : STEM_ANCHOR_ABOVE, 'tip is the anchor');
      assert.ok(Math.abs(o.foot - noteY(svi, oct)) > 0, 'the foot clears the goli centre');
      assert.ok(Math.abs(o.length - Math.abs(o.tip - o.foot)) < 1e-9, 'length is foot to tip');
    }
  }
  // The stem the inspector measures is the stem in the markup.
  const m = stemMetrics(0, -1);
  const drawn = noteGlyph(0, noteY(0, -1), 'bindu', false, m.dir, false, m.tip, false)
    .match(/<line x1="0.0" y1="([-0-9.]+)" x2="0.0" y2="([-0-9.]+)"/);
  assert.ok(Math.abs(Number(drawn[1]) - m.foot) < 0.01, 'reported foot is the drawn foot');
  assert.ok(Math.abs(Number(drawn[2]) - m.tip) < 0.01, 'reported tip is the drawn tip');

  // M2 hangs off the triangle, not the goli, so its stem is a shade shorter.
  const tri = stemMetrics(MA_INDEX, 0, true);
  assert.ok(tri.length < stemMetrics(MA_INDEX, 0).length, 'M2 measures from the taller triangle');
  assert.ok(Math.abs(tri.length - (STEM_LEN + GOLI_R * NOTE_SCALE - M2_TRI_H * NOTE_SCALE / 2)) < 0.01,
    'by exactly the difference between the two head heights');
}

// The rests are drawn, not stamped: every one of them centres on GTOP, the
// wedges carry the bar count their weight says, and nothing reaches out of the
// row box — which is why rowExtent() only has to measure notes.
{
  const REST_KEY = Object.fromEntries(
    Object.entries(REST_MAP).map(([key, sound]) => [sound, key]),
  );
  const nums = re => [...restMark(0, REST_KEY[re]).matchAll(/y1="([-0-9.]+)"/g)]
    .map(m => Number(m[1]));

  for (const sound of Object.keys(REST_MAP).map(k => REST_MAP[k])) {
    const svg = restMark(0, REST_KEY[sound]);
    assert.ok(svg.startsWith('<g>'), `${sound} rest is drawn markup`);
    assert.ok(!svg.includes('<image'), `${sound} rest is not an image stamp`);
    for (const y of [...svg.matchAll(/(?:cy|y1|y2)="([-0-9.]+)"/g)].map(m => Number(m[1]))) {
      assert.ok(y > ROW_TOP && y < ROW_BOT, `${sound} rest stays inside the row box`);
      assert.ok(Math.abs(y - REST_MID) <= REST_SPIKE_H / 2 + 0.01,
        `${sound} rest stays in the band around GTOP`);
    }
  }

  // The long rests are round marks centred exactly on the band.
  for (const sound of ['Maguru', 'guru']) {
    const cys = [...restMark(0, REST_KEY[sound]).matchAll(/cy="([-0-9.]+)"/g)]
      .map(m => Number(m[1]));
    assert.ok(cys.length && cys.every(cy => cy === REST_MID), `${sound} rest centres on GTOP`);
  }
  assert.ok(restMark(0, REST_KEY.Maguru).includes(`r="${REST_RING_R}"`),
    'the Maguru rest is the measured ring');

  // A wedge is two lines; each bar is a third. bindu's points down, the rest up.
  for (const [sound, g] of Object.entries(REST_GEOM)) {
    const svg = restMark(0, REST_KEY[sound]);
    const lines = [...svg.matchAll(/<line /g)].length;
    assert.equal(lines, 2 + g.bars.length, `${sound} rest carries ${g.bars.length} bars`);
    const [apex] = nums(sound);
    assert.ok(g.up ? apex < REST_MID : apex > REST_MID,
      `${sound}'s wedge points ${g.up ? 'up' : 'down'}`);
    // Every bar spans the note's own BAR_W, so a rest bar and a note bar are
    // the same mark. The wedge's two legs are the only other lines, and they
    // are much narrower, so counting full-width ones counts the bars.
    const wide = [...svg.matchAll(new RegExp(`x1="${(-REST_BAR_W / 2).toFixed(2)}"`, 'g'))].length;
    assert.equal(wide, g.bars.length, `${sound}'s bars are BAR_W wide`);
  }
}

// ---- repeat marks ------------------------------------------------------
//
// The mark used to be an <image> pointing at symbols/repeat_*.svg. That cost
// it every export that writes the row markup out on its own — a relative href
// resolves against nothing — so what is pinned here is that a mark is DRAWN:
// paths and circles, no href, no <image>, at any count and either kind.
{
  const kinds = ['open', 'close'];
  for (const kind of kinds) {
    for (const count of [2, 3, 4]) {
      const svg = repeatMark(100, kind, count);
      assert.ok(!svg.includes('<image') && !svg.includes('href='),
        `a ${kind} ×${count} mark fetches nothing`);

      // The count IS the dot count — that is the only thing telling a x2 from
      // a x4 on the page.
      const dots = [...svg.matchAll(/<circle /g)].length;
      assert.equal(dots, count, `a ×${count} mark carries ${count} dots`);

      // One stroke, tip to tip: the flares weld to the vertical instead of
      // butting against it, which is what left a notch in the artwork.
      assert.equal([...svg.matchAll(/<path /g)].length, 1, 'the bracket is one path');
      assert.ok(svg.includes(`stroke-width="${NOTE_INK_W.toFixed(3)}"`),
        'drawn at note weight, not the artwork hairline');

      const [xTip, yTop, xVert, yVert, , yVertBot, , yBot] =
        svg.match(/d="M([-\d.]+) ([-\d.]+) L([-\d.]+) ([-\d.]+) L([-\d.]+) ([-\d.]+) L([-\d.]+) ([-\d.]+)"/)
          .slice(1).map(Number);

      // The flare tips land ON the staff's outer lines, and the vertical is
      // held back from both by the same amount, so the mark is symmetric.
      assert.equal(yTop, TOPY, 'the upper flare reaches the top line');
      assert.equal(yBot, BOTY, 'the lower flare reaches the bottom line');
      assert.ok(Math.abs((yVert - TOPY) - REPEAT_V_INSET) < 0.01);
      assert.ok(Math.abs((BOTY - yVertBot) - REPEAT_V_INSET) < 0.01);

      // An opening mark brackets to the RIGHT, into the music it encloses; a
      // closing one to the left. Get this backwards and the pair reads as the
      // stretch OUTSIDE the loop.
      const dir = kind === 'close' ? -1 : 1;
      assert.ok((xTip - xVert) * dir > 0, `a ${kind} mark brackets the right way`);
      assert.ok(Math.abs(Math.abs(xTip - xVert) - REPEAT_WING_X) < 0.01);

      // The whole mark stays inside the room the grab target and the badge are
      // placed by, so the handle cannot be smaller than the ink under it.
      const xs = [...svg.matchAll(/c[xy]="([-\d.]+)"/g)].map(m => Number(m[1]));
      for (const v of [xTip, xVert, ...xs.filter((_, i) => i % 2 === 0)]) {
        assert.ok(Math.abs(v - 100) <= REPEAT_W + REPEAT_DOT_R, 'ink fits REPEAT_W');
      }

      // Dots stack about the mark's own midline whatever the count, so a x3
      // sits at the same height as a x2.
      const cys = [...svg.matchAll(/cy="([-\d.]+)"/g)].map(m => Number(m[1]));
      const mid = cys.reduce((a, b) => a + b, 0) / cys.length;
      assert.ok(Math.abs(mid - REPEAT_MID) < 0.01, 'the dot stack is centred');
    }
  }

  // The playback highlight recolours the mark it draws rather than filling a
  // finished glyph from CSS — a hollow goli is fill="none", so a blanket fill
  // rule would plug it.
  assert.ok(repeatMark(0, 'open', 2, '#f00').includes('stroke="#f00"'));
  assert.ok(repeatMark(0, 'open', 2, '#f00').includes('fill="#f00"'));

  // The palette and the Notation Guide show the SAME drawing, so a glyph
  // cannot advertise a brace the staff does not write.
  const tile = repeatGlyphSVG('pair', 3, 44, 38, 'lgd-rep', STAFF.noteInk);
  assert.equal([...tile.matchAll(/<path /g)].length, 2, 'a pair is both braces');
  assert.equal([...tile.matchAll(/<circle /g)].length, 6, 'three dots on each');
  assert.ok(!tile.includes('<image'), 'the tile fetches nothing either');
  assert.ok(repeatGlyphSVG('open', 2, 26, 34).includes('currentColor'),
    'a palette glyph takes the chrome ink');
}

// The division a click selects has to be the division the outline is drawn
// around. Box coordinates are measured from LPAD, like the divider lines that
// bound them, so the hit rect is only right when it carries the same offset —
// without it the selection sat a margin's width to the left of the division it
// named, and pointed at the wrong music while looking deliberate.
{
  const rows = scoreRows(Array.from({ length: 16 }, () => note(0, 'bindu')), []);
  const row = rows[0];
  const svg = rowSVG(row, null, null, true);
  const hits = [...svg.matchAll(/<rect class="section-hit" x="([\d.]+)"[^>]*width="([\d.]+)"[^>]*data-box-at="(\d+)"/g)];
  assert.equal(hits.length, row.boxes.length, 'one hit area per division');
  row.boxes.forEach((b, i) => {
    assert.equal(Number(hits[i][1]), Number((LPAD + b.x).toFixed(2)),
      'the hit area starts where the division does');
    assert.equal(Number(hits[i][2]), Number(b.width.toFixed(2)),
      '...and is as wide as it');
    assert.equal(Number(hits[i][3]), b.at, '...and names its position on the clock');
  });
  // The dividers are drawn from the same edges, so the outline lands on them.
  row.boxes.slice(1).forEach(b => {
    assert.ok(svg.includes(`x1="${LPAD + b.x}" y1="${TOPY}"`),
      'a hit area edge is a division line');
  });
}

// A JOIN marks a note carried OUT of its division and into the next, and only
// that. A note cut inside one division is written as its glyphs and left alone:
// they sit together and are read together, so an arc there is clutter over
// something already unambiguous. This was briefly the other way round — arcing
// every split, on the argument that playback sounds them as one note — and the
// notation's author reverted it. Both halves of the rule are pinned here,
// because each one on its own looks like a bug from the other side.
{
  const arcs = svgOf => svgOf.split(' Q ').length - 1;

  const inside = scoreRows([{
    type: 'note', svaraIndex: 0, oct: 0, head: '', sym: 'guru', dot: false,
    dur: 2.5, deco: SOUND.guru.deco,
  }], []);
  const parts = flat(inside).filter(e => e.note.type === 'note');
  assert.equal(parts.length, 2, 'two and a half beats is two glyphs');
  assert.equal(parts[0].box, parts[1].box, '...and both are in the SAME division');
  assert.ok(parts[1].tie, '...the second being a continuation');
  assert.equal(arcs(rowSVG(inside[0], null, null, true)), 0,
    'but a split INSIDE one division draws no join');

  const across = scoreRows([note(0, 'bindu'), note(1, 'Maguru')], []);
  const over = flat(across).filter(e => e.note.type === 'note');
  assert.ok(over.some((e, i) => i > 0 && e.tie && e.box !== over[i - 1].box),
    'a Maguru after a bindu is carried over the division line');
  assert.equal(arcs(rowSVG(across[0], null, null, true)), 1,
    '...and THAT is what a join is drawn for');

  // Two separate notes never join, however adjacent.
  const apart = scoreRows([note(0, 'bindu'), note(1, 'bindu')], []);
  assert.equal(arcs(rowSVG(apart[0], null, null, true)), 0,
    'and two notes that merely follow each other are not joined');
}

// A join has to CLEAR the head it hangs off, and be curved enough to read as an
// arc. It did neither: its ends sat 6 units from the head's centre against a
// goli radius of 6.03, so both of them started inside the notehead outline, and
// the bow was 5 units at the control point — which for a quadratic is 2.5 units
// of visible depth, half a millimetre. Reported from the field as the join
// needing "some vertical space".
{
  const arcsOf = svg => [...svg.matchAll(
    /<path d="M([\d.]+) ([\d.-]+) Q ([\d.]+) ([\d.-]+) ([\d.]+) ([\d.-]+)"/g)]
    .map(m => ({
      x0: Number(m[1]), y0: Number(m[2]), xc: Number(m[3]),
      yc: Number(m[4]), x1: Number(m[5]), y1: Number(m[6]),
    }));
  const goliR = GOLI_R * NOTE_SCALE;
  // Five beats in a four-beat division: four in this one, one in the next, so
  // the note is carried over the line and the join is drawn.
  const carried = (svaraIndex, oct) => ({
    type: 'note', svaraIndex, oct, head: 'auto', sym: 'bindu', dot: false,
    dur: 5, deco: 'none',
  });

  // Taara above the staff (stems hang, so the arc goes over the top), mandra
  // below it (stems rise, the arc goes under), and one inside the staff, where
  // it is pushed out past the division lines instead.
  for (const [label, note] of [
    ['taara, carried over the division line', carried(0, 1)],
    ['mandra, carried over the division line', carried(0, -1)],
    ['madhya, inside the staff', carried(2, 0)],
  ]) {
    const rows = scoreRows([note], []);
    const svg = rowSVG(rows[0], null, null, true);
    const arcs = arcsOf(svg);
    assert.equal(arcs.length, 1, label + ': one join is drawn');

    const a = arcs[0];
    const y = noteY(note.svaraIndex, note.oct);
    const above = y < MAGY;
    assert.equal(a.y0, a.y1, label + ': the join is level, both halves being one pitch');
    assert.ok(above ? a.y0 < y : a.y0 > y,
      label + ': it is on the side of the head away from the stem');
    assert.ok(Math.abs(a.y0 - y) >= goliR + JOIN_GAP - 0.01,
      label + ': and clear of the notehead by the gap, not inside it ('
      + (Math.abs(a.y0 - y) - goliR).toFixed(2) + ' units of air past the goli)');

    // A quadratic reaches half way to its control point, so that is the depth
    // somebody actually sees.
    const depth = Math.abs(a.yc - a.y0) / 2;
    assert.ok(depth >= JOIN_BOW_MIN / 2 - 0.01,
      label + ': it bows visibly (' + depth.toFixed(2) + ' units, was 2.5)');
    assert.ok(depth <= JOIN_BOW_MAX / 2 + 0.01,
      label + ': and not into a balloon (' + depth.toFixed(2) + ' units)');
    assert.ok(above ? a.yc < a.y0 : a.yc > a.y0,
      label + ': bowing away from the notes, not through them');
  }
}

console.log('ok');
