// Following the sounding row down a long score.
//
// The scrolling itself is browser geometry and not worth faking, but the sum
// that aims it is pure and is exactly where an off-by-a-half-height would hide:
// centring is the one place where using a rect's `top` in place of its middle
// still looks plausible and puts every row wrong by half the stage. So
// centreDelta() is driven directly, at the cases that have a right answer you
// can state without re-deriving the formula.
//
// The rects here are what getBoundingClientRect() returns — viewport space,
// with the zoom transform already applied — which is the whole reason nothing
// in follow.js multiplies by state.zoom. A zoomed row arrives as a taller rect
// and needs no separate handling, and that is asserted rather than assumed.

import { centreDelta } from '../src/renderer/follow.js';

let checks = 0;
function eq(got, want, what) {
  const ok = Math.abs(got - want) < 1e-9;
  if (!ok) {
    console.error(`FAIL ${what}: got ${got}, want ${want}`);
    process.exit(1);
  }
  checks += 1;
}

// A stage 600 tall starting 100 down the viewport: its middle is at y=400.
const stage = { top: 100, height: 600 };

// A row already straddling that middle needs no scroll at all. This is the
// case that fires on most beats, and returning non-zero here would restart the
// smooth scroll on every row check.
eq(centreDelta(stage, { top: 350, height: 100 }), 0, 'row already centred');

// A row below the middle scrolls the stage DOWN — a positive delta, added to
// scrollTop. Getting this sign backwards would walk the sheet away from the
// music, which is the failure the whole feature exists to prevent.
eq(centreDelta(stage, { top: 550, height: 100 }), 200, 'row below centre scrolls down');

// A row above the middle scrolls back UP. Reachable in ordinary use: a repeat
// jumps playback to an earlier row.
eq(centreDelta(stage, { top: 150, height: 100 }), -200, 'row above centre scrolls up');

// Height is read from BOTH rects, not just the row's. A row is centred against
// the stage's middle, so a stage of a different height moves the target.
eq(centreDelta({ top: 100, height: 400 }, { top: 350, height: 100 }), 100,
  'shorter stage re-aims the target');

// A tall row — a full mandra octave grows the row past the staff range — is
// centred by its own middle, not by its top edge.
eq(centreDelta(stage, { top: 300, height: 200 }), 0, 'tall row centred by its middle');

// Zoom arrives baked into the rects, so 200% is just a taller row at a
// different offset and needs no term of its own.
eq(centreDelta(stage, { top: 500, height: 200 }), 200, 'zoomed row needs no zoom term');

// A stage scrolled to the very top of the document still reports its own box in
// viewport space, so a row at the top of the page reads as far above centre —
// which the browser then clamps. follow.js relies on that clamp rather than
// special-casing the first row, so the delta here must stay large and negative.
eq(centreDelta(stage, { top: 100, height: 150 }), -225, 'first row asks to overscroll');

console.log(`follow: ${checks} checks passed`);
