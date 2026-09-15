// The Break tool. Arm it in the sidebar, click a division on the sheet, and
// that division — with everything after it — moves down to a new row, leaving
// the row above to spread out over the space it gave up.
//
// A break is LAYOUT, not music: nothing is added to state.notes, the timing is
// untouched, and playback, MIDI and MusicXML never see it. It is stored in
// state.breaks as the ordinal of the division it falls before (see the box
// ordinals in scoreRows()), so it survives editing earlier in the score and
// re-renders in the same place.
//
// A break can also be MOVED, not only made and unmade, and the one the user
// touched last is marked out from the others — on the paper and in words —
// because three cases otherwise leave somebody unsure a break happened at all:
// one placed where the row would have broken anyway moves nothing visible, one
// out past the written music has no division to draw against, and a margin of
// identical ↵ badges says nothing about which is current. `state.lastBreak`
// holds that pointer; every mark and every readout below is drawn from it.

import { state } from './state.js';
import { pushHist } from './history.js';
import { render } from './notation.js';

// How long a run of arrow-key nudges collapses into ONE undo entry. Pressing
// → ten times to shuffle a line is one action to the person doing it, and one
// history entry per keystroke would flush the 120-deep stack (MAX_HIST) of
// everything else they had done.
const RUN_MS = 900;
// How long the on-paper mark stays lit after a break is placed or moved while
// some other tool is armed — long enough to take the eye there, short enough
// not to sit on the page as if it were notation.
const FLASH_MS = 1600;
// A press that moves less than this is a click, not a drag, so the badge's
// click-to-remove survives having become draggable.
const CLICK_SLOP = 4;

let runOpen = false;      // a nudge run is collecting into one undo entry
let runTimer = 0;
let flashTimer = 0;
let drag = null;          // { ord, startX, startY, moved, target }
let ghost = null;

export function isBreakTool() { return state.tool === 'break'; }

// Arming the tool puts the sheet in break mode: the per-division hit areas in
// each row become clickable (they are inert otherwise, so the note inspector
// keeps the staff to itself in every other mode).
export function setBreakTool(on) {
  state.tool = on ? 'break' : null;
  document.body.classList.toggle('break-mode', !!on);
  endRun();
  document.dispatchEvent(new CustomEvent('tool:changed', { detail: state.tool }));
}

// Only one tool owns clicks on the staff, so arming the other one disarms
// this. Each tool takes its own mode off the body when state.tool moves away
// from it, which is why neither module has to import the other.

// ---- where the last break is ---------------------------------------------

// Light the on-paper mark for a moment. While the Break tool is armed the mark
// is up anyway (the CSS keys it off body.break-mode), so this is for the case
// that matters: a break moved or placed from some other mode, where nothing
// would otherwise tell the eye where it landed.
function flash() {
  const b = document.body;
  b.classList.add('brk-flash');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => b.classList.remove('brk-flash'), FLASH_MS);
}

function setLast(ord) {
  state.lastBreak = ord == null ? null : Number(ord);
}

// ---- the arithmetic ------------------------------------------------------

// Where a break at `from` goes when nudged one division in `dir`, or null if
// the move is refused. Pure — no DOM, no state — so tests/breaks.test.mjs can
// drive the rules directly:
//
//   * ordinal 0 has no row above it to break away from, so 1 is the floor;
//   * a division that already breaks refuses the move rather than swallowing
//     the break that was there — two breaks silently becoming one loses work
//     the user did earlier;
//   * `max` is one division past the end of the score, so a break can be
//     pushed out past the written music (which is legal, and said so on the
//     sheet) without being able to run away to an ordinal nothing reaches.
export function nextBreakOrdinal(breaks, from, dir, max = Infinity) {
  const at = Number(from);
  const step = dir < 0 ? -1 : 1;
  if (!Number.isFinite(at)) return null;
  const to = at + step;
  if (to < 1 || to > max) return null;
  if ((breaks || []).some(b => Number(b) === to)) return null;
  return to;
}

// The last ordinal the sheet is currently drawing, read off the rendered rows.
// The layout has just been laid out; asking scoreRows() again would be a
// second pass over the whole score for a number the DOM is already holding.
function lastOrdinal() {
  let max = -1;
  document.querySelectorAll('#score .boxhit').forEach(r => {
    const n = Number(r.dataset.ord);
    if (Number.isFinite(n) && n > max) max = n;
  });
  return max;
}

// ---- placing, removing, moving -------------------------------------------

// Clicking a division that already breaks removes the break, so the same
// gesture puts the music back the way it was.
export function toggleBreakAt(ord) {
  const at = Number(ord);
  // Ordinal 0 is the first division of the score — there is no row above it
  // to break away from.
  if (!Number.isFinite(at) || at <= 0) return;
  pushHist();
  endRun();
  if (!Array.isArray(state.breaks)) state.breaks = [];
  const i = state.breaks.indexOf(at);
  if (i >= 0) {
    state.breaks.splice(i, 1);
    // The pointer would name a break that no longer exists; render() clears it
    // anyway, but leaving it set marks a division for no reason.
    if (state.lastBreak === at) setLast(null);
  } else {
    state.breaks.push(at);
    setLast(at);
    flash();
  }
  state.breaks.sort((a, b) => a - b);
  render();
}

// The ONE way a break moves. Both gestures — the arrow keys and dragging the
// badge — come through here, so a nudged break and a dragged break cannot land
// by different rules. Returns whether the move happened.
export function moveBreak(from, to, { hist = true } = {}) {
  const at = Number(from);
  const dest = Number(to);
  if (!Number.isFinite(at) || !Number.isFinite(dest) || dest === at) return false;
  if (dest < 1) return false;
  if (!Array.isArray(state.breaks)) state.breaks = [];
  const list = state.breaks;
  const i = list.indexOf(at);
  if (i < 0) return false;
  if (list.includes(dest)) return false;
  if (hist) pushHist();
  list.splice(i, 1);
  list.push(dest);
  list.sort((a, b) => a - b);
  setLast(dest);
  flash();
  render();
  return true;
}

// Make a break the current one without moving it: what a click on another
// row's badge does, and what the readout and the on-paper mark then follow.
// Not an edit — nothing about the score changes — so no history entry.
export function pickUp(ord) {
  const at = Number(ord);
  if (!(state.breaks || []).includes(at)) return;
  endRun();
  setLast(at);
  flash();
  render();
}

export function removeBreak(ord) {
  const at = Number(ord);
  const list = state.breaks || [];
  if (!list.includes(at)) return;
  pushHist();
  endRun();
  list.splice(list.indexOf(at), 1);
  if (state.lastBreak === at) setLast(null);
  render();
}

export function clearBreaks() {
  if (!state.breaks || !state.breaks.length) return;
  pushHist();
  endRun();
  state.breaks = [];
  setLast(null);
  render();
}

// ---- the nudge run -------------------------------------------------------

// One undo entry per RUN of arrow presses, not per press. The run is opened by
// the first nudge and closed by a pause, by the tool being put away, or by any
// other edit to the breaks — anything that means the next arrow press is a
// fresh thought rather than a continuation of the last one.
function openRun() {
  if (!runOpen) { pushHist(); runOpen = true; }
  clearTimeout(runTimer);
  runTimer = setTimeout(endRun, RUN_MS);
}

function endRun() {
  clearTimeout(runTimer);
  runOpen = false;
}

function nudge(dir) {
  if (state.lastBreak == null) return;
  const to = nextBreakOrdinal(state.breaks, state.lastBreak, dir, lastOrdinal() + 1);
  if (to == null) return;
  openRun();
  moveBreak(state.lastBreak, to, { hist: false });
}

// ---- the readout ---------------------------------------------------------

// Which row and division the last break is at, in words, because the marks on
// the paper cannot speak for a break that is off-screen or out past the end of
// the written music. Read off the rendered DOM rather than by laying the score
// out a second time.
function updateInfo() {
  const el = document.getElementById('brkInfo');
  if (!el) return;
  // The line belongs to the tool: it is a working readout, not part of the
  // sheet, and the filled badge already says which break is current at rest.
  if (!isBreakTool()) { el.innerHTML = ''; return; }

  if (state.lastBreak == null) {
    el.innerHTML = (state.breaks && state.breaks.length)
      ? 'Click a ↵ badge to pick up a break, or a division to make one.'
      : 'No breaks yet — click a division to start a new row there.';
    return;
  }

  const ord = state.lastBreak;
  const rect = document.querySelector(`#score .boxhit[data-ord="${ord}"]`);
  const row = rect && rect.closest('.srow');
  // A break out past the last division has no badge in the margin and no
  // division to drag it onto, so it is told the one thing that will reach it.
  const where = row
    ? `start of row ${Number(row.dataset.row) + 1} (division ${ord + 1})`
    : 'past the end of the score';
  const hint = row
    ? '←/→ to nudge it · drag the ↵ badge to move it'
    : '← to bring it back onto the staff';
  el.innerHTML = `Last break: <span class="where" title="Show it on the sheet">${where}</span>`
    + `<span class="hint">${hint}</span>`;
}

// Take the sheet to the break and light it. The mark is up already while the
// tool is armed, so the flash is for the scroll: something has to move for the
// eye to know the page went somewhere.
function reveal() {
  if (state.lastBreak == null) return;
  const rect = document.querySelector(`#score .boxhit[data-ord="${state.lastBreak}"]`);
  const row = rect ? rect.closest('.srow') : document.querySelector('.brkghost');
  if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  flash();
}

// ---- dragging the badge --------------------------------------------------

function beginDrag(ord, e) {
  drag = { ord: Number(ord), startX: e.clientX, startY: e.clientY, moved: false, target: null };
  ghost = document.createElement('div');
  ghost.className = 'brk-ghost';
  ghost.textContent = '↵';
  // Hidden until the pointer actually moves: a press that turns out to be a
  // click must not flash a badge across the screen on its way past.
  ghost.style.display = 'none';
  document.body.appendChild(ghost);
  document.body.classList.add('brk-dragging');
}

function paintTarget(el) {
  document.querySelectorAll('#score .boxhit.drop')
    .forEach(r => { if (r !== el) r.classList.remove('drop'); });
  if (el) el.classList.add('drop');
}

function moveDrag(e) {
  if (!drag) return;
  if (!drag.moved
      && Math.abs(e.clientX - drag.startX) < CLICK_SLOP
      && Math.abs(e.clientY - drag.startY) < CLICK_SLOP) return;
  drag.moved = true;

  ghost.style.display = 'grid';
  ghost.style.left = `${e.clientX}px`;
  ghost.style.top = `${e.clientY}px`;

  // The division under the pointer, if any. Off the sheet the drag is a
  // discard, and the badge turns red to say so before it is let go.
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const hit = under && under.closest ? under.closest('.boxhit') : null;
  const ord = hit ? Number(hit.dataset.ord) : null;
  // A drop that would not take is not a target: ordinal 0 has no row above it,
  // and a division that already breaks belongs to another break.
  const ok = !!hit && ord > 0
    && (ord === drag.ord || !(state.breaks || []).includes(ord));
  drag.target = ok ? ord : null;
  paintTarget(ok ? hit : null);
  ghost.classList.toggle('bad', !ok);
}

// A press on a badge that never travelled. Picking a break up rather than
// removing it outright is what makes every break reachable: the arrow keys
// move whichever one is current, so with no way to change which that is, only
// the newest could ever be nudged. The badge for the current break still
// removes it, which is what a badge has always done — each tooltip says which
// of the two its click will do.
function badgeClick(ord) {
  if (ord !== state.lastBreak) { pickUp(ord); return; }
  toggleBreakAt(ord);
}

// Was the pointer let go over the sheet at all? A drop on a part of the page
// that is not a division does nothing; a drop OFF the sheet is the discard,
// the other half of "drag it where you want it" — the same rule repeats.js
// throws a brace away by.
function overSheet(e) {
  const sheet = document.querySelector('.sheet');
  if (!sheet || !sheet.getBoundingClientRect) return true;
  const r = sheet.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right
    && e.clientY >= r.top && e.clientY <= r.bottom;
}

function endDrag(e) {
  if (!drag) return;
  const d = drag;
  drag = null;
  paintTarget(null);
  if (ghost) { ghost.remove(); ghost = null; }
  document.body.classList.remove('brk-dragging');
  // A press that never travelled CLICK_SLOP is a click. It is settled here
  // rather than by a click listener because preventDefault() on pointerdown —
  // which is what stops the badge being dragged as a text selection — is not
  // guaranteed to leave a click event behind.
  if (!d.moved) { badgeClick(d.ord); return; }

  endRun();
  if (d.target == null) {
    if (overSheet(e)) return;         // dropped on the page, but not on a division
    removeBreak(d.ord);
    return;
  }
  // Put back where it started: nothing to move, but it is still the break the
  // user is working on, so it stays marked.
  if (d.target === d.ord) { setLast(d.ord); flash(); render(); return; }
  moveBreak(d.ord, d.target);
}

function cancelDrag() {
  if (!drag) return;
  drag = null;
  paintTarget(null);
  if (ghost) { ghost.remove(); ghost = null; }
  document.body.classList.remove('brk-dragging');
}

// ---- wiring --------------------------------------------------------------

export function installBreakTool() {
  const score = document.getElementById('score');
  if (!score) return;

  // Capture phase: in break mode the click is the tool's, not the inspector's,
  // and stopping it here keeps the right-hand panel from also reacting.
  score.addEventListener('click', e => {
    // The chip that stands in for a break past the end of the score. The ↵
    // badges in the margin are settled by the drag instead (see endDrag), so
    // one press cannot be read as both a click and a drop.
    const chip = e.target.closest('.brkghost [data-brk]');
    if (chip) {
      e.stopPropagation();
      removeBreak(chip.dataset.brk);
      return;
    }
    if (!isBreakTool()) return;
    const hit = e.target.closest('.boxhit');
    if (!hit) return;
    e.stopPropagation();
    toggleBreakAt(hit.dataset.ord);
  }, true);

  // Any badge can be dragged, current or not — a drag that lands makes the
  // break it moved the current one. A press that does not travel CLICK_SLOP is
  // still a click, so the handler above keeps both of its meanings.
  score.addEventListener('pointerdown', e => {
    const mark = e.target.closest('.brkmark');
    if (!mark) return;
    e.preventDefault();
    e.stopPropagation();
    beginDrag(mark.dataset.brk, e);
  });

  // On the window, so a drag that leaves the sheet — which is how a break is
  // thrown away — still ends.
  window.addEventListener('pointermove', moveDrag);
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', cancelDrag);

  document.addEventListener('tool:changed', () => {
    document.body.classList.toggle('break-mode', isBreakTool());
    updateInfo();
  });

  // The readout is drawn from the rendered rows, so it is rebuilt with them.
  document.addEventListener('score:rendered', updateInfo);

  const info = document.getElementById('brkInfo');
  if (info) info.addEventListener('click', e => {
    if (e.target.closest('.where')) reveal();
  });

  document.addEventListener('keydown', e => {
    // Escape disarms, the same way it dismisses a popover.
    if (e.key === 'Escape' && isBreakTool()) { setBreakTool(false); return; }
    if (!isBreakTool() || state.lastBreak == null) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    // Not while somebody is typing in the tempo or title field — there the
    // arrows belong to the caret.
    const t = e.target;
    if (t && (t.isContentEditable
      || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) return;
    e.preventDefault();
    nudge(e.key === 'ArrowLeft' ? -1 : 1);
  });

  updateInfo();
}
