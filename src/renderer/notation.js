// SVG rendering of the score.
//
// A ROW IS A GRID: boxesPerRow() divisions, each an equal share of the staff,
// whatever is written in them. Boxes wrap on the COUNT — so many to a row and
// then down — so the division lines fall at the same places on every row of the
// page and the third division of one row sits under the third division of the
// row above.
//
// The count follows the METRE (timesig.js), because a division holds one cycle
// of it: four to a row under CHATUSRA is sixteen beats of staff, and four under
// ADI would be thirty-two in the same 18 cm. It is measured in beats instead —
// a beat is never given less than MIN_BEAT_W — so a longer cycle takes fewer
// divisions rather than drawing every glyph on the page at half width.
//
// The grid gives way to LEGIBILITY, and only to that. A division never gives
// its symbols less room than they ask for: one holding more glyphs than its
// share of the staff can carry takes the room it needs, and its row holds one
// division fewer. Squeezed instead, a dense run draws its bars through each
// other — 15.75 units of bar in a 16-unit cell — and reads as a fence rather
// than as notes. A quarter carries about fourteen barred symbols, so ordinary
// music never reaches this and nearly every row is the plain grid.
//
// Inside a division, layout is content-driven rather than duration-driven:
// every symbol gets the same horizontal room (GLYPH_W, more for the two
// ink-heavy ones), and that room is then scaled so the division's contents
// fill its share exactly. A division holding four bindus spaces them widely; a
// division holding sixteen dantas packs them in. The scale is per DIVISION and
// not per row, which is what keeps the sections equal — a Maguru division is
// exactly as wide as the danta division beside it.
//
// A box holds one DIVISION of the selected metre (timesig.js) — four beats
// under CHATUSRA, seven under a 3+2+2. A symbol never shrinks to fit the
// space left over: if it does not fit, the box closes there and the symbol
// starts the next box whole. Whatever weight is left when a box closes is
// filled with rest symbols, so a partly-played box reads as real silence
// rather than trailing off into blank staff. Pad rests are derived here and
// never stored in state.notes — see expandScore().
//
// A full row therefore ends exactly on the staff's right edge with
// nothing justified. A row cut short by DENSITY is stretched to the edge, since
// the staff it left empty is nobody's intent; a row cut short by a manual BREAK
// is not, because ending early is exactly what a break means.

import { state } from './state.js';
import {
  SVARAS, SOUND, REST_MAP, STAFF,
  REST_MID, REST_SPIKE_H, REST_SPIKE_W, REST_GEOM, REST_BAR_W,
  REST_RING_R, REST_RING_INK, REST_HALF_RX, REST_HALF_RY, REST_HALF_INK,
  REST_DOT_R, REST_DOT_DX,
  REPEAT_MID, REPEAT_WING_X, REPEAT_V_INSET,
  REPEAT_DOT_R, REPEAT_DOT_DX, REPEAT_DOT_GAP2, REPEAT_DOT_GAP,
  REPEAT_W, REPEAT_PAIR_SPAN,
  DOT_MULT, DOTTABLE, DOT_R, DOT_GAP, DOT_ROOM,
  MA_INDEX, M2_TRI_W, M2_TRI_H, TONE_LETTER, semiOf,
  NOTE_SCALE, NOTE_GEOM, GOLI_R, STEM_LEN, NOTE_INK_W, BAR_W, BAR_H,
  VW, LPAD, RPAD, BX0, USABLE_W, TOPY, GTOP, MAGY, BOTY, STEP,
  SVARA_RUNG, RUNGS_PER_OCTAVE,
  ROW_TOP, ROW_BOT, TIME_UNITS_PER_BEAT, GROUP_LINE_OPACITY,
  STEM_ANCHOR_ABOVE, STEM_ANCHOR_BELOW,
  OCTAVE_RULE_Y, OCTAVE_RULE_W, OCTAVE_RULE_DASH,
  GLYPH_W, GLYPH_W_OF, BOX_PAD, GLYPH_GAP, toCM,
  JOIN_GAP, JOIN_BOW, JOIN_BOW_MIN, JOIN_BOW_MAX, JOIN_INK_W,
  GUTTER_NUM_X, GUTTER_MARK_X, GUTTER_NUM_BOX, GUTTER_TRI_W,
  GUTTER_OUT, GUTTER_MID_OFFSET,
  toMM, PAGE_H_MM, PAGE_FIRST_Y, PAGE_NEXT_Y, PAGE_BOT_LIMIT, PAGE_GAP_MM, ROW_GAP_MM,
} from './config.js';
import {
  boxUnits as metreUnits, beatsPerBox, boxesPerRow, groupEdges, groupsOf,
} from './timesig.js';
import {
  ensureBarIds, ensureBarUnits, repeatPairs, resolveMark,
} from './repeat-model.js';

// ---------- weight helpers ----------

// Capacity of one box, in timing units. It is the METRE that says how big a
// division is, so this reads the selected time signature rather than a
// constant — see timesig.js. Everything downstream (packing, pad rests, the
// box ordinals a break is stored against) follows from this one number.
export function boxUnits() { return metreUnits(); }

// Row width available for boxes.
export function usableWidth() { return USABLE_W; }

function unitsOf(note) {
  const dur = Number(note && note.dur);
  const d = Number.isFinite(dur) && dur > 0 ? dur : 1;
  return Math.max(1, Math.round(d * TIME_UNITS_PER_BEAT));
}

// Sound symbols by weight, largest first — the order the greedy fill walks.
const SOUND_UNITS = Object.entries(SOUND)
  .map(([sym, v]) => ({ sym, units: Math.round(v.dur * TIME_UNITS_PER_BEAT) }))
  .sort((a, b) => b.units - a.units);

// Everything ONE note glyph can be worth, chukkis included, largest first, as
// clock weight (a symbol's span in units — the hierarchy count runs the other
// way, Maguru 1 up to Danta 32, same ratios counted from the top):
//   Maguru• 48  Maguru 32  guru• 24  guru 16  bindu• 12  bindu 8
//   vasu• 6  vasu 4  praya• 3  praya 2  danta 1
// Danta is still 1 unit, so every integer span is exactly representable and the
// greedy walk below never strands a remainder.
const GLYPH_UNITS = Object.entries(SOUND)
  .flatMap(([sym, v]) => {
    const units = Math.round(v.dur * TIME_UNITS_PER_BEAT);
    const plain = { sym, dot: false, units };
    return DOTTABLE.includes(sym)
      ? [plain, { sym, dot: true, units: Math.round(units * DOT_MULT) }]
      : [plain];
  })
  .sort((a, b) => b.units - a.units);

// REST_MAP is rest-key -> sound-name; invert it to go the other way.
const REST_OF = Object.fromEntries(
  Object.entries(REST_MAP).map(([restKey, sound]) => [sound, restKey]),
);

// Express a span of timing units as the fewest sound symbols: largest that
// fits, repeatedly. Every weight is a power of two times the Danta unit, so
// this is always exact. Offset-blind — only for spans that start on a boundary.
function splitUnits(units) {
  const out = [];
  let left = Math.max(0, units);
  for (const s of SOUND_UNITS) {
    while (left >= s.units) { out.push(s.sym); left -= s.units; }
  }
  return out;
}

// Walk a span into rest values, taking the largest that both fits AND divides
// the current offset, so no rest straddles a division stronger than the one it
// starts on. This is the single rule behind every rest sequence: from a
// mid-beat start it GROWS (danta, praya, vasu after a danta note), and from a
// boundary it takes the biggest that fits.
//
// `table` decides the ceiling — the derived fill caps at one beat so the pulse
// stays countable, while an authored rest keeps the full range so a guru or
// Maguru rest the user placed survives as itself.
function alignedSteps(units, at, table) {
  const out = [];
  let left = Math.max(0, units);
  let off = at;
  while (left > 0) {
    // danta is 1 unit and divides everything, so this always finds a step.
    const step = table.find(s => s.units <= left && off % s.units === 0);
    if (!step) break;
    out.push(step.sym);
    left -= step.units;
    off += step.units;
  }
  return out;
}

// The same walk for NOTES, over the chukki-aware table. This is what keeps a
// 3-beat note one dotted guru instead of being re-expressed as guru + bindu:
// the packer derives every drawn glyph from a unit count, so if the dotted
// values are not in the table the chukki cannot survive the trip.
function splitGlyphs(units) {
  const out = [];
  let left = Math.max(0, units);
  for (const g of GLYPH_UNITS) {
    while (left >= g.units) { out.push(g); left -= g.units; }
  }
  return out;
}

// What one glyph of `units` should be drawn as — the largest single value that
// fits, which is how a held note picks its symbol.
export function glyphFor(units) {
  return GLYPH_UNITS.find(g => g.units <= units) || GLYPH_UNITS[GLYPH_UNITS.length - 1];
}

// Rest values up to ONE BEAT, largest first. Nothing longer is listed on
// purpose: whole beats are written one bindu rest each so the pulse stays
// countable, never bundled up into a guru or Maguru rest.
const REST_STEPS = Object.entries(SOUND)
  .map(([sym, v]) => ({ sym, units: Math.round(v.dur * TIME_UNITS_PER_BEAT) }))
  .filter(s => s.units <= TIME_UNITS_PER_BEAT)
  .sort((a, b) => b.units - a.units);

// Fill leftover space with rests.
//
// THE RULE: every rest starts on a boundary at least as strong as its own
// value — a rest never straddles a division stronger than the one it begins on.
// Take the largest value that both fits and divides the current offset.
//
// Starting mid-beat this makes the fill GROW as it moves away from the note.
// After a danta note, the remaining ⅞ of the beat is written
//
//     danta (→¼)   praya (→½)   vasu (→ beat line)
//
// each one landing on the next stronger line. Reaching for the largest first
// instead would take a vasu from the ⅛ position, straddling both the ¼ and the
// ½ division and hiding the subdivision the reader is counting.
//
// Starting ON a beat line the same rule runs the other way — largest first —
// which is what gives one bindu per whole beat. `used` is how far into the box
// the fill starts.
export function padRests(remainingUnits, used = 0) {
  return alignedSteps(remainingUnits, used, REST_STEPS).map(sym => ({
    type: 'rest',
    sym: REST_OF[sym] || 'rest_symbol_1',
    dur: SOUND[sym].dur,
  }));
}

// Horizontal room for one glyph. Rests carry a rest-key, so resolve it back to
// the sound it stands for before looking up the override. A chukki hangs off
// the right of the goli, so a dotted glyph is given DOT_ROOM more cell.
function glyphW(note) {
  const sound = note.type === 'rest' ? (REST_MAP[note.sym] || 'bindu') : note.sym;
  return (GLYPH_W_OF[sound] || GLYPH_W) + (note.dot ? DOT_ROOM : 0);
}

// ---------- layout ----------

// ---------- the clock, and where it lands on the page ----------
//
// A repeat mark is anchored to a position on the clock, so both directions of
// that conversion are needed: the staff turns a mark's unit into a place to
// draw it, and the drag tool turns a place on the staff back into a unit.
// Both walk the same boxes, so a brace dropped at a spot is drawn at that
// spot, whatever the row is later re-flowed into.
//
// Layout is content-driven, not duration-driven — glyphs get equal room
// whatever they are worth — so the position inside a division is found by
// walking its glyphs, not by taking a fraction of its width. Inside one glyph
// the position does interpolate: that is the only way a brace can sit halfway
// through a held note, which "put it where I dropped it" requires.

// The division containing this point on the clock, plus how far into it. A
// point past the last division is clamped to its end — there is no staff past
// the last row to draw on.
function boxAtUnit(rows, unit) {
  const cap = boxUnits();
  let last = null;
  for (const row of rows) {
    for (const b of row.boxes) {
      if (b.at == null) continue;
      last = { row, box: b };
      if (unit < b.at + cap) return { row, box: b, into: Math.max(0, unit - b.at) };
    }
  }
  return last ? { ...last, into: cap } : null;
}

// Where a point on the clock falls on the page: { row, x }, x in staff units
// from the row's left edge. `atEnd` decides which side of a boundary a mark on
// it belongs to — a closing brace on a division line reads as the end of the
// row above rather than the start of the one below.
export function unitPos(rows, unit, atEnd = false) {
  const cap = boxUnits();
  const hit = boxAtUnit(rows, unit);
  if (!hit) return rows.length ? { row: 0, x: 0 } : null;
  const { box } = hit;
  let x;
  if (!box.entries.length) {
    // Nothing written here, so there are no glyphs to measure from: the
    // division's own width is the only ruler.
    x = box.x + box.width * (hit.into / cap);
  } else {
    const u = box.at + hit.into;
    const e = box.entries.find(en => u < en.at + en.units);
    if (!e) {
      const tail = box.entries[box.entries.length - 1];
      const end = tail.x + tail.w;
      // Past the last glyph — the blank tail of a half-played division in
      // metro fill. Spread what is left over the room that fill reserved.
      const restU = box.at + cap - (tail.at + tail.units);
      const restW = box.x + box.width - end;
      x = restU > 0 ? end + restW * ((u - (tail.at + tail.units)) / restU) : end;
    } else if (u <= e.at + 1e-9 && e === box.entries[0]) {
      // A mark on the FIRST glyph of a division belongs to the division line,
      // not to that glyph's cell edge — the cells are inset by BOX_PAD, and a
      // brace floating inside the line is not how a repeat is read. Anywhere
      // else in the division the cell edge is exactly right, so only the
      // opening glyph is special-cased.
      x = box.x;
    } else {
      x = e.x + e.w * ((u - e.at) / e.units);
    }
  }
  let rowIndex = hit.row.index;
  // A mark sitting exactly on a row's first edge belongs to the previous row
  // when it closes something — otherwise a repeat that ends with a line ends
  // up drawn at the start of the next one.
  if (atEnd && x <= 0.01 && rowIndex > 0) {
    rowIndex -= 1;
    x = rows[rowIndex].width;
  }
  return { row: rowIndex, x };
}

// The glyph cell at `x` staff units into a row, or null out on empty staff.
//
// A repeat mark dropped by pointer is resolved with THIS rather than by going
// through unitAtX(): a cell is a fixed width on the page but its length on the
// clock is whatever the symbol is worth, so converting x to a time and then
// asking which glyph owns that time is a lossy round trip. A danta cell is
// 30 px wide and ONE unit long — round its interpolated time to the nearest
// unit and everything past the cell's midpoint lands on the next note, which
// is why a brace placed close in among short symbols skipped the note it was
// aimed at. Asking which cell the pointer is inside has no such rounding in
// it, and is what the eye is doing anyway.
export function cellAtX(rows, rowIndex, x) {
  const row = rows[rowIndex];
  if (!row) return null;
  for (const b of row.boxes) {
    for (const e of b.entries) {
      if (x >= e.x && x < e.x + e.w) return { at: e.at, units: e.units };
    }
  }
  return null;
}

// The inverse: the point on the clock at `x` staff units into a row. This is
// what a drop resolves to, so it must accept any x, not only a division edge.
export function unitAtX(rows, rowIndex, x) {
  const cap = boxUnits();
  const row = rows[rowIndex];
  if (!row || !row.boxes.length) return 0;
  const boxes = row.boxes.filter(b => b.at != null);
  if (!boxes.length) return 0;
  const first = boxes[0];
  if (x <= first.x) return first.at;
  const box = [...boxes].reverse().find(b => x >= b.x) || first;
  if (x >= box.x + box.width) return box.at + cap;
  if (!box.entries.length) {
    return box.at + cap * ((x - box.x) / (box.width || 1));
  }
  const e = [...box.entries].reverse().find(en => x >= en.x);
  if (!e) return box.at;
  if (x >= e.x + e.w) {
    const tail = box.entries[box.entries.length - 1];
    if (e !== tail) return e.at + e.units;
    const end = tail.x + tail.w;
    const restU = box.at + cap - (tail.at + tail.units);
    const restW = box.x + box.width - end;
    return restW > 0 && restU > 0
      ? (tail.at + tail.units) + restU * ((x - end) / restW)
      : tail.at + tail.units;
  }
  return e.at + e.units * ((x - e.x) / (e.w || 1));
}

// Every glyph on the sheet as a span of the clock, in order. A repeat mark
// resolves against these — it belongs to the glyph it is over, not to an edge
// — so the brace is drawn over the same note the loop is played from. See
// resolveMark().
export function entryCells(rows) {
  const cells = [];
  rows.forEach(r => r.boxes.forEach(b => b.entries.forEach(e => {
    cells.push({ at: e.at, units: e.units });
  })));
  return cells.sort((a, b) => a.at - b.at);
}

// Pack notes into boxes, pad each box, then flow boxes into rows.
// Every entry carries its x (px, relative to LPAD) and `index` — its position
// in state.notes, or null when it is a derived pad rest.
export function scoreRows(notes = state.notes, bars = state.bars,
  breaks = state.breaks) {
  // A mark carries an id so the sheet can point at one of them — to select it,
  // tint its span, or drag it. Older files have none; filling them in here
  // means every path that reaches the staff has them, and it is idempotent.
  ensureBarIds(bars);
  // A mark lives on the CLOCK, not on a note — which is what lets it be
  // dropped anywhere, including on staff with nothing written on it. Files
  // written before that carry a note index and are converted once.
  ensureBarUnits(bars, notes, TIME_UNITS_PER_BEAT);
  const cap = boxUnits();
  const maxW = usableWidth();
  // Divisions to a row under this metre — four for a four-beat cycle, fewer
  // for a longer one, so a beat keeps its room on the page (see boxesPerRow).
  const perRow = boxesPerRow();
  // A division's share of the staff: the row is a grid of `perRow` equal
  // sections. It is a floor, not a cap — see the width rule below.
  const gridBox = maxW / perRow;

  // --- 1. pack into boxes, padding each as it closes ---
  const boxes = [];
  let box = { entries: [], used: 0, gap: 0 };
  // Absolute timing position of the current box's start, in units. Every entry
  // records where it sits on that clock (`at`) and how long it lasts (`units`)
  // — that is what lets the playing highlight work in beats rather than in
  // glyphs. It advances a whole box at a time, so 'metro' fill's blank tail
  // does not shift the beats of the boxes after it.
  let boxStart = 0;

  // In 'metro' fill the metronome writes the real rests, so nothing is derived
  // here — the unplayed time is left blank. It still reserves the room those
  // rests would have taken (`gap`), so a half-played box keeps its full size
  // instead of collapsing around the notes.
  const closeBox = () => {
    if (!box.entries.length) return;
    const pad = padRests(cap - box.used, box.used);
    if (state.fill === 'metro') {
      box.gap = pad.reduce((w, r) => w + glyphW(r), 0);
      // Their AIR is reserved with their room — counting only the drawn
      // entries would let a half-played box close up by a gap per rest.
      box.gapN = pad.length;
    }
    else {
      let off = box.used;
      for (const rest of pad) {
        const units = Math.round(rest.dur * TIME_UNITS_PER_BEAT);
        box.entries.push({ note: rest, index: null, at: boxStart + off, units });
        off += units;
      }
    }
    // A box that turns out to hold nothing but silence is written as the
    // fewest rests that say so, GROUP BY GROUP of the metre, instead of a bindu
    // rest a beat: one Maguru rest under a plain four, a guru rest under a
    // two, a Maguru rest then a bindu rest under 4+1, two Maguru rests under
    // ADI's 4+4. The rests always add up to the division — it was one Maguru
    // rest whatever the metre, four beats drawn in a division of two, or of
    // five. A group no single rest measures takes the largest first (three
    // beats is a guru rest and a bindu rest). `covers` keeps the source notes
    // each rest swallowed, so the section panel knows it stands for several.
    const total = box.entries.reduce((u, e) => u + e.units, 0);
    if (box.entries.length > 1 && total === cap
        && box.entries.every(e => e.note.type === 'rest')) {
      const old = box.entries;
      box.entries = [];
      let at = boxStart;
      for (const beats of groupsOf()) {
        for (const sym of alignedSteps(beats * TIME_UNITS_PER_BEAT, 0, SOUND_UNITS)) {
          const units = Math.round(SOUND[sym].dur * TIME_UNITS_PER_BEAT);
          const covers = [...new Set(old
            .filter(e => e.index != null && e.at >= at && e.at < at + units)
            .map(e => e.index))];
          box.entries.push({
            note: { type: 'rest', sym: REST_OF[sym], dur: SOUND[sym].dur },
            index: covers.length ? covers[0] : null,
            covers,
            at,
            units,
          });
          at += units;
        }
      }
    }
    // Where this division sits on the clock, and which source note opens it.
    // `at` is what the interior group dividers measure their offsets from;
    // `startAt` is the note index a repeat mark dropped on this division's
    // left edge attaches to. A division holding nothing but derived pad rests
    // has no source note of its own and is filled in below.
    box.at = boxStart;
    const opener = box.entries.find(e => e.index != null);
    box.startAt = opener ? opener.index : null;
    boxes.push(box);
    box = { entries: [], used: 0, gap: 0 };
    boxStart += cap;
  };

  notes.forEach((note, index) => {
    let left = unitsOf(note);
    // A symbol that overruns the room left is split at the box line: it fills
    // the current box, carries on in the next, and no rests are invented to
    // paper over the seam. Parts after the first are continuations (`tie`) —
    // no fresh attack on playback, and a joining arc back to the head.
    let first = true;
    while (left > 0) {
      if (box.used >= cap) closeBox();
      const take = Math.min(left, cap - box.used);
      let off = box.used;
      // An authored rest that overruns the box splits by the same metric rule
      // as the derived fill, so a rest never straddles a stronger division
      // wherever it came from. Notes keep the chukki-aware greedy walk.
      const parts = note.type === 'rest'
        ? alignedSteps(take, box.used, SOUND_UNITS).map(sym => ({ sym, dot: false }))
        : splitGlyphs(take);
      for (const p of parts) {
        const sd = SOUND[p.sym];
        const dur = sd.dur * (p.dot ? DOT_MULT : 1);
        const piece = note.type === 'rest'
          ? { ...note, sym: REST_OF[p.sym] || note.sym, dur }
          : { ...note, sym: p.sym, dot: p.dot, dur, deco: sd.deco };
        if (!first) piece.tie = true;
        // What the note is worth before it was cut up, so the one attack a
        // joined note gets can ring for its whole length instead of decaying
        // at the box line.
        piece.full = note.dur;
        const units = Math.round(dur * TIME_UNITS_PER_BEAT);
        box.entries.push({ note: piece, index, tie: !first, at: boxStart + off, units });
        off += units;
        first = false;
      }
      box.used += take;
      left -= take;
    }
  });
  closeBox();

  // --- 2. flow boxes into rows ---
  // Every box gets an ordinal as it is placed — content boxes first, then the
  // empty divisions that pad the last row. That number is what a manual break
  // is stored against: it counts divisions from the start of the score, so it
  // survives re-flow, zoom and re-render, none of which a row index does.
  const forced = new Set((breaks || []).map(Number));
  const rows = [];
  let ord = 0;
  let row = { index: 0, boxes: [], width: 0, bars: [], brk: false, brkOrd: null };

  const place = b => {
    b.ord = ord++;
    // Three things end a row: a manual break, the division count, and a
    // division so full that it will not fit in what is left. The last one is
    // what keeps a dense run readable — it is given a row of its own rather
    // than being crushed into a quarter of one.
    const brk = forced.has(b.ord) && row.boxes.length > 0;
    if (brk || row.boxes.length >= perRow
        || (row.boxes.length && row.width + b.width > maxW + 0.001)) {
      rows.push(row);
      row = {
        index: rows.length, boxes: [], width: 0, bars: [],
        brk, brkOrd: brk ? b.ord : null,
      };
    }
    b.x = row.width;
    row.boxes.push(b);
    row.width += b.width;
  };

  for (const b of boxes) {
    // What the box's symbols ask for. Normally less than a division's share,
    // and then it is only the RATIO between them that survives — they are
    // scaled up to fill the share. When it is more, the share gives way: their
    // natural room is the least a symbol can be drawn in and still be read.
    b.content = b.entries.reduce((w, e) => w + glyphW(e.note), 0) + (b.gap || 0);
    // The air beside those symbols, which is absolute rather than a share —
    // see GLYPH_GAP. Counted per cell, plus the phantom rests metro fill is
    // holding room for.
    b.air = 2 * GLYPH_GAP * (b.entries.length + (b.gapN || 0));
    // Both insets are part of what a division must be able to hold: a box too
    // full for its quarter takes its symbols' natural room PLUS the padding
    // and the air, so the cells inside it stay exactly as wide as they asked
    // for instead of being squeezed by the space put either side of them.
    b.width = Math.max(gridBox, b.content + b.air + 2 * BOX_PAD);
    place(b);
  }

  // The staff never ends on the last note: pad the row out to its full
  // `perRow` with empty divisions so there is somewhere to type into.
  // They fill up as notes are entered, and a full row opens a fresh set on the
  // next one. The empty divisions keep counting the clock rather than standing
  // outside it: a repeat mark may be dropped on one, and it has to know where
  // it is.
  // Only as many as the row has room for: after a dense division there may be
  // room for none, and an empty division pushed onto a row of its own would be
  // a page of blank staff nobody asked for.
  while (row.boxes.length < perRow
         && row.width + gridBox <= maxW + 0.001) {
    place({ entries: [], content: 0, width: gridBox, at: boxStart });
    boxStart += cap;
  }
  rows.push(row);

  // A split that straddles a row break has no partner glyph to arc to, so each
  // row is told about it and draws a stub off its own edge instead.
  const firstEntry = r => {
    for (const b of r.boxes) if (b.entries.length) return b.entries[0];
    return null;
  };
  rows.forEach((r, i) => {
    const next = rows[i + 1] && firstEntry(rows[i + 1]);
    r.tieOut = !!(next && next.tie && next.note.type === 'note');
  });

  // --- 3. take up the slack ---
  // A row of four equal quarters already measures the staff exactly, so this
  // does nothing to it — and a row that has room for another division was
  // given one by the padding above. Two things can still leave a row short:
  // a division too full to share one, and a manual BREAK. Both are stretched
  // back out to the staff edge by ONE common factor, so the divisions keep
  // their proportions to each other and only the room between them grows.
  //
  // The break case used to be excluded, to protect the column grid — the third
  // division of one row sitting under the third of the row above. That is not
  // what a break is for: ending a line early is asked for, but the empty half
  // of a staff it left behind was not, and it is exactly the space the music on
  // that line should be using. The grid gives way to that, here and on a dense
  // row alike; a row's four divisions were never the point, the 18 cm was.
  //
  // It runs in BOTH directions. A single division can ask for more than the
  // whole staff — six beats of dantas is 48 glyphs, which wanted 1068 units
  // against the staff's 905 and simply drew past the closing barline, off the
  // 18 cm the sheet is measured in. It gets a row to itself either way, and
  // that row is now brought back to the staff edge by the same factor that
  // stretches a short one, so its symbols pack tighter instead of the page
  // getting wider. The 18 cm is the one thing here that never gives.
  rows.forEach(r => {
    if (!r.boxes.length || r.width <= 0) return;
    if (Math.abs(r.width - maxW) < 0.001) return;
    const k = maxW / r.width;
    r.boxes.forEach(b => { b.x *= k; b.width *= k; });
    r.width = maxW;
  });

  // Which row ENDS in a break. The flags are on the row a break STARTS, so the
  // row above has to be told: it draws the end-of-line bracket, and now that it
  // is stretched to measure the full staff like any other row, that bracket is
  // the ONLY thing on the page saying the line was cut here.
  rows.forEach((r, i) => {
    const next = rows[i + 1];
    r.brkAfter = next && next.brk ? next.brkOrd : null;
  });

  // --- 4. place the glyphs inside each division ---
  // The boxes are now where they go and the width they will be drawn. What is
  // left is fitting each division's symbols into its own width: one scale PER
  // BOX, so the relative room the symbols asked for survives (a Maguru cell
  // twice a bindu's) while the divisions themselves stay equal.
  rows.forEach(r => {
    r.boxes.forEach((b, boxIndex) => {
      // The cells fill the division MINUS its padding, and start one pad in,
      // so the notation sits inside the division rather than against its
      // lines. Each cell is then a SCALED share plus an ABSOLUTE gap: the
      // scale is per box, so the relative room the symbols asked for
      // survives, while the air beside each of them is the same width
      // whatever the box holds.
      const inner = Math.max(0, b.width - 2 * BOX_PAD);
      const air = b.air || 0;
      // The box was sized to hold both, so normally the air is kept whole and
      // only the shares stretch. A row scaled back to the staff can leave less
      // than that; then the air gives way in the same proportion as the
      // symbols rather than being taken out of them.
      const squeeze = inner < air + b.content && air + b.content > 0
        ? inner / (air + b.content) : 1;
      const gap = GLYPH_GAP * squeeze;
      const k = b.content > 0
        ? (inner - 2 * gap * (b.entries.length + (b.gapN || 0))) / b.content : 1;
      let acc = 0;
      b.entries.forEach(e => {
        e.w = glyphW(e.note) * k + 2 * gap;
        e.x = b.x + BOX_PAD + acc;
        acc += e.w;
        e.box = boxIndex;
      });
    });
  });

  // --- 5. attach repeat marks ---
  // A mark is placed by its position on the clock, and that position resolves
  // onto the glyph it is over: an opening brace to that glyph's start, a
  // closing one to its end, so the note under the ink is the note in the loop.
  // Nothing snaps to a DIVISION — a brace still lands wherever along the row
  // it was dropped — and out past the written music there is no glyph to
  // belong to, so the mark stays exactly where it was put.
  const cells = entryCells(rows);
  rows.forEach(r => { r.spans = []; });
  bars.forEach(bar => {
    const unit = resolveMark(Number(bar.unit) || 0, bar.kind, cells);
    const pos = unitPos(rows, unit, bar.kind === 'close');
    if (pos && rows[pos.row]) rows[pos.row].bars.push({ ...bar, x: pos.x, playUnit: unit });
  });

  // --- 6. repeat spans ---
  // The stretch of staff one open/close pair covers, cut into a rect per row.
  // They are drawn transparent and lit by repeats.js on hover or selection, so
  // showing one costs a class change rather than a re-render — render() is
  // 13 ms at 400 notes, which is far too much to spend on a mouseover.
  repeatPairs(bars).forEach(pair => {
    // The tint shows what actually repeats, so it is measured off the same
    // resolved cuts the braces are drawn at.
    const a = unitPos(rows, resolveMark(pair.openUnit, 'open', cells), false);
    const b = unitPos(rows, resolveMark(pair.closeUnit, 'close', cells), true);
    if (!a || !b || b.row < a.row || (b.row === a.row && b.x <= a.x)) return;
    for (let r = a.row; r <= b.row; r += 1) {
      const row = rows[r];
      if (!row) continue;
      const x0 = r === a.row ? a.x : 0;
      const x1 = r === b.row ? b.x : row.width;
      if (x1 > x0) row.spans.push({ id: pair.openId, pairId: pair.openId, x0, x1 });
    }
  });

  return rows;
}

// Materialise the derived pad rests for the two consumers that need real
// timing — playback and save. Repeat marks are remapped onto the expanded
// indices, otherwise every mark would drift by the pad rests inserted before
// it. `sourceIndex[i]` is the note's index in state.notes, or null if derived.
export function expandScore(notes = state.notes, bars = state.bars) {
  const rows = scoreRows(notes, bars);
  const out = [];
  const sourceIndex = [];
  const unitAt = [];

  rows.forEach(r => r.boxes.forEach(b => b.entries.forEach(e => {
    sourceIndex.push(e.index);
    unitAt.push(e.at);
    out.push(e.note);
  })));

  // Marks need no remapping any more: they are anchored to the clock, and the
  // clock is the same before and after the pad rests are materialised — that
  // is what the pad rests are filling. They are copied rather than passed
  // through so a consumer cannot write back into state.bars.
  const remapped = bars.map(b => ({ ...b }));

  return { notes: out, bars: remapped, sourceIndex, unitAt };
}

// ---------- pitch ----------

// Rung counted from madhya Sa. Within a sthayi the rung is SVARA_RUNG[svi],
// which climbs one at a time except over the empty rung between Ga and Ma; an
// octave is therefore RUNGS_PER_OCTAVE (8) rungs, so mandra runs -8..-1,
// madhya 0..8 and taara 8..16.
//
// Sá (svaraIndex 7) of one sthayi is Sa of the next — rung 8 of one octave is
// rung 0 of the one above — so consecutive sthayis overlap on a single position
// and the ladder has no seam at the boundary: madhya Sá and taara Sa are the
// same pitch and land on the same y.
export function ladderPos(svi, oct) {
  const rung = SVARA_RUNG[svi];
  return oct * RUNGS_PER_OCTAVE + (rung == null ? svi : rung);
}

// Where the goli sits. ONE ladder serves all three sthayis: each svara is a
// half-STEP above the one below it, and the ladder keeps going past the staff
// edges rather than stopping at them. Mandra and taara are placed by exactly
// the same rule as madhya; what says how far out you are is the LEDGER COUNT
// (see ledgerLines), not anything about the glyph.
//
// MADHYA reads Sa(107) Ri(100·BOTY) Ga(93) — Ga stays under the magic line —
// then Ma(79) Pa(72·GTOP) Da(65) Ni(58·TOPY).
//
// The empty rung is the ladder's one irregularity, and it is already counted in
// SVARA_RUNG, so there is nothing to correct for here: y falls straight out of
// the rung. Inside the staff that empty rung is the magic line; a sthayi out it
// is a ledger line the notes step over, and mandra and taara therefore read
// exactly like madhya instead of being squeezed by a rung.
//
// Nothing is clamped. A note far outside the staff simply gets a y further out
// and rowExtent() grows the row to hold it.
export function noteY(svi, oct) {
  const half = STEP / 2;
  return BOTY + half - ladderPos(svi, oct) * half;
}

// Which way the stem points, FROM the goli. One rule for every sthayi: the flip
// is at GTOP. At or above that line stems hang, below it they rise — so a note
// far under the staff points its stem up toward the staff and a note far above
// points down, which is the way round a reader expects.
//
// GTOP, not MAGY: madhya Ma sits at 79, between them, and the drawing gives it
// an UP stem (measured — its tip is at 44, out past the top line) while Pa on
// GTOP hangs. Flipping at the magic line instead turns Ma the wrong way round.
export function stemPointsDown(svi, oct) {
  return noteY(svi, oct) <= GTOP;
}

// Where the stem ENDS — and with it the ornament, which rides the tip.
//
// Madhya keeps the fixed 0.54cm stem: it is already on the staff, so there is
// nothing to reach back to. Mandra and taara stems instead run all the way in
// and finish at the anchor beside the magic line, so the stem grows with the
// distance out while the tip — and the ornament — stays put. That is what keeps
// a taara danta's three bars in the same band as a madhya one's.
//
// It shortens as well as lengthens: mandra Ni sits only just under the staff,
// and a full 0.54cm stem from there would shoot past the anchor and carry its
// ornament across the magic line.
export function stemTip(svi, oct) {
  const y = noteY(svi, oct);
  if (oct === 0) {
    const dir = stemPointsDown(svi, oct) ? -1 : 1;
    return y - dir * (GOLI_R * NOTE_SCALE + STEM_LEN);
  }
  return oct < 0 ? STEM_ANCHOR_BELOW : STEM_ANCHOR_ABOVE;
}

// Where the stem meets the head. The head is hollow and cannot mask anything
// under it, so the stem stops at the head's EDGE — the goli's rim, or M2's
// apex when the stem rises and its base when it hangs.
export function stemFoot(y, dir, triangle = false) {
  const half = triangle ? M2_TRI_H * NOTE_SCALE / 2 : GOLI_R * NOTE_SCALE;
  return y - dir * half;
}

// The stem exactly as noteGlyph() draws it — foot, tip, and the length between
// them in staff units. Exported so the inspector reports the stem that is on
// the page rather than re-deriving it from STEM_LEN, which is only the whole
// story in madhya: mandra and taara stems run back to a fixed anchor instead,
// so their length varies with how far out the goli sits.
export function stemMetrics(svi, oct, triangle = false) {
  const y = noteY(svi, oct);
  const dir = stemPointsDown(svi, oct) ? -1 : 1;
  const foot = stemFoot(y, dir, triangle);
  const tip = stemTip(svi, oct);
  return { dir, foot, tip, length: Math.abs(tip - foot), width: NOTE_INK_W };
}

// One note: goli at the pitch, a stem of one fixed length rising out of it,
// and whatever the symbol carries on top — duration bars, Guru's curl, or
// Maguru's ring.
//
// The STEM TIP is the anchor. It sits STEM_LEN (0.54cm) above the goli's
// EDGE, so the drawn line runs from the pitch up past the goli radius and on
// for the full 0.54cm. Every ornament is then placed by how far it hangs
// BELOW that tip, which is what keeps the ring capping the stem and the bars
// stacked under it no matter what the stem length is set to.
//
// The goli is drawn last so it covers the foot of the stem.
// `dir` is +1 when the stem rises and -1 when it hangs. `tipY` is where the
// stem ends — a fixed 0.54cm out for madhya, the anchor beside the magic line
// for mandra and taara (see stemTip). The ornament is placed by how far it
// hangs back from that tip, which is what welds bars, curl and ring to the tip
// however long the stem turns out to be.
//
// The glyph is drawn in the given direction rather than mirrored with a
// transform, so the hook can keep bulging right whichever way the stem points.
//
// `dot` draws the chukki: a filled dot to the right of the goli and level with
// it, meaning "and the next symbol down" — half again as long. It rides the
// goli rather than the stem tip, so it stays put when the stem flips.
// `ink` is the last argument and defaults to the normal note colour, so every
// caller that just wants a black glyph is unchanged. Playback passes the
// sounding colour instead: the glyph is DRAWN in it rather than having a rect
// laid over it or a CSS fill forced onto it, which is the only way to recolour
// a notehead whose fill is deliberately `none`.
export function noteGlyph(x, y, sound, filled, dir = 1, dot = false, tip = null, triangle = false,
                          ink = STAFF.noteInk) {
  const g = NOTE_GEOM[sound] || NOTE_GEOM.bindu;
  const K = NOTE_SCALE;
  const px = u => (u * K).toFixed(2);

  const goliR = GOLI_R * K;
  const tipY = tip != null ? tip : y - dir * (goliR + STEM_LEN);
  // Artwork units back from the tip toward the goli -> staff y.
  const back = u => tipY + dir * u * K;
  const bk = u => back(u).toFixed(2);

  // NOTE_INK_W is already in staff units (0.3mm), so it is NOT scaled by K.
  const inkW = NOTE_INK_W.toFixed(3);

  // The stem starts at the EDGE of the head, not its centre. A hollow goli is
  // transparent — the staff and ledger lines have to run through it, which is
  // the whole point — so it can no longer be relied on to cover a stem foot
  // drawn under it. Files/OCTAVES NOTES PLACMENT.svg stops every stem one head
  // short of centre for the same reason. This also makes STEM_LEN literal: the
  // drawn segment from head edge to tip is exactly the specified 0.54cm.
  const headY = stemFoot(y, dir, triangle);
  let out = `<line x1="${x.toFixed(1)}" y1="${headY.toFixed(2)}" x2="${x.toFixed(1)}" y2="${tipY.toFixed(2)}" stroke="${ink}" stroke-width="${inkW}"/>`;

  for (const b of g.bars) {
    out += `<rect x="${(x - BAR_W * K / 2).toFixed(2)}" y="${(back(b) - BAR_H * K / 2).toFixed(2)}" width="${px(BAR_W)}" height="${px(BAR_H)}" fill="${ink}"/>`;
  }
  if (g.ring) {
    out += `<circle cx="${x.toFixed(1)}" cy="${bk(g.ring.cy)}" r="${px(g.ring.r)}" fill="none" stroke="${ink}" stroke-width="${inkW}"/>`;
  }
  if (g.curl) {
    // A "D": the stem is the flat side, the hook bulges RIGHT. The span is
    // exactly 2r, so this is a true semicircle and the large-arc flag is
    // degenerate (0). The SWEEP flag is what puts the bulge on the right, and
    // it has to invert with `dir` — sweep runs in the positive-angle direction,
    // so reusing one value would mirror the hook onto the wrong side of the
    // stem as soon as the stem points the other way.
    const sweep = dir === 1 ? 0 : 1;
    out += `<path d="M${x.toFixed(1)} ${bk(g.curl.from)} A ${px(g.curl.r)} ${px(g.curl.r)} 0 0 ${sweep} ${x.toFixed(1)} ${bk(g.curl.to)}" fill="none" stroke="${ink}" stroke-width="${inkW}" stroke-linecap="round"/>`;
  }
  // The notehead. M2 draws a triangle INSTEAD of the goli — same centre, same
  // ink — so nothing else about the glyph has to change: the stem still runs to
  // this point — it just stops at the apex or the base instead of the rim.
  if (triangle) {
    // The apex ALWAYS points up, whichever way the stem runs — that is what
    // Files/OCTAVES NOTES PLACMENT.svg draws in all three sthayis, and it is
    // what makes the head recognisable as M2 at a glance. Flipping it with the
    // stem would give taara Ma a head no other sthayi writes. The stem simply
    // leaves the apex when it rises and the base when it hangs, and stops
    // there — the head is hollow, so it cannot cover a stem drawn under it.
    const tw = M2_TRI_W * K, th = M2_TRI_H * K;
    const apex = y - th / 2;
    const base = y + th / 2;
    const pts = `${(x - tw / 2).toFixed(2)},${base.toFixed(2)} `
              + `${(x + tw / 2).toFixed(2)},${base.toFixed(2)} `
              + `${x.toFixed(1)},${apex.toFixed(2)}`;
    out += `<polygon points="${pts}" fill="${filled ? ink : 'none'}" stroke="${ink}" stroke-width="${inkW}" stroke-linejoin="round"/>`;
  } else {
    out += `<circle cx="${x.toFixed(1)}" cy="${y}" r="${px(GOLI_R)}" fill="${filled ? ink : 'none'}" stroke="${ink}" stroke-width="${inkW}"/>`;
  }

  if (dot) {
    const cx = x + goliR + (DOT_GAP + DOT_R) * K;
    out += `<circle cx="${cx.toFixed(2)}" cy="${y}" r="${px(DOT_R)}" fill="${ink}"/>`;
  }
  return out;
}

// The svara's name written beside its goli, for the Legend toggle. It is the
// letter on the PIANO KEY that writes the note — TONE_LETTER, through semiOf()
// — so a chromatic octave reads S r R g G m M P d D n N on the staff, on the
// key caps and in the sheet's tone legend alike. It was one letter per ladder
// position (S R R G G M M ...), as Files/OCTAVES NOTES PLACMENT.svg labels its
// chart, and was changed at the notation author's word: a name that does not
// match the key that was pressed is not one a player can check.
//
// It goes on the side of the goli the stem does NOT leave from, so it can never
// collide with the stem or with the ornament riding its tip. Attributes are
// inline rather than classed because this text has to survive SVG and PDF
// export, where no stylesheet follows it.
const NAME_SIZE = 9;
const NAME_GAP = 5;

// Where svaraName() puts its ink, without drawing it — rowExtent() needs the
// box before the glyph exists. Keep the two in step: this mirrors the `ny`
// below, grown by the font's ascent/descent.
function svaraNameSpan(y, dir) {
  const r = GOLI_R * NOTE_SCALE;
  const ny = dir === 1 ? y + r + NAME_SIZE + NAME_GAP - 3 : y - r - NAME_GAP;
  return { top: ny - NAME_SIZE, bottom: ny + NAME_SIZE * 0.25 };
}

function svaraName(x, y, n, dir) {
  const letter = TONE_LETTER[semiOf(n.svaraIndex, n.head) % 12];
  if (!letter) return '';
  const r = GOLI_R * NOTE_SCALE;
  // dir is +1 when the stem rises, so the name hangs below the goli; -1 when it
  // hangs, so the name sits above.
  const ny = dir === 1 ? y + r + NAME_SIZE + NAME_GAP - 3 : y - r - NAME_GAP;
  return `<text x="${x.toFixed(1)}" y="${ny.toFixed(1)}"`
    + ` font-family="Arial, Helvetica, sans-serif" font-size="${NAME_SIZE}"`
    + ` font-weight="700" text-anchor="middle" fill="${STAFF.noteInk}">${letter}</text>`;
}

// Measured off Files/OCTAVES NOTES PLACMENT.svg: every ledger there spans 332
// drawing units, 17.4 staff units — a little wider than the 12.05u goli it
// carries, so the head sits on a visible line rather than hiding it.
const LEDGER_W = 17.4;

// Ledger lines continue the staff's own line spacing outward — STEP apart,
// exactly like the printed lines — so the ladder's alternation of line and
// space carries on unbroken past the edge:
//
//   above TOPY:  44  30  16  2 ...        below BOTY:  114  128  142  156 ...
//
// One is drawn for every ledger position lying between the staff and the note,
// including one THROUGH the note when the note sits on a line. A note in the
// space immediately outside the staff gets none — madhya Sa (107) and taara Sa
// (51) are both bare, which is why the sthayi boundary reads cleanly.
//
// The ledger COUNT is what names the svara outside madhya. Nothing about the
// note glyph changes with octave.
export function ledgerLines(x, svi, oct) {
  const y = noteY(svi, oct);
  const EPS = 0.001;
  const mark = ly =>
    `<line x1="${(x - LEDGER_W / 2).toFixed(1)}" y1="${ly}" x2="${(x + LEDGER_W / 2).toFixed(1)}" y2="${ly}" stroke="${STAFF.stroke}" stroke-width="${STAFF.strokeW}"/>`;

  let out = '';
  if (y > BOTY) for (let ly = BOTY + STEP; ly <= y + EPS; ly += STEP) out += mark(ly);
  else if (y < TOPY) for (let ly = TOPY - STEP; ly >= y - EPS; ly -= STEP) out += mark(ly);
  return out;
}

// Vertical span of one note's ink, so a row can size itself to what it holds.
// Either end can be the outermost: the stem tip reaches past the goli on the
// stem's side, the goli past the tip on the other. Ledgers never exceed the
// goli — the outermost ledger is at most level with it.
function noteSpanOf(svi, oct) {
  const y = noteY(svi, oct);
  const tip = stemTip(svi, oct);
  const r = GOLI_R * NOTE_SCALE;
  let top = Math.min(y - r, tip);
  let bottom = Math.max(y + r, tip);
  // The svara letter is ink too, and it sits on the side the stem does NOT
  // leave from — so on the outermost notes it is the outermost thing in the
  // row. Leave it out of the span and the row box crops it: mandra Sa hangs
  // lowest of all and loses its S off the bottom edge.
  if (state.showNames) {
    const { top: nt, bottom: nb } = svaraNameSpan(y, stemPointsDown(svi, oct) ? -1 : 1);
    top = Math.min(top, nt);
    bottom = Math.max(bottom, nb);
  }
  return { top, bottom };
}

function glyphSpan(n) { return noteSpanOf(n.svaraIndex, n.oct); }

// Vertical extent of one row. A row is only as tall as what it holds: one
// staying inside ROW_TOP..ROW_BOT comes out at exactly that, while a row
// reaching further up or down the ladder grows. Rendering AND both export paths
// go through this, so a tall row cannot be clipped by an exporter that assumed
// a fixed height.
export function rowExtent(row) {
  const MARGIN = 10;
  let yMin = ROW_TOP;
  let yMax = ROW_BOT;
  row.boxes.forEach(b => b.entries.forEach(e => {
    if (e.note.type !== 'note') return;
    const { top, bottom } = glyphSpan(e.note);
    if (top - MARGIN < yMin) yMin = top - MARGIN;
    if (bottom + MARGIN > yMax) yMax = bottom + MARGIN;
  }));
  return { yMin, yMax, height: yMax - yMin };
}

// Every rest, whatever its weight, hangs in the same band, centred on GTOP —
// the upper green band, where the drawing puts all six. Only their widths and
// what they carry differ.
//
// They are DRAWN here rather than stamped from symbols/*_rest.svg for the same
// reason the noteheads are: an image has to be stretched to a box, and every
// rest came out of that box the same height (28 u) however wide it was — the
// wedges tall and thin, their bars narrower than a note's, Maguru's ring half
// again as big as the drawing's. Measured geometry (REST_GEOM and friends in
// config.js, read off reference/DNG-STUDIO-REFERENCE.pdf) fixes all of that at
// once, and it follows the score into print, SVG and PDF because those go
// through this same function.
export function restMark(x, restName, ink = STAFF.noteInk) {
  const sym = REST_MAP[restName];
  if (!sym) return '';
  const inkW = NOTE_INK_W.toFixed(3);
  const top = REST_MID - REST_SPIKE_H / 2;
  const bot = REST_MID + REST_SPIKE_H / 2;
  let out = '';

  if (sym === 'Maguru') {
    // A ring with a dot in it.
    out += `<circle cx="${x.toFixed(1)}" cy="${REST_MID}" r="${REST_RING_R}" fill="none" stroke="${ink}" stroke-width="${REST_RING_INK}"/>`;
    out += `<circle cx="${x.toFixed(1)}" cy="${REST_MID}" r="${REST_DOT_R}" fill="${ink}"/>`;
  } else if (sym === 'guru') {
    // A half-disc, flat side left, with a dot in it. The bbox is centred on the
    // cell, so the flat edge sits half the bulge to the left of x.
    const fx = x - REST_HALF_RX / 2;
    out += `<path d="M${fx.toFixed(2)} ${(REST_MID - REST_HALF_RY).toFixed(2)}`
         + ` A ${REST_HALF_RX} ${REST_HALF_RY} 0 0 1 ${fx.toFixed(2)} ${(REST_MID + REST_HALF_RY).toFixed(2)} Z"`
         + ` fill="none" stroke="${ink}" stroke-width="${REST_HALF_INK}" stroke-linejoin="round"/>`;
    out += `<circle cx="${(fx + REST_DOT_DX).toFixed(2)}" cy="${REST_MID}" r="${REST_DOT_R}" fill="${ink}"/>`;
  } else {
    // A wedge, plus one bar per step down the hierarchy. bindu's points DOWN
    // and carries nothing; vasu, praya and danta point up and carry 1, 2 and 3.
    const g = REST_GEOM[sym] || REST_GEOM.bindu;
    const apex = g.up ? top : bot;
    const base = g.up ? bot : top;
    const hw = REST_SPIKE_W / 2;
    for (const s of [-1, 1]) {
      out += `<line x1="${x.toFixed(1)}" y1="${apex.toFixed(2)}"`
           + ` x2="${(x + s * hw).toFixed(2)}" y2="${base.toFixed(2)}"`
           + ` stroke="${ink}" stroke-width="${inkW}" stroke-linecap="round"/>`;
    }
    // Bars hang back from the apex, which for these is always the top.
    for (const b of g.bars) {
      const by = apex + b;
      out += `<line x1="${(x - REST_BAR_W / 2).toFixed(2)}" y1="${by.toFixed(2)}"`
           + ` x2="${(x + REST_BAR_W / 2).toFixed(2)}" y2="${by.toFixed(2)}"`
           + ` stroke="${ink}" stroke-width="${inkW}"/>`;
    }
  }
  return `<g>${out}</g>`;
}

// ---------- repeat marks ----------

// Air around the brace in its grab target and selection outline. Screen only
// — nothing printed is placed by it.
const REP_HIT_PAD = 3.5;

// One half of a repeat mark, drawn at `x` staff units — the same way a note
// and a rest are drawn, and for the same reason. It used to be an <image>
// pointing at symbols/repeat_*.svg with a nested viewBox cropping one half out
// of the 40-wide pair, which lost the mark to exportSVG() entirely (a relative
// href in a file that is written out on its own resolves against nothing) and
// rasterised a hairline at row scale, so on the sheet it read as a grey smudge
// beside ink-black notation. See the repeat block in config.js.
//
// An opening mark brackets to the RIGHT, into the music it encloses; a closing
// one to the left. Both are ONE path — tip, corner, corner, tip — so the
// flares weld to the vertical instead of butting against it with a notch, as
// the artwork's three separate strokes did.
//
// `ink` is the last argument for the same reason it is on noteGlyph() and
// restMark(): the playback highlight recolours the mark it is drawing rather
// than filling the finished glyph from CSS.
export function repeatMark(x, kind, count = 2, ink = STAFF.noteInk) {
  const d = kind === 'close' ? -1 : 1;
  // Half the ink off the position, so the vertical's ink sits wholly on its
  // own side of the point it means — and a close and an open at the same unit
  // ("end this repeat, start the next") read as a double bar rather than one.
  const vx = x + d * (NOTE_INK_W / 2);
  const tipX = (vx + d * REPEAT_WING_X).toFixed(2);
  const vX = vx.toFixed(2);
  let out = `<path d="M${tipX} ${TOPY} L${vX} ${(TOPY + REPEAT_V_INSET).toFixed(2)}`
    + ` L${vX} ${(BOTY - REPEAT_V_INSET).toFixed(2)} L${tipX} ${BOTY}"`
    + ` fill="none" stroke="${ink}" stroke-width="${NOTE_INK_W.toFixed(3)}"`
    + ` stroke-linecap="round" stroke-linejoin="round"/>`;
  // The count IS the dot count — two dots ×2, three ×3, four ×4 — stacked
  // about the mark's own midline so the mark stays symmetric whichever it is.
  const n = Math.max(2, Math.min(4, Math.round(Number(count) || 2)));
  const gap = n === 2 ? REPEAT_DOT_GAP2 : REPEAT_DOT_GAP;
  const dotX = (vx + d * REPEAT_DOT_DX).toFixed(2);
  for (let i = 0; i < n; i += 1) {
    const cy = REPEAT_MID + (i - (n - 1) / 2) * gap;
    out += `<circle cx="${dotX}" cy="${cy.toFixed(2)}" r="${REPEAT_DOT_R}" fill="${ink}"/>`;
  }
  return `<g>${out}</g>`;
}

// The same mark, boxed on its own for the palettes and the Notation Guide —
// so a palette glyph cannot advertise a brace the staff does not write.
//
// The default ink is currentColor, which is what lets the dark sidebar show it
// without the invert filter the <image> version needed. A caller drawing onto
// PAPER rather than onto the chrome passes STAFF.noteInk instead: the Notation
// Guide's tiles are white cards inside a panel whose text is light, so
// inheriting the panel's colour would print the brace white on white.
export function repeatGlyphSVG(kind, count, w, h, cls = '', ink = 'currentColor') {
  const pad = 3;
  const half = NOTE_INK_W / 2;
  const span = kind === 'pair' ? REPEAT_PAIR_SPAN : 0;
  const art = (kind === 'close' ? '' : repeatMark(0, 'open', count, ink))
    + (kind === 'open' ? '' : repeatMark(span, 'close', count, ink));
  const x0 = kind === 'close' ? -(REPEAT_W + pad) : -(half + pad);
  const x1 = kind === 'open' ? REPEAT_W + pad : span + half + pad;
  const y0 = TOPY - half - pad;
  const y1 = BOTY + half + pad;
  return `<svg${cls ? ` class="${cls}"` : ''} viewBox="${x0.toFixed(2)} ${y0.toFixed(2)}`
    + ` ${(x1 - x0).toFixed(2)} ${(y1 - y0).toFixed(2)}"`
    + ` width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet"`
    + ` aria-hidden="true">${art}</svg>`;
}

// ---------- rendering ----------

// Build the SVG for one row returned by scoreRows().
function rowSVG(row, hl, at, interactive = true) {
  const W = VW;
  const RX = W - RPAD;              // staff right edge — BX0..RX is exactly 18 cm

  // Flatten the row up front: the entries decide how tall this row has to be,
  // and later passes (joins, highlight, glyphs) walk the same list.
  const entries = [];
  row.boxes.forEach(b => b.entries.forEach(e => entries.push(e)));

  const { yMin, height: vh } = rowExtent(row);

  // Explicit physical width/height so the staff measures 18.00 x 0.8 cm on
  // screen at 100% zoom, in print, and in every export. Width is fixed; only
  // the height varies with content.
  let s = `<svg viewBox="0 ${yMin.toFixed(1)} ${W} ${vh.toFixed(1)}"`
        + ` width="${toCM(W).toFixed(4)}cm" height="${toCM(vh).toFixed(4)}cm"`
        + ` preserveAspectRatio="xMidYMid meet">`;
  s += `<rect x="${BX0}" y="${GTOP}" width="${RX - BX0}" height="${BOTY - GTOP}" fill="${STAFF.greenFill}"/>`;
  const hline = y => `<line x1="${BX0}" y1="${y}" x2="${RX}" y2="${y}" stroke="${STAFF.stroke}" stroke-width="${STAFF.strokeW}"/>`;
  s += hline(TOPY) + hline(GTOP) + hline(MAGY) + hline(BOTY);
  // Transparent hit areas make an entire timing division selectable, including
  // the blank tail filled by rests. Glyphs are drawn after these so clicking a
  // note still selects the note itself. `b.x` is measured from LPAD like every
  // other box coordinate here, so the offset has to be added — without it the
  // outline sat a division's worth of margin to the LEFT of the division it
  // claimed to select, and the click target was shifted with it.
  row.boxes.forEach(b => {
    s += `<rect class="section-hit" x="${(LPAD + b.x).toFixed(2)}" y="${yMin.toFixed(1)}"`
      + ` width="${b.width.toFixed(2)}" height="${vh.toFixed(1)}"`
      + ` data-box-at="${b.at}" fill="transparent"/>`;
  });

  // The magic line's two echoes, one octave out on each side. Every staff row
  // in Files/DNG NOTATION PAGE LAYOUT.svg carries this pair, so they are drawn
  // unconditionally — they are furniture of the sheet, not a function of what
  // the row happens to hold. They span the staff exactly like the printed
  // lines and go down before the notes, so a goli sits on top of them.
  s += OCTAVE_RULE_Y.map(y =>
    `<line x1="${BX0}" y1="${y}" x2="${RX}" y2="${y}" stroke="${STAFF.stroke}"`
    + ` stroke-width="${OCTAVE_RULE_W}" stroke-dasharray="${OCTAVE_RULE_DASH}"/>`).join('');

  const vline = (x, w) => `<line x1="${x}" y1="${TOPY}" x2="${x}" y2="${BOTY}" stroke="${STAFF.stroke}" stroke-width="${w}"/>`;
  s += vline(BX0, STAFF.strokeW) + vline(LPAD, STAFF.strokeW) + vline(RX, STAFF.strokeW);

  // Box dividers. Boxes are different widths now, so these come from the
  // cumulative box edges rather than fixed quarters. The trailing edge of the
  // last box is drawn too, unless it lands on the row's right edge already.
  row.boxes.forEach((b, i) => {
    if (i > 0) s += vline(LPAD + b.x, STAFF.strokeW);
  });
  if (row.boxes.length) {
    const end = LPAD + row.width;
    if (Math.abs(end - RX) > 0.5) s += vline(end, STAFF.strokeW);
  }

  // The metre's interior group edges — the additive formula, drawn. `3+2+2`
  // rules its division at beats 3 and 5. Same line as a division edge but
  // faded (GROUP_LINE_OPACITY), because a group is subordinate to the division
  // it sits inside; drawing it heavier would say the opposite.
  const gEdges = groupEdges();
  if (gEdges.length) {
    const cap = boxUnits();
    row.boxes.forEach(b => gEdges.forEach(beat => {
      const off = beat * TIME_UNITS_PER_BEAT;
      if (off <= 0 || off >= cap) return;
      // Layout is content-driven, so a group edge is NOT a fraction of the
      // box's width: it belongs in front of the glyph that starts that beat.
      // A division with no glyph there — the empty ones padding the last row,
      // or metro fill's blank tail — falls back to the proportional position.
      const e = b.at != null ? b.entries.find(en => en.at - b.at >= off) : null;
      const gx = (LPAD + (e ? e.x : b.x + b.width * (off / cap))).toFixed(2);
      s += `<line x1="${gx}" y1="${TOPY}" x2="${gx}" y2="${BOTY}"`
        + ` stroke="${STAFF.stroke}" stroke-width="${STAFF.strokeW}"`
        + ` stroke-opacity="${GROUP_LINE_OPACITY}"/>`;
    }));
  }

  // The stretch each repeat pair covers. Drawn transparent and lit by
  // repeats.js on hover or selection — a class change rather than a re-render,
  // which at 400 notes costs 13 ms and cannot run on a mouseover. Screen only:
  // an export must not carry an invisible rect that is not notation.
  if (interactive) (row.spans || []).forEach(sp => {
    s += `<rect class="repspan" data-pair="${sp.pairId}"`
      + ` x="${(LPAD + sp.x0).toFixed(2)}" y="${TOPY}"`
      + ` width="${Math.max(0, sp.x1 - sp.x0).toFixed(2)}" height="${BOTY - TOPY}"`
      + ` fill="${STAFF.repeatInk}" fill-opacity="0" pointer-events="none"/>`;
  });

  // Transparent like every other hollow goli, so the magic line drawn above
  // runs straight through it — no white disc, no patched-in stub of line.
  // Drawn at note weight, not staff weight: it is a mark on the sheet like a
  // goli, not one of the ruled lines, and at hairline width it disappeared
  // against the magic line running through it.
  s += `<circle cx="38" cy="${MAGY}" r="5" fill="none" stroke="${STAFF.noteInk}" stroke-width="${NOTE_INK_W.toFixed(3)}"/>`;

  // Repeat marks. On screen each one is a grabbable handle: a group carrying
  // its bar id, with a transparent rect over the artwork so the whole brace is
  // a target rather than the few lit strokes of the mark. The exporters ask
  // for a non-interactive row and get the bare drawing.
  row.bars.forEach(b => {
    const open = b.kind === 'open';
    const x = LPAD + b.x;
    const art = repeatMark(x, b.kind, b.count);
    if (!interactive) { s += art; return; }
    // The handle is the size of the brace plus a little air, on the side the
    // brace is actually drawn — measured off REPEAT_W rather than guessed, so
    // it cannot drift from the ink if the mark's proportions change.
    const repY = TOPY - REP_HIT_PAD;
    const repH = (BOTY - TOPY) + REP_HIT_PAD * 2;
    const repW = REPEAT_W + REP_HIT_PAD * 2;
    const repX = (open ? x - REP_HIT_PAD : x + REP_HIT_PAD - repW).toFixed(2);
    const sel = state.selBar === b.id ? ' sel' : '';
    s += `<g class="repmark${sel}" data-bar="${b.id}" data-kind="${b.kind}"`
      + ` data-count="${b.count}" data-unit="${b.unit}">${art}`
      + `<rect x="${repX}" y="${repY}" width="${repW.toFixed(2)}" height="${repH}" fill="transparent"/>`
      + `<rect class="repsel" x="${repX}" y="${repY}" width="${repW.toFixed(2)}"`
      + ` height="${repH}" rx="3" fill="none" pointer-events="none"/></g>`;
  });



  const glyphX = e => LPAD + e.x + e.w / 2;
  const isNote = e => e && e.note.type === 'note';

  // A joining line means one note ran on OUT OF ITS DIVISION and continued in
  // the next. Two conditions, and the second is the notation's rule rather than
  // a consequence of the first: `tie` says the glyph is a continuation, and
  // `prev.box !== entry.box` says the continuation crossed a division line.
  //
  // A note cut INSIDE one division is not marked. The packer cuts wherever the
  // greedy walk cannot spend a value in a single glyph — 2½ beats is written
  // `guru + vasu`, 3½ as `guru• + vasu` — and DNG reads those as the value they
  // add up to without needing an arc to say so; the arc is reserved for the one
  // case the reader cannot see from the division alone, which is a note carried
  // over the line. This was briefly changed to arc every split, on the argument
  // that playback sounds both as one note and the ink should not disagree with
  // the ear. The notation's author says otherwise, and it is their rule: inside
  // a division the glyphs sit together and are read together, so an arc there
  // is clutter over something already unambiguous.
  //
  // Two separate notes never join either way, however adjacent — so holding a
  // key and then jumping to the next key draws nothing.
  // The arc hugs the notehead on the side away from the stem — notes above the
  // magic line are drawn flipped with the stem hanging down, so theirs goes
  // over the top. It is only pushed as far as the nearest staff edge, never
  // further: dividers run TOPY→BOTY, so clearing them is enough to keep the
  // join uncrossed while it stays next to the heads it belongs to.
  // Clear of the HEAD, by the head's own radius plus JOIN_GAP — not by a
  // number that happens to be about a notehead. The two were the same size
  // (6 against a goli radius of 6.03), so the arc started inside the notehead
  // and read as a line drawn through the notation rather than over it.
  const joinClear = GOLI_R * NOTE_SCALE + JOIN_GAP;
  const joinY = e => {
    const y = noteY(e.note.svaraIndex, e.note.oct);
    return y < MAGY
      ? Math.min(y - joinClear, TOPY - joinClear)
      : Math.max(y + joinClear, BOTY + joinClear);
  };
  const arc = (x0, x1, y) => {
    const span = Math.abs(x1 - x0);
    const depth = Math.max(JOIN_BOW_MIN, Math.min(JOIN_BOW_MAX, span * JOIN_BOW));
    const bow = y < MAGY ? -depth : depth;
    return `<path d="M${x0.toFixed(1)} ${y.toFixed(2)} Q ${((x0 + x1) / 2).toFixed(1)} ${(y + bow).toFixed(2)} ${x1.toFixed(1)} ${y.toFixed(2)}" fill="none" stroke="${STAFF.noteInk}" stroke-width="${JOIN_INK_W.toFixed(3)}" stroke-linecap="round"/>`;
  };

  const drawJoin = (first, last) => arc(glyphX(first), glyphX(last), joinY(first));
  // Half an arc, for a split whose other half is on the neighbouring row.
  const drawStub = (e, toX) => arc(glyphX(e), toX, joinY(e));

  entries.forEach((entry, i) => {
    const prev = entries[i - 1];
    if (entry.tie && isNote(prev) && isNote(entry) && prev.box !== entry.box) {
      s += drawJoin(prev, entry);
    }
  });

  const head = entries[0];
  const tail = entries[entries.length - 1];
  if (head && head.tie && isNote(head)) s += drawStub(head, LPAD);
  if (row.tieOut && isNote(tail)) s += drawStub(tail, RX);

  // Playing highlight. ONE thing happens: the symbol that is sounding is drawn
  // in a different colour. Nothing is laid over the staff and nothing moves.
  //
  // What this replaced was a light wash across the whole beat, a deeper block
  // under the current symbol, and a 5-unit lift on it. All three are gone at
  // the request of the notation's author — the marks sat on top of the page
  // and turned a printed-accurate sheet into a screen effect while it played.
  // Recolouring the glyph says the same thing without adding any ink that is
  // not notation.
  //
  // `at` comes from playback in timing units and picks the sounding entry
  // exactly; without it (the brief flash on note entry) the source index is
  // what marks the glyph, which is what `active` reads below.
  const hlAt = at != null ? at
    : hl != null ? (entries.find(e => e.index === hl) || {}).at
    : undefined;
  const nowEntry = hlAt != null
    ? entries.find(e => hlAt >= e.at && hlAt < e.at + e.units)
    : null;

  // Everything a click needs to describe the glyph travels on the element
  // itself, so the inspector never has to look anything up in state — which
  // matters because derived pad rests are not in state.notes at all.
  const glyphAttrs = e => {
    const n = e.note;
    const sound = n.type === 'rest' ? (REST_MAP[n.sym] || 'bindu') : n.sym;
    let a = `class="glyph" data-kind="${n.type}" data-sym="${sound}"`
          + ` data-dot="${n.dot ? 1 : 0}" data-dur="${n.dur}" data-units="${e.units}"`
          + ` data-at="${e.at}" data-src="${e.index != null ? e.index : ''}"`
          + ` data-tie="${e.tie ? 1 : 0}"`;
    if (n.type === 'note') {
      a += ` data-svi="${n.svaraIndex}" data-oct="${n.oct}" data-head="${n.head || 'auto'}"`;
    }
    return a;
  };

  entries.forEach(e => {
    const n = e.note;
    const x = glyphX(e);
    // The entry that is SOUNDING, not merely one sharing its source index: a
    // note split across a division line is two entries with one index, and
    // marking both would light a glyph that is not being heard yet.
    const active = nowEntry ? e === nowEntry
      : (hl != null && e.index != null && hl === e.index);
    // A lesson's hit/miss marks, on screen only — an export is never marked.
    const mark = interactive && state.lesson && e.index != null
      ? state.lesson.marks[e.index] : null;
    const ink = active ? STAFF.playInk
      : mark ? `var(--lesson-${mark})` : STAFF.noteInk;

    if (n.type === 'rest') {
      // Rests are drawn markup now, so the playback lift rides the same
      // data-active wrapper the notes use rather than a class of its own.
      s += `<g ${glyphAttrs(e)}${active ? ' data-active="1"' : ''}>${restMark(x, n.sym, ink)}</g>`;
      return;
    }

    const y = noteY(n.svaraIndex, n.oct);
    const variant = n.head === 'f' ? true : n.head === 'o' ? false : SVARAS[n.svaraIndex].filled;
    // M2 is the one variant that is SHARP, so it cannot use the filled goli
    // that means "lowered". Its notehead is a triangle instead.
    const isM2 = variant && n.svaraIndex === MA_INDEX;
    const filled = isM2 ? false : variant;
    const sound = NOTE_GEOM[n.sym] ? n.sym : 'bindu';
    s += ledgerLines(x, n.svaraIndex, n.oct);
    // One rule in every sthayi: the stem flips at the magic line, so above it
    // the goli sits on top and the stem hangs down. Octave changes nothing
    // here — it has already been spent on where `y` landed.
    const dir = stemPointsDown(n.svaraIndex, n.oct) ? -1 : 1;
    const body = noteGlyph(x, y, sound, filled, dir, !!n.dot,
      stemTip(n.svaraIndex, n.oct), isM2, ink)
      + (state.showNames ? svaraName(x, y, n, dir) : '');
    s += `<g ${glyphAttrs(e)}${active ? ' data-active="1"' : ''}>${body}</g>`;
  });

  // Hit areas for the Break tool — one per division, carrying the box ordinal
  // a break is stored against. They go down LAST so a click in break mode
  // lands on the division rather than on whatever glyph happens to be under
  // the pointer, and they are `pointer-events:none` until the tool is armed,
  // so in every other mode the staff behaves exactly as before. Purely a
  // screen affordance — the exporters ask for a non-interactive row and get
  // none of them, so no export carries a rect that is not notation.
  // The end-of-line bracket: this row ends in a manual break. It is drawn ON
  // the music rather than beside it because a broken row now measures the
  // staff like every other row — nothing else about it says the line was cut.
  // Screen only, like the hit rects below: a printed sheet says "the line ends
  // here" by the line ending, and an editing mark has no business in an export.
  if (interactive && row.brkAfter != null) {
    const x0 = RX - BRK_ARM;
    const x1 = RX + BRK_OUT;
    s += `<path class="brkend${row.brkAfter === state.lastBreak ? ' last' : ''}"`
      + ` d="M${x0} ${TOPY - BRK_OVER} H${x1} V${BOTY + BRK_OVER} H${x0}" fill="none"/>`;
  }

  // The division the LAST break falls before is marked on the staff itself —
  // the ↵ badge sits in the margin at the end of the row ABOVE, which is where
  // the break ends a line rather than where it starts one. The mark rides on
  // the hit rect that is already here rather than being a shape of its own, so
  // it inherits the one property that matters: these rects exist only for the
  // screen, so no export and no print can carry an editing mark.
  if (interactive) row.boxes.forEach(b => {
    const last = b.ord === state.lastBreak;
    s += `<rect class="boxhit${last ? ' lastbrk' : ''}" data-ord="${b.ord}" x="${(LPAD + b.x).toFixed(1)}"`
      + ` y="${TOPY}" width="${Math.max(1, b.width).toFixed(1)}" height="${BOTY - TOPY}"`
      + ` fill="transparent"/>`;
    // The break itself is the division's LEFT EDGE — where the new line
    // starts. The wash says which division moved; this says where the cut is.
    if (last) {
      s += `<line class="brkline" x1="${(LPAD + b.x).toFixed(1)}" x2="${(LPAD + b.x).toFixed(1)}"`
        + ` y1="${TOPY - 8}" y2="${BOTY + 8}"/>`;
    }
  });

  return s + '</svg>';
}

// The row gutter — number plus the sthayi key (taara above the staff, madhya
// on it, mandra below). Each mark is placed by the staff line it names, in the
// row SVG's own cm scale, because a row is only as tall as what it holds: a row
// carrying mandra notes grows downward, and anything centred on the row box
// would drift off the staff it is supposed to be labelling.
//
// Every number it places by lives in config.js (GUTTER_*), because pdf.js has
// to draw this same gutter with jsPDF primitives — no DOM to lay it out — and
// the two copies had already drifted apart. The horizontal offsets are written
// here as inline styles for the same reason: the stylesheet keeps the ink
// (colour, font, the shapes' borders), the geometry comes from config.

// The end-of-line bracket's geometry, in staff units. Not in config.js's
// printed-page block: it is a screen affordance, and nothing prints or exports
// it. The spine sits just outside the closing barline, in the BLEED, and the
// arms reach back over the staff so it reads as a clamp on the line's end.
const BRK_ARM = 11;     // how far the arms reach back into the staff
const BRK_OUT = 6;      // how far the spine stands outside the closing barline
const BRK_OVER = 10;    // how far above the top line and below the bottom it runs

// The ↵ badge shown at the end of the row a manual break falls after. It is
// HTML beside the row, not part of the row SVG, because a break is a layout
// instruction rather than notation — it must not print or export. Clicking it
// removes the break it marks, whichever tool is selected.
// The one the user placed or moved last is drawn filled rather than outlined,
// so a margin holding several of them says which is current — that is the one
// the arrow keys move, and the only one there is a reason to pick out.
function breakMark(ord, yMin, last) {
  const tip = last
    ? 'Last break — drag to move, ←/→ to nudge, click to remove'
    : 'Line break — click to pick it up, drag to move';
  return `<span class="brkmark${last ? ' last' : ''}" data-brk="${ord}" title="${tip}"`
    + ` style="top:${toCM(MAGY - yMin).toFixed(5)}cm">↵</span>`;
}

// A break stored past the end of the written music has no division to fall
// before, so no row carries its badge and it would otherwise be invisible —
// stored, saved, and silently back in force the moment enough notes are typed
// to reach it. It is not pruned, because deleting a bar of music is no reason
// to throw away where somebody asked the line to end; it is stated instead.
function ghostBreak(ord) {
  return `<div class="brkghost"><span class="gbadge" data-brk="${ord}">↵</span>`
    + `<b>Break past the end of the score</b>`
    + `<span class="drop" data-brk="${ord}" title="Remove this break">Remove</span></div>`;
}

// The ✕ beside a repeat mark. HTML over the row for the same reason the break
// badge is: it is an editing affordance, not notation, so it must never print
// or export. It is invisible until repeats.js lights it — hovering the brace
// it belongs to, or selecting that brace.
function repeatBadges(row, yMin) {
  return (row.bars || []).map(b => {
    // Centred on the brace: an opening one is drawn to the right of its edge,
    // a closing one to the left, so the badge follows the ink.
    const half = REPEAT_W / 2;
    const cx = LPAD + b.x + (b.kind === 'close' ? -half : half);
    return `<span class="repx" data-bar="${b.id}" title="Remove this repeat mark"`
      + ` style="left:${toCM(cx).toFixed(5)}cm;top:${toCM(TOPY - 12 - yMin).toFixed(5)}cm">✕</span>`;
  }).join('');
}

function rowGutter(n, yMin) {
  const at = u => `${toCM(u - yMin).toFixed(5)}cm`;
  const cm = u => `${toCM(u).toFixed(5)}cm`;
  // Both are boxes the CSS centres on their own left/width, so the left edge is
  // the centre less half the box.
  const numL = cm(GUTTER_NUM_X - GUTTER_NUM_BOX / 2);
  const markL = cm(GUTTER_MARK_X - GUTTER_TRI_W / 2);
  const markW = cm(GUTTER_TRI_W);
  return `<span class="num" style="top:${at(MAGY)};left:${numL};width:${cm(GUTTER_NUM_BOX)};`
    + `height:${cm(GUTTER_NUM_BOX)};margin-top:${cm(-GUTTER_NUM_BOX / 2)}"><b>${n}</b></span>`
    + `<i class="sth up" style="top:${at(TOPY - GUTTER_OUT)};left:${markL};width:${markW}"></i>`
    + `<i class="sth mid" style="top:${at(MAGY + GUTTER_MID_OFFSET)};left:${markL};width:${markW}"></i>`
    + `<i class="sth dn" style="top:${at(BOTY + GUTTER_OUT)};left:${markL};width:${markW}"></i>`;
}

// Where every row sits on the A4 page: which page, how far down it, and how
// tall. The PDF export and the screen's Page view both place rows by this, so
// the page on screen breaks where the exported one does. Height is per-row:
// mandra/taara stems make a row taller than the madhya baseline, and the break
// has to account for the row it is about to place rather than a fixed step.
export function pageLayout(rows) {
  let y = PAGE_FIRST_Y, page = 0;
  return rows.map(row => {
    const h = toMM(rowExtent(row).height);
    if (y + h > PAGE_BOT_LIMIT) { page++; y = PAGE_NEXT_Y; }
    const at = { page, y, h };
    y += h + ROW_GAP_MM;
    return at;
  });
}

// Page view's seam between two pages, written after the last row of one: the
// rest of that page with its own pill and brand line, a strip of stage, then
// the next page's top padding. Its height is what makes every page on screen
// exactly A4 tall. Screen only — the print rules hide it.
function pageEnd(last) {
  const mm = n => `${n.toFixed(3)}mm`;
  const foot = PAGE_H_MM - (last.y + last.h);
  return `<div class="pgend" style="height:${mm(foot + PAGE_GAP_MM + PAGE_NEXT_Y)}">`
    + `<div class="pgfoot" style="height:${mm(foot)}">`
    + `<div class="pagenum"><span>${last.page + 1}</span></div>`
    + `<div class="brand">© Lyptron</div></div>`
    + `<div class="pggap" style="height:${mm(PAGE_GAP_MM)}"></div></div>`;
}

export function render() {
  const score = document.getElementById('score');
  // The last-break pointer is validated here because this is the one funnel
  // every path that can invalidate it ends in — undo, loading a file, clearing
  // the score, switching tabs. A pointer at a break that no longer exists
  // would mark a division for no reason.
  if (state.lastBreak != null && !(state.breaks || []).includes(state.lastBreak)) {
    state.lastBreak = null;
  }
  const rows = scoreRows();
  let ghosted = state.lastBreak == null;
  // Page view lays the rows out as A4 pages; off, the sheet is one continuous
  // strip with no page number, because it is not a page.
  const at = state.pageView ? pageLayout(rows) : null;
  const pages = at && at.length ? at[at.length - 1].page + 1 : 1;
  const sheet = score.closest ? score.closest('.sheet') : null;
  if (sheet && sheet.style) {
    sheet.classList.toggle('flow', !at);
    sheet.style.minHeight = at
      ? `${(pages * PAGE_H_MM + (pages - 1) * PAGE_GAP_MM).toFixed(3)}mm` : '';
    const pill = sheet.querySelector(':scope > .pagenum span');
    if (pill) pill.textContent = pages;
  }
  score.innerHTML = rows.map((row, i) => {
    const yMin = rowExtent(row).yMin;
    // The badge belongs to the row the break falls AFTER, so it reads as the
    // end of a line rather than the start of one.
    const next = rows[i + 1];
    if (next && next.brk && next.brkOrd === state.lastBreak) ghosted = true;
    const mark = next && next.brk
      ? breakMark(next.brkOrd, yMin, next.brkOrd === state.lastBreak) : '';
    const seam = at && i && at[i].page !== at[i - 1].page ? pageEnd(at[i - 1]) : '';
    return `${seam}<div class="srow" data-row="${i}">${rowGutter(i + 1, yMin)}${mark}`
      + `${repeatBadges(row, yMin)}`
      + `${rowSVG(row, state.hlIndex, state.hlAt)}</div>`;
  }).join('');
  // No row claimed it: the break is out past the last division, so say so
  // under the staff rather than leaving the user with a break they cannot see.
  if (!ghosted) score.insertAdjacentHTML('beforeend', ghostBreak(state.lastBreak));
  updateSheetMeta();
  document.dispatchEvent(new CustomEvent('score:rendered'));
}

// The three read-only fields under the sheet header. They mirror app state
// rather than being typed, so the printed sheet cannot name a tempo the
// transport is not playing or a key the samples are not sounding.
//
//   K.S.  the tonic the Sa key is set to — pitch is intervallic from it
//   T.S.  beats per division over the quarter-note they are counted in
//   Tempo the transport BPM
const KEY_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

export function updateSheetMeta() {
  const set = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  set('ksVal', KEY_NAMES[(((state.saMidi ?? 60) % 12) + 12) % 12]);
  // The metre, over 4 — see timesig.js on why there is no denominator to
  // choose. The tala's NAME and its formula stay in the picker: the printed
  // header is emblem, rule and tone legend, with metre stated by T.S. alone.
  set('tsVal', `${beatsPerBox()}/4`);
  set('tempoVal', String(state.bpm));
}

export { rowSVG };
