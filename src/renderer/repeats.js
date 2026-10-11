// Repeat marks on the sheet: dragging one in from the palette, dragging one
// that is already there, selecting one, and taking one off again.
//
// A mark goes WHERE IT IS DROPPED. Nothing snaps to a division, and nothing
// waits for the score to be filled in: the staff is a clock, so any point
// along a row — inside a division, part-way through a held note, or out on
// empty staff past the music — is a place a brace can sit. What is stored is
// that point on the clock (see repeat-model.js), which is why the mark stays
// where it was put when the score is edited, re-flowed or zoomed.
//
// One gesture does both jobs. Pressing on a palette glyph starts a NEW pair;
// pressing on a brace already on the staff MOVES that one. Both follow the
// pointer with the same ghost, snap to the same targets, and are judged by the
// same rule before they are allowed to land: the result must still read as a
// flat sequence of repeats (repeat-model.js), so a drop that would nest one
// pair inside another is refused rather than accepted and silently misplayed.
//
// Pointer events, not HTML5 drag-and-drop: the marks live inside an SVG, the
// same code has to move a mark that is already there, and a drag that starts
// on a <g> inside an <svg> is not something the file-drop machinery handles
// gracefully. It also means touch and pen work for free.
//
// A press that does not move is a CLICK: the first one selects the brace, and
// a second on an already-selected brace cycles its count 2 -> 3 -> 4. That is
// the same idiom the palette glyph itself uses.
//
// There is a second way in, and it is the BREAK TOOL'S: arm the palette glyph
// and the sheet goes into repeat mode, where one click marks where the loop
// starts and the next marks where it ends. Two clicks, the same two points a
// drag would have set, resolved by the same pointAt() against the same glyph
// cells - so a pair placed by clicking and a pair placed by dragging are the
// same pair. It exists because that is how a repeat is described out loud
// ("from here, back to here"), because it needs no sustained gesture on a
// trackpad or a touchscreen, and because the two ends can be far apart or on
// different rows, which is exactly where a drag is worst.

import { state } from './state.js';
import { VW, LPAD, TIME_UNITS_PER_BEAT, STAFF } from './config.js';
import {
  scoreRows, unitAtX, unitPos, entryCells, cellAtX, repeatGlyphSVG,
} from './notation.js';
import { beatsPerBox } from './timesig.js';
import { addRepeatPair, moveBar, removeBar, setBarCount } from './score.js';
import {
  repeatPairs, validateBars, withBarMoved, withPairAdded, resolveMark,
} from './repeat-model.js';

// How far the pointer may travel before a press stops being a click.
const CLICK_SLOP = 4;

let drag = null;      // the gesture in flight, or null
let ghost = null;     // the brace following the pointer
let marker = null;    // the line showing where it would land

function score() { return document.getElementById('score'); }

// ---- geometry ------------------------------------------------------------

// The rows as they are on screen: the laid-out row, and the rectangle it
// occupies. Measured when a drag starts, which is the only moment it can be
// right — it is read off what is rendered.
function rowRects() {
  const rows = scoreRows();
  const svgs = score() ? score().querySelectorAll('.srow svg') : [];
  const out = [];
  rows.forEach((row, i) => {
    const svg = svgs[i];
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    // The row SVG's viewBox is VW units wide however tall it is, so a unit x
    // maps onto the element's width directly.
    out.push({ row: i, rect: r, k: r.width / VW });
  });
  // The glyphs, as spans of the clock. The drop line is shown where the mark
  // will actually settle — over the note it will loop from — rather than at
  // the raw pointer, so what is previewed is what is placed, and what is
  // placed is what plays.
  return { rows, placed: out, cells: entryCells(rows) };
}

// Where the pointer is, as a point on the clock. The row is whichever one the
// pointer is inside or nearest to vertically; along it any x will do — a mark
// is placed freely and there are no division edges to hit.
//
// The point then settles onto the nearest glyph boundary, because that is
// where the loop can actually be cut. Landing between two notes and playing
// from a third is the one thing a repeat mark must never do.
function pointAt(geometry, pointerX, pointerY, closing) {
  const { rows, placed, cells } = geometry;
  if (!placed.length) return null;
  let best = placed[0];
  let bestD = Infinity;
  for (const p of placed) {
    const r = p.rect;
    const dy = pointerY < r.top ? r.top - pointerY
      : pointerY > r.bottom ? pointerY - r.bottom : 0;
    if (dy < bestD) { bestD = dy; best = p; }
  }
  const r = best.rect;
  // Staff units into the row, clamped to the staff itself: the bleed either
  // side of it is for ledger lines, not for notation.
  const units = (pointerX - r.left) / best.k - LPAD;
  const rowUnits = rows[best.row] ? rows[best.row].width : 0;
  const x = Math.max(0, Math.min(rowUnits, units));
  // Pointing anywhere at a note is enough: an opening brace takes that note as
  // the loop's first, a closing one takes it as the loop's last. The cell is
  // found in PAGE space, not by turning x into a time first — see cellAtX()
  // for why that round trip lost short symbols. Only out on empty staff, where
  // there is no cell, does the position come from the clock directly.
  const cell = cellAtX(rows, best.row, x);
  const unit = cell
    ? (closing ? cell.at + cell.units : cell.at)
    : Math.max(0, Math.round(
      resolveMark(unitAtX(rows, best.row, x), closing ? 'close' : 'open', cells)));

  // Show the line where the brace will be drawn, which for a closing one is
  // the end of the row above when it settles on a row's first edge.
  const pos = unitPos(rows, unit, closing);
  const host = placed.find(p => p.row === (pos ? pos.row : best.row)) || best;
  return {
    unit,
    x: host.rect.left + (LPAD + (pos ? pos.x : x)) * host.k,
    top: host.rect.top,
    bottom: host.rect.bottom,
  };
}

// ---- the floating bits ---------------------------------------------------

function makeGhost(html) {
  const g = document.createElement('div');
  g.className = 'rep-ghost';
  // Hidden until the pointer actually moves: a press that turns out to be a
  // click must not flash a brace in the corner of the screen on its way past.
  g.style.display = 'none';
  g.innerHTML = html;
  document.body.appendChild(g);
  return g;
}

function makeMarker() {
  const m = document.createElement('div');
  m.className = 'rep-drop';
  m.style.display = 'none';
  document.body.appendChild(m);
  return m;
}

function clearFloating() {
  if (ghost) { ghost.remove(); ghost = null; }
  if (marker) { marker.remove(); marker = null; }
  document.body.classList.remove('rep-dragging');
}

// ---- validity ------------------------------------------------------------

// What the score's marks would be if this drag landed here. Returns null when
// the result would not read — a nest, or a close before its open — which is
// what turns the drop marker red and makes the release do nothing.
function candidate(point) {
  if (!point) return null;
  if (drag.kind === 'new') {
    const closeUnit = closeFor(point.unit);
    const next = withPairAdded(state.bars, point.unit, closeUnit, drag.count);
    return validateBars(next).ok ? { openUnit: point.unit, closeUnit } : null;
  }
  const next = withBarMoved(state.bars, drag.id, point.unit);
  return validateBars(next).ok ? { unit: point.unit } : null;
}

// Where a new pair's closing brace goes: one division further along the clock
// from wherever the open landed. A repeat of one division is the common case
// and a small, obvious default, and both ends can then be dragged. Closing at
// the end of the score instead would let one stray drop restructure how the
// whole piece plays.
function closeFor(unit) {
  return unit + beatsPerBox() * TIME_UNITS_PER_BEAT;
}

// ---- the two-click tool --------------------------------------------------
//
// Armed from the palette, exactly like Break: state.tool says which tool owns
// clicks on the staff, so the two cannot both be listening, and the note
// inspector keeps the staff to itself whenever neither is armed.
//
// The first click is remembered rather than written - `pending` is not in
// state.bars, so nothing is added to the score until the pair is complete. An
// open brace with no close draws perfectly and plays nothing, which is the one
// outcome worth ruling out entirely.

let pending = null;   // { unit, count } - where the first click put the open
let pendLine = null;  // the line on the sheet showing it

function isRepeatTool() { return state.tool === 'repeat'; }

// What the tool is waiting for, which is what the palette glyph shows: the
// left half of the brace while the start is still to be picked, the right half
// once it has been.
export function repeatToolState() {
  return {
    on: isRepeatTool(),
    count: clampCount(state.repeatCount),
    kind: pending ? 'close' : 'open',
  };
}

function announce() {
  document.dispatchEvent(new CustomEvent('repeat:armed', { detail: repeatToolState() }));
}

export function setRepeatTool(on, count = 2) {
  pending = null;
  refreshPending();
  state.tool = on ? 'repeat' : null;
  state.repeatCount = on ? clampCount(count) : null;
  document.body.classList.toggle('repeat-mode', !!on);
  // Arming one layout tool disarms the other; each one's own listener on
  // tool:changed is what takes its mode off the body, so neither module has to
  // import the other.
  document.dispatchEvent(new CustomEvent('tool:changed', { detail: state.tool }));
  announce();
}

function clampCount(c) { return Math.max(2, Math.min(4, Number(c) || 2)); }

// One line element, hidden rather than destroyed: a refusal shows it red at a
// point that is NOT the pending one, and reusing the same element is what lets
// that flash fall back to whatever the tool is actually holding.
function lineAt(unit, bad) {
  const { rows, placed } = rowRects();
  const pos = unitPos(rows, unit, false);
  const host = pos ? placed.find(p => p.row === pos.row) : null;
  if (!pendLine) {
    pendLine = document.createElement('div');
    pendLine.className = 'rep-drop pend';
    document.body.appendChild(pendLine);
  }
  if (!pos || !host) { pendLine.style.display = 'none'; return; }
  pendLine.style.display = 'block';
  pendLine.style.left = `${host.rect.left + (LPAD + pos.x) * host.k}px`;
  pendLine.style.top = `${host.rect.top}px`;
  pendLine.style.height = `${host.rect.height}px`;
  pendLine.classList.toggle('bad', !!bad);
}

// Where the pending open is on screen, worked out from its point on the clock
// rather than from where the pointer was - so the line stays on its note when
// the sheet re-renders, scrolls or re-flows between the two clicks.
function refreshPending() {
  if (!pending) {
    if (pendLine) pendLine.style.display = 'none';
    return;
  }
  lineAt(pending.unit, false);
}

function setPending(p) {
  pending = p;
  refreshPending();
  announce();
}

function cancelPending() {
  if (!pending) return;
  pending = null;
  refreshPending();
  announce();
}

// This click cannot be taken: the pair it would make nests inside one that is
// already there, and playback expands one flat pair at a time. Show it red
// where it was aimed, then go back to whatever the tool was holding - so a
// refused start leaves the tool empty and a refused end leaves the start up,
// ready for another try.
function refuse(unit) {
  lineAt(unit, true);
  setTimeout(refreshPending, 400);
}

// Would a pair between these two points still read? A start is tested against
// itself - a zero-length pair at that point - which is exactly the question
// "is this inside a repeat already", since any close after it would then be
// the second one open at once.
function wouldRead(openUnit, closeUnit, count) {
  return validateBars(withPairAdded(state.bars, openUnit, closeUnit, count)).ok;
}

function toolClick(e) {
  const geometry = rowRects();
  if (!geometry.placed.length) return;
  const count = pending ? pending.count : clampCount(state.repeatCount);
  if (!pending) {
    const point = pointAt(geometry, e.clientX, e.clientY, false);
    if (!point) return;
    if (!wouldRead(point.unit, point.unit, count)) { refuse(point.unit); return; }
    setPending({ unit: point.unit, count });
    return;
  }
  const point = pointAt(geometry, e.clientX, e.clientY, true);
  if (!point) return;
  // A second click at or before the start is not a loop of nothing - it is the
  // start being put somewhere else. Resolved again as an OPEN, since that is
  // what it now is: the two ends take opposite edges of the glyph they sit on.
  if (point.unit <= pending.unit) {
    const back = pointAt(geometry, e.clientX, e.clientY, false);
    if (back) setPending({ unit: back.unit, count });
    return;
  }
  if (!wouldRead(pending.unit, point.unit, count)) { refuse(point.unit); return; }
  const openUnit = pending.unit;
  pending = null;
  refreshPending();
  addRepeatPair(openUnit, point.unit, count);
  // Still armed, waiting for the next pair's start - marking several repeats
  // in a row is the common case, and Escape or the palette glyph puts it away.
  announce();
}

// ---- the gesture ---------------------------------------------------------

function beginDrag(spec, e) {
  drag = { ...spec, startX: e.clientX, startY: e.clientY, moved: false, target: null };
  drag.geometry = rowRects();
  document.body.classList.add('rep-dragging');
  ghost = makeGhost(spec.art);
  marker = makeMarker();
  moveDrag(e);
}

function moveDrag(e) {
  if (!drag) return;
  if (!drag.moved
      && Math.abs(e.clientX - drag.startX) < CLICK_SLOP
      && Math.abs(e.clientY - drag.startY) < CLICK_SLOP) return;
  drag.moved = true;

  ghost.style.display = 'block';
  ghost.style.left = `${e.clientX}px`;
  ghost.style.top = `${e.clientY}px`;

  // Over the sheet the mark follows the pointer freely; away from it the drag
  // is a discard, and the drop line goes away to say so.
  const point = overSheet(e)
    ? pointAt(drag.geometry, e.clientX, e.clientY, drag.closing) : null;
  const ok = candidate(point);
  drag.target = ok ? point : null;
  drag.plan = ok;

  if (!point) { marker.style.display = 'none'; return; }
  marker.style.display = 'block';
  marker.style.left = `${point.x}px`;
  marker.style.top = `${point.top}px`;
  marker.style.height = `${point.bottom - point.top}px`;
  marker.classList.toggle('bad', !ok);
  ghost.classList.toggle('bad', !ok);
}

function endDrag(e) {
  if (!drag) return;
  const d = drag;
  drag = null;
  clearFloating();

  if (!d.moved) { handleClick(d, e); return; }

  // Released away from the sheet, or somewhere the result would not read. For
  // a mark already on the staff, being let go off the sheet is the delete
  // gesture — drag it away and it is gone, which is the other half of "drag it
  // where you want it". A new pair that never reached the staff is simply not
  // created.
  if (!d.target || !d.plan) {
    if (d.kind === 'move' && overSheet(e) === false) removeBar(d.id);
    return;
  }

  if (d.kind === 'new') addRepeatPair(d.plan.openUnit, d.plan.closeUnit, d.count);
  else moveBar(d.id, d.plan.unit);
}

// Was the pointer let go anywhere over the sheet? Dropping a brace on a part
// of the staff that is not an edge should do nothing, but dropping it in the
// margin — off the page, on the sidebar — means "take this away".
function overSheet(e) {
  const sheet = document.querySelector('.sheet') || score();
  if (!sheet) return true;
  const r = sheet.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right
    && e.clientY >= r.top && e.clientY <= r.bottom;
}

// A press that never moved. On a brace: select it, or cycle its count if it
// was already selected. From the palette: nothing — the palette's own click
// listener still appends a mark at the end of the score, which is the path
// that works without a pointer drag.
function handleClick(d, e) {
  if (d.kind !== 'move') return;
  if (state.selBar === d.id) {
    setBarCount(d.id, (Number(d.count) || 2) >= 4 ? 2 : (Number(d.count) || 2) + 1);
    return;
  }
  select(d.id);
  e.stopPropagation();
}

// ---- selection -----------------------------------------------------------

export function select(id) {
  state.selBar = id || null;
  paint();
}

export function clearSelection() {
  if (state.selBar == null) return false;
  state.selBar = null;
  paint();
  return true;
}

// Remove whatever is selected. Exported for keyboard.js, which must know
// whether the key was used here before it deletes a NOTE instead.
export function deleteSelectedBar() {
  if (state.selBar == null) return false;
  return removeBar(state.selBar);
}

// Light the selected mark, its ✕ and its span — all by class, with no
// re-render. render() costs 13 ms at 400 notes, which is far too much to spend
// on a selection change and unthinkable on a mouseover.
function paint(hoverId = null) {
  const root = score();
  if (!root) return;
  const lit = new Set([state.selBar, hoverId].filter(Boolean));
  const pairOf = new Map();
  repeatPairs(state.bars).forEach(p => {
    pairOf.set(p.openId, p.openId);
    pairOf.set(p.closeId, p.openId);
  });
  root.querySelectorAll('.repmark').forEach(g => {
    const id = g.dataset.bar;
    g.classList.toggle('sel', state.selBar === id);
    g.classList.toggle('hot', lit.has(id));
  });
  root.querySelectorAll('.repx').forEach(x => {
    x.classList.toggle('on', lit.has(x.dataset.bar));
  });
  const litPairs = new Set([...lit].map(id => pairOf.get(id)).filter(Boolean));
  root.querySelectorAll('.repspan').forEach(r => {
    r.classList.toggle('on', litPairs.has(r.dataset.pair));
  });
}

// ---- wiring --------------------------------------------------------------

// The artwork a ghost shows: the brace being dragged, asked for from the same
// function that draws it on the staff, so there is no second copy of the mark
// here. It used to be CLONED out of whatever was pressed, which worked while
// the staff's marks were nested <svg> elements wrapping an <image>; they are
// bare paths now, and a clone of them came back empty — a drag with no ghost.
//
// Drawn in the staff's own ink rather than currentColor: the ghost is fixed to
// the pointer and spends the whole drag over white paper, so inheriting the
// dark chrome's light text colour would make it invisible exactly where it
// has to be read.
function ghostArt(kind, count) {
  return repeatGlyphSVG(kind, count, 26, 34, '', STAFF.noteInk);
}

export function installRepeatTool() {
  const root = score();
  if (!root) return;

  // The armed tool's click, taken in the capture phase so the note inspector
  // underneath does not also react to it. A click on a brace or its X is still
  // that brace's own - the marks stay draggable and deletable while the tool
  // is up.
  root.addEventListener('click', e => {
    if (!isRepeatTool()) return;
    if (e.target.closest('.repmark') || e.target.closest('.repx')) return;
    e.stopPropagation();
    toolClick(e);
  }, true);

  // --- from the staff ---
  root.addEventListener('pointerdown', e => {
    // The Break tool owns clicks on the staff while it is armed.
    if (state.tool === 'break') return;
    const mark = e.target.closest('.repmark');
    if (!mark) return;
    e.preventDefault();
    e.stopPropagation();
    beginDrag({
      kind: 'move',
      id: mark.dataset.bar,
      count: Number(mark.dataset.count) || 2,
      closing: mark.dataset.kind === 'close',
      art: ghostArt(mark.dataset.kind, Number(mark.dataset.count) || 2),
    }, e);
  });

  // Hovering a brace lights it, its ✕ and the stretch it repeats.
  root.addEventListener('pointerover', e => {
    const mark = e.target.closest('.repmark');
    if (mark) paint(mark.dataset.bar);
  });
  root.addEventListener('pointerout', e => {
    if (e.target.closest('.repmark')) paint(null);
  });

  // The ✕ beside a mark. It is HTML over the row, so it is not part of the
  // staff's own event handling.
  root.addEventListener('click', e => {
    const x = e.target.closest('.repx');
    if (!x) return;
    e.stopPropagation();
    removeBar(x.dataset.bar);
  });

  // Clicking anywhere else on the sheet drops the selection, the same way
  // clicking off a menu closes it.
  root.addEventListener('click', e => {
    if (e.target.closest('.repmark') || e.target.closest('.repx')) return;
    clearSelection();
  });

  // --- from the palette ---
  {
    const host = document.getElementById('repeatGrid');
    host.addEventListener('pointerdown', e => {
      const el = e.target.closest('[data-rcount]');
      if (!el) return;
      const count = Number(el.dataset.rcount) || 2;
      // Dragging always makes a PAIR, whichever half the palette glyph is
      // showing: the glyph's open/close toggle belongs to the click path,
      // where the two ends are placed one at a time.
      beginDrag({ kind: 'new', count, closing: false, art: ghostArt('open', count) }, e);
    });
  }

  // One set of move/up listeners for both sources, on the window, so a drag
  // that leaves the sheet — which is how a mark is thrown away — still ends.
  window.addEventListener('pointermove', moveDrag);
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', () => { drag = null; clearFloating(); });

  // Esc backs out one step at a time: the half-placed pair first, then the
  // tool, then the selection. The marks themselves stay where they are.
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (pending) { cancelPending(); return; }
    if (isRepeatTool()) { setRepeatTool(false); return; }
    clearSelection();
  });

  // Another tool taking the staff cancels a half-placed pair - leaving the
  // line up over a sheet that is no longer listening would be a lie.
  document.addEventListener('tool:changed', () => {
    if (isRepeatTool()) return;
    document.body.classList.remove('repeat-mode');
    cancelPending();
  });

  // A re-render replaces every element on the sheet, so the lit classes have
  // to go back on afterwards, and the pending line has to be measured again
  // against rows that may have re-flowed under it.
  document.addEventListener('score:rendered', () => { paint(); refreshPending(); });
  window.addEventListener('resize', refreshPending);
  window.addEventListener('scroll', refreshPending, true);
}
