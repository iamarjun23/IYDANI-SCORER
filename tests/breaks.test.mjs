// Manual line breaks: where the last one is, and moving it.
//
// A break used to be made and unmade and nothing else, so nothing had to know
// WHICH break the user was working on. Now one of them is current — marked on
// the sheet, named in the sidebar, and the one the arrow keys move — so the
// rules that keep that pointer honest are what this drives:
//
//   · ordinal 0 has no row above it, so 1 is the floor a nudge stops at
//   · a division that already breaks refuses the move rather than swallowing
//     the break that was there
//   · the pointer follows a break through a move, and is dropped the moment it
//     names a break that no longer exists — which is what makes undo, load and
//     clearAll() safe without any of them knowing about it
//   · undo puts the pointer back with the break it names
//
// render() is real here, not stubbed: it is the one funnel the pointer is
// validated in, so stubbing it would test nothing. The DOM under it is a proxy
// that swallows every call, the same way tests/metro-entry.test.mjs does it.

const el = new Proxy(function () {}, {
  get: (t, k) => (k === 'length' ? 0 : k === Symbol.toPrimitive ? () => '' : el),
  set: () => true,
  apply: () => el,
});
// #score keeps what render() writes into it, so the marks that say WHERE the
// break is can be read back off the markup. Everything else swallows.
let html = '';
const scoreEl = new Proxy(function () {}, {
  get: (t, k) => {
    if (k === 'insertAdjacentHTML') return (pos, s) => { html += s; };
    if (k === 'innerHTML') return html;
    return el;
  },
  set: (t, k, v) => { if (k === 'innerHTML') html = v; return true; },
  apply: () => el,
});
globalThis.document = new Proxy({}, {
  get: (t, k) => (k === 'getElementById'
    ? (id => (id === 'score' ? scoreEl : el)) : el),
  set: () => true,
});
// The on-paper mark is lit for a second and a half after a move. With a real
// timer that keeps the run alive long after the last assertion.
globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};

const assert = (await import('node:assert/strict')).default;
const { state } = await import('../src/renderer/state.js');
const { undo } = await import('../src/renderer/history.js');
const {
  nextBreakOrdinal, toggleBreakAt, moveBreak, pickUp, removeBreak, clearBreaks,
} = await import('../src/renderer/breaks.js');

let checks = 0;
const is = (a, b, m) => { checks++; assert.equal(a, b, m); };
const eq = (a, b, m) => { checks++; assert.deepEqual(a, b, m); };
const ok = (c, m) => { checks++; assert.ok(c, m); };

function fresh(breaks = []) {
  state.notes = [];
  state.bars = [];
  state.breaks = [...breaks];
  state.lastBreak = null;
  state.hist = [];
  state.future = [];
}

// ---- the arithmetic, pure --------------------------------------------------

is(nextBreakOrdinal([4], 4, 1), 5, 'one division later');
is(nextBreakOrdinal([4], 4, -1), 3, 'one division earlier');
is(nextBreakOrdinal([1], 1, -1), null, 'ordinal 0 has no row above it to break from');
is(nextBreakOrdinal([2], 2, -1), 1, '...so 1 is as far left as a nudge goes');
is(nextBreakOrdinal([4, 5], 4, 1), null, 'a division that already breaks refuses the move');
is(nextBreakOrdinal([4, 5], 5, -1), null, '...from either side');
is(nextBreakOrdinal([4, 6], 4, 1), 5, 'the gap between two breaks is still reachable');
is(nextBreakOrdinal([8], 8, 1, 8), null, 'a break cannot run away past the end of the score');
is(nextBreakOrdinal([7], 7, 1, 8), 8, '...but one division past the last is allowed');
is(nextBreakOrdinal([], undefined, 1), null, 'no break, no move');
is(nextBreakOrdinal(null, 4, 1), 5, 'a score with no breaks list at all still nudges');

// ---- placing sets the pointer ---------------------------------------------

fresh();
toggleBreakAt(5);
eq(state.breaks, [5], 'the break is stored');
is(state.lastBreak, 5, 'and is the one being worked on');

toggleBreakAt(9);
eq(state.breaks, [5, 9], 'breaks stay sorted');
is(state.lastBreak, 9, 'the newest is current');

toggleBreakAt(9);
eq(state.breaks, [5], 'clicking the current badge removes it');
is(state.lastBreak, null, 'and leaves nothing current');

fresh();
toggleBreakAt(0);
eq(state.breaks, [], 'ordinal 0 is refused — there is no row above the first division');
is(state.lastBreak, null, 'a refused break sets no pointer');

// ---- moving ----------------------------------------------------------------

fresh([4, 9]);
ok(moveBreak(4, 6), 'a break moves to a free division');
eq(state.breaks, [6, 9], 'it left the old ordinal and took the new one');
is(state.lastBreak, 6, 'the pointer follows the break it moved');

is(moveBreak(6, 9), false, 'a move onto an occupied division is refused');
eq(state.breaks, [6, 9], 'and nothing is swallowed');
is(moveBreak(6, 0), false, 'a move onto ordinal 0 is refused');
is(moveBreak(7, 8), false, 'moving a break that is not there does nothing');
eq(state.breaks, [6, 9], 'still both breaks, still in place');

// ---- picking one up --------------------------------------------------------

fresh([4, 9]);
toggleBreakAt(12);                       // 12 is current
is(state.lastBreak, 12, 'the new break is current');
const histBefore = state.hist.length;
pickUp(4);
is(state.lastBreak, 4, 'clicking another badge picks that break up');
eq(state.breaks, [4, 9, 12], 'picking one up changes nothing about the score');
is(state.hist.length, histBefore, '...so it is not an undoable edit');
pickUp(7);
is(state.lastBreak, 4, 'a division with no break on it cannot be picked up');

// ---- the pointer cannot outlive its break ----------------------------------

const { render } = await import('../src/renderer/notation.js');

fresh([4]);
state.lastBreak = 4;
state.breaks = [];                       // as a load or a preset would leave it
render();
is(state.lastBreak, null, 'render drops a pointer that names no break');

fresh([4, 9]);
state.lastBreak = 9;
removeBreak(9);
is(state.lastBreak, null, 'removing the current break clears the pointer');
eq(state.breaks, [4], 'and leaves the other one alone');
pickUp(4);
clearBreaks();
eq(state.breaks, [], 'clearing takes them all');
is(state.lastBreak, null, '...and the pointer with them');

// ---- undo carries the pointer ---------------------------------------------

fresh();
toggleBreakAt(5);
moveBreak(5, 8);
is(state.lastBreak, 8, 'moved to 8');
undo();
eq(state.breaks, [5], 'undo puts the break back');
is(state.lastBreak, 5, '...and the pointer with it, so the sheet marks where it went');

undo();
eq(state.breaks, [], 'undo again takes the break away');
is(state.lastBreak, null, 'leaving nothing marked');

// ---- what the sheet actually draws ----------------------------------------
// The badge in the margin says the break is HERE, at the end of this line. The
// wash and the cut line on the staff say where the next line starts. Both of
// the latter ride on elements rowSVG() writes only for the screen, which is
// what keeps an editing mark out of every export — so the export path is
// checked for their absence, not just the screen path for their presence.

const { scoreRows, rowSVG } = await import('../src/renderer/notation.js');

const bindu = () => ({ type: 'note', svaraIndex: 0, oct: 0, head: 'o', sym: 'bindu', dur: 1 });
const count = (s, re) => (s.match(re) || []).length;

fresh([5, 9]);
state.notes = Array.from({ length: 48 }, bindu);   // 12 divisions of four beats
state.lastBreak = 5;

const rows = scoreRows();
const screenSVG = rows.map(r => rowSVG(r, null, null, true)).join('');
const exportSVG = rows.map(r => rowSVG(r, null, null, false)).join('');

is(count(screenSVG, /class="brkend last"/g), 1, 'the row that ends in the break draws the bracket');
is(count(exportSVG, /brkend/g), 0, '...and it never reaches an export');
is(count(screenSVG, /class="boxhit lastbrk"/g), 1, 'one division is marked as the break');
ok(/class="boxhit lastbrk" data-ord="5"/.test(screenSVG), '...and it is the one the break falls before');
is(count(screenSVG, /class="brkline"/g), 1, 'the cut itself is drawn once');
is(count(exportSVG, /lastbrk|brkline/g), 0, 'neither reaches an export');
is(count(exportSVG, /boxhit/g), 0, '...along with the hit areas they ride on');

render();
is(count(html, /class="brkmark last"/g), 1, 'exactly one badge is drawn as the current break');
ok(/class="brkmark last" data-brk="5"/.test(html), '...and it is the badge for that break');
is(count(html, /class="brkmark"/g), 1, 'the other break keeps a plain badge');
is(count(html, /brkghost/g), 0, 'a break the staff can draw needs no chip under it');

// A break out past the written music has no division to draw against. It is
// kept — deleting a bar is no reason to throw away where a line was asked to
// end — so it has to be SAID, or it is a break nobody can see or reach.
fresh([300]);
state.notes = Array.from({ length: 48 }, bindu);
state.lastBreak = 300;
render();
is(count(html, /class="brkmark last"/g), 0, 'no row can carry its badge');
is(count(html, /brkghost/g), 1, 'so a chip under the staff stands in for it');
ok(/past the end of the score/.test(html), '...and says why it cannot be seen');
ok(/data-brk="300"/.test(html), '...while still being the break it names');

console.log(`breaks: ${checks} checks passed`);
