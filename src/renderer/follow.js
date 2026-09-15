// Keeping the sounding row on screen.
//
// A long score is taller than the window, so playback walks off the bottom and
// the player is left watching a staff that stopped moving. This module holds
// the row being played at the middle of the stage, and gets out of the way the
// moment the user scrolls for themselves.
//
// THE SCROLL CONTAINER IS `.stage`, NOT `#sheetwrap`. `.sheetwrap` carries the
// zoom (`transform: scale()`) and has no overflow at all, so its `scrollTop` is
// permanently 0 and assigning to it is a silent no-op — which is exactly the
// bug `scrollToLatest()` in midi-input.js shipped with. Nothing throws, nothing
// moves, and there is no error to go looking for. Scroll the stage.
//
// The target is the ROW, never the glyph. `render()` rebuilds every glyph on
// each beat of a held note, so a target recomputed from the active glyph's x
// would re-aim continuously and read as a vibration — the same trap the note in
// CLAUDE.md warns about for transforms on `[data-active="1"]`. Aiming at the
// row means the target only changes when playback crosses into a new row: the
// sheet steps once per row and is perfectly still in between.
//
// Rows are compared by their `data-row` ordinal rather than by element
// identity, because `render()` writes fresh markup every time — the element
// under the highlight is a different object on every beat even when the music
// has not moved an inch.

import { state } from './state.js';

// How long a smooth scroll is given to finish before scroll events are read as
// the user's own. Chromium settles a row-sized jump in ~300-500ms; the margin
// is there so the tail of our own animation is never mistaken for a manual
// scroll and made to yield.
const SETTLE_MS = 900;

// True once the user has scrolled during this playthrough. Module-local rather
// than in `state`, the same way repeats.js keeps its half-placed brace local:
// it is not score data, it does not belong in a snapshot, and it must not
// travel into a saved file.
let yielded = false;

// `data-row` of the row we last scrolled to, so an unchanged row costs nothing.
let lastRow = null;

// While `now()` is under this, a scroll event is assumed to be our own.
let pendingUntil = 0;

let wired = false;

function now() {
  return (globalThis.performance || Date).now();
}

function stageEl() {
  return document.querySelector('.stage');
}

// How far the stage must scroll to bring `rowBox` to its middle. Both rects
// come from getBoundingClientRect(), so they are already in viewport space with
// the zoom transform baked in — which is why nothing here multiplies by
// state.zoom. Pure, so tests/follow.test.mjs can drive it without a DOM.
export function centreDelta(stageBox, rowBox) {
  return (rowBox.top + rowBox.height / 2) - (stageBox.top + stageBox.height / 2);
}

// Any of these means the human took over. They are read instead of the `scroll`
// event because our own smooth scroll fires `scroll` too, many times, and the
// two are indistinguishable once they overlap — whereas a wheel or a drag is
// unambiguously somebody's hand, even mid-animation.
function onUserScroll() {
  if (state.playing) yielded = true;
}

// The scrollbar and the arrow keys produce no wheel event, so `scroll` is read
// as well — but only outside the window in which our own animation is still
// running, or every programmatic scroll would immediately yield to itself.
function onScroll() {
  if (state.playing && now() >= pendingUntil) yielded = true;
}

function wire() {
  if (wired || typeof document === 'undefined') return;
  const stage = stageEl();
  if (!stage) return;
  // Passive: none of these are cancelled, and saying so keeps the wheel off the
  // main thread's critical path during playback.
  stage.addEventListener('wheel', onUserScroll, { passive: true });
  stage.addEventListener('touchmove', onUserScroll, { passive: true });
  stage.addEventListener('scroll', onScroll, { passive: true });
  wired = true;
}

// Called when the transport starts. A new playthrough always follows again —
// yielding lasts for the run it happened in, not forever, so Play is the one
// gesture that gives control back and there is no state to explain.
export function beginFollow() {
  wire();
  yielded = false;
  lastRow = null;
  pendingUntil = 0;
}

export function endFollow() {
  yielded = false;
  lastRow = null;
}

// Bring the row carrying the sounding glyph to the middle of the stage. Called
// from the playback pump straight after render(), and cheap on the beats where
// the row has not changed.
//
// The measuring and the scrolling happen inside a rAF for two reasons: render()
// has just rewritten the markup, so layout is dirty and the rects would force a
// synchronous reflow; and the pump shares its thread with audio scheduling,
// where CLAUDE.md is emphatic about what a stalled frame costs.
export function followPlayhead() {
  // Both are checked, not just `document`: tests/metronome.test.mjs drives the
  // real startPlay() under plain Node against a stubbed document, so a module
  // reached from the pump cannot assume that a document implies a frame loop.
  if (typeof document === 'undefined' || typeof requestAnimationFrame !== 'function') return;
  if (!state.playing || yielded) return;
  requestAnimationFrame(() => {
    // Re-checked inside the frame: playback can stop, or the user can grab the
    // scrollbar, between scheduling this and running it.
    if (!state.playing || yielded) return;
    const stage = stageEl();
    const active = document.querySelector('#score [data-active="1"]');
    const row = active && active.closest('.srow');
    if (!stage || !row) return;

    const ord = row.dataset.row;
    if (ord === lastRow) return;
    lastRow = ord;

    const delta = centreDelta(stage.getBoundingClientRect(), row.getBoundingClientRect());
    // Sub-pixel deltas are the row already being centred; scrolling for them
    // would restart the animation on every row-change check for nothing.
    if (Math.abs(delta) < 1) return;

    // The browser clamps at both ends of the range, so the first and last rows
    // simply sit as near the middle as the scroll allows. That is right: there
    // is no room above row one to centre it into, and inventing some by padding
    // the stage would put a permanent gap above the sheet.
    pendingUntil = now() + SETTLE_MS;
    stage.scrollTo({ top: stage.scrollTop + delta, behavior: 'smooth' });
  });
}
