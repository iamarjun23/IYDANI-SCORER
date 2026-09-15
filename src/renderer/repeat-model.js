// What a set of repeat marks MEANS, with no DOM and no state — so the staff
// (notation.js), the drag tool (repeats.js) and the tests can all read the
// same rules instead of each deciding for itself what pairs with what.
//
// A mark is `{ id, unit, kind: 'open'|'close', count }`, where `unit` is a
// position on the CLOCK — timing units from the start of the score — not a
// note index. That is what lets a brace be dropped anywhere on the staff: it
// does not have to land on a note, or even on written music, and an empty
// division is as valid a place to put one as a full one. It also survives
// editing and re-flow, which a screen position would not.
//
// Pairing is DERIVED rather than stored: each close belongs to the nearest
// open before it, which is exactly the rule buildPlaySeq() plays by. Nothing
// links the two ends, so a mark from a file written before any of this still
// pairs correctly.
//
// Nesting is refused rather than supported. playback.js expands one flat pair
// at a time; a nested pair would draw perfectly and then play wrong silently,
// which is the worst of the three outcomes. validateBars() is what the drag
// tool asks before it accepts a drop.

let seq = 0;

// Ids only have to be unique within a session — they are what the selection,
// the hover tint and a drag in flight refer to, and none of those outlive the
// document. They are written into saved files as a side effect, which is
// harmless: a file re-opened gets fresh ones for any mark that lacks them.
export function newBarId() {
  seq += 1;
  return `b${seq}`;
}

// Fill in ids for marks that arrived without them — an older .json, a preset,
// a MIDI import. Idempotent, so the render path can call it every pass.
export function ensureBarIds(bars) {
  if (!Array.isArray(bars)) return bars;
  for (const b of bars) if (b && !b.id) b.id = newBarId();
  return bars;
}

// Marks written before repeats moved onto the clock carry `at`, a note index.
// Convert those once, by adding up what the notes before them are worth: the
// mark stood in front of that note, and that note starts at exactly that point
// on the clock. Idempotent, and it leaves `at` behind so nothing downstream is
// tempted to read a stale index.
export function ensureBarUnits(bars, notes, unitsPerBeat) {
  if (!Array.isArray(bars)) return bars;
  for (const b of bars) {
    if (!b || Number.isFinite(b.unit)) continue;
    const at = Math.max(0, Math.min((notes || []).length, Number(b.at) || 0));
    let u = 0;
    for (let i = 0; i < at; i += 1) {
      u += Math.round((Number(notes[i] && notes[i].dur) || 0) * unitsPerBeat);
    }
    b.unit = u;
    delete b.at;
  }
  return bars;
}

// Where the written music ends on the clock — where a mark inserted by the
// palette's click path goes, since there is no pointer to say otherwise.
export function endUnit(notes, unitsPerBeat) {
  return (notes || []).reduce(
    (u, n) => u + Math.round((Number(n && n.dur) || 0) * unitsPerBeat), 0);
}

// Where a mark actually cuts the music.
//
// A brace is dropped freely, so it has to resolve onto a point the music can
// be looped between — and the rule is the one the eye is already using: THE
// NOTE THE BRACE'S INK COVERS IS IN THE LOOP. An opening brace is drawn to the
// right of its position and takes the start of the glyph it is over, so that
// note is the first of the loop; a closing brace is drawn to the left of its
// position and takes the end of the glyph it is over, so that note is the last.
//
// The two rules this replaces were both wrong, in opposite directions and for
// the same reason — they resolved to an EDGE rather than to a note:
//
//   · rounding forward moved the whole segment one note to the right: the
//     opening end dropped the note it was sitting on, the closing end pulled
//     in an extra one;
//   · rounding to the nearest edge put a cliff down the middle of every note.
//     Aiming at the note you wanted the loop to start on and landing in the
//     right half of its cell skipped that note.
//
// Resolving to the glyph instead means anywhere on a note gives the same
// answer, so pointing at a note is enough — which is how anyone reads a
// repeat, and how the ink reads once it is drawn.
//
// A mark parked out past the written music has no glyph to belong to and is
// left exactly where it was put.
export function resolveMark(unit, kind, cells) {
  if (!cells || !cells.length) return unit;
  const u = Number(unit) || 0;
  const first = cells[0];
  const last = cells[cells.length - 1];
  if (u <= first.at) return first.at;
  if (u >= last.at + last.units) return u;
  if (kind === 'close') {
    // The glyph this point is INSIDE, counting its own end as inside it — a
    // mark exactly on an edge closes the note that ends there rather than the
    // one that starts there, which is what its ink is sitting over.
    const cell = cells.find(c => u > c.at && u <= c.at + c.units);
    return cell ? cell.at + cell.units : u;
  }
  const cell = cells.find(c => u >= c.at && u < c.at + c.units);
  return cell ? cell.at : u;
}

// Marks in the order they are met reading the score. A stable sort keeps two
// marks at the same point in the order they were written — a close before an
// open there means "end this repeat and start the next", which is legal.
export function sortBars(bars) {
  return (bars || [])
    .map((b, i) => ({ b, i }))
    .sort((x, y) => (Number(x.b.unit) - Number(y.b.unit)) || (x.i - y.i))
    .map(x => x.b);
}

// The open/close pairs, in reading order. An open with no close, or a close
// with no open, is simply not a pair — it is drawn, and playback ignores it.
export function repeatPairs(bars) {
  const out = [];
  let open = null;
  for (const b of sortBars(bars)) {
    if (b.kind === 'open') {
      open = b;
    } else if (b.kind === 'close' && open) {
      out.push({
        id: open.id,
        openId: open.id,
        closeId: b.id,
        openUnit: Number(open.unit) || 0,
        closeUnit: Number(b.unit) || 0,
        count: Number(b.count) || Number(open.count) || 2,
      });
      open = null;
    }
  }
  return out;
}

// Would this set of marks play the way it reads? Walking in reading order the
// depth may only ever be 0 or 1: a second open before the first has closed is
// a nest, and a close with nothing open is backwards.
export function validateBars(bars) {
  let depth = 0;
  for (const b of sortBars(bars)) {
    if (b.kind === 'open') {
      depth += 1;
      if (depth > 1) return { ok: false, reason: 'nested' };
    } else if (b.kind === 'close') {
      depth -= 1;
      if (depth < 0) return { ok: false, reason: 'unopened' };
    }
  }
  return { ok: true, reason: null };
}

// The list as it would be with one mark moved to `unit` — used to test a drop
// before committing it. The original list is untouched.
export function withBarMoved(bars, id, unit) {
  return (bars || []).map(b => (b.id === id ? { ...b, unit } : b));
}

// The list as it would be with a new pair added. A dropped open always brings
// its close: an unmatched brace is a mark that renders and does nothing.
export function withPairAdded(bars, openUnit, closeUnit, count) {
  return (bars || []).concat([
    { id: 'new-open', unit: openUnit, kind: 'open', count },
    { id: 'new-close', unit: closeUnit, kind: 'close', count },
  ]);
}
