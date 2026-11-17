// Drag-and-drop of notes and rests on the sheet. Two ways in, one drop:
// press a Notes/Rests palette glyph and drag it onto the staff, or press a
// note already on the staff and drag it somewhere else. Height picks the rung
// (snapped to the ladder, with a ghost notehead, its name, and the pitch
// sounded as each rung is crossed); the glyph under the pointer picks WHERE —
// before it in its left half, after it in its right. Dropping inserts and
// pushes the rest of the score along (score.js placeAt()). ⇧ at the drop
// writes the other notehead, as on the keyboard.
//
// Pointer events like repeats.js and breaks.js, for the same reasons. A press
// that never moves stays a click, so selecting a palette symbol, adding a rest
// by click and the inspector's note click all still work.

import { state } from './state.js';
import {
  VW, LPAD, STEP, BOTY, SVARA_RUNG, RUNGS_PER_OCTAVE, SOUND, REST_MAP,
  SVARAS, SCRIPTS, TONE_LETTER, MA_INDEX, NOTE_GEOM, semiOf, hasVariant,
} from './config.js';
import {
  scoreRows, unitAtX, noteY, noteGlyph, restMark, ledgerLines, stemTip, stemPointsDown,
} from './notation.js';
import { placeAt } from './score.js';
import { pluck, freqOf } from './audio.js';

const CLICK_SLOP = 4;
const STHAYI = ['Mandra', 'Madhya', 'Taara'];

let drag = null;
let ghost = null;
let swallowClick = false;

// The nearest writable rung to a y in row units — the inverse of noteY().
// The dead rung (3, the magic line and its echoes) goes to whichever
// neighbour is nearer; anything past the three sthayis clamps to their ends.
export function pitchAtY(y) {
  const half = STEP / 2;
  const raw = (BOTY + half - y) / half;
  let pos = Math.round(raw);
  pos = Math.max(-RUNGS_PER_OCTAVE, Math.min(2 * RUNGS_PER_OCTAVE - 1, pos));
  const oct = Math.floor(pos / RUNGS_PER_OCTAVE);
  let rung = pos - oct * RUNGS_PER_OCTAVE;
  if (rung === 3) rung = raw < pos ? 2 : 4;
  return { svi: SVARA_RUNG.indexOf(rung), oct };
}

// The scale's notehead, or the other one with ⇧ — keyboard.js's rule.
function headFor(svi, shift) {
  const scaleFilled = !!SVARAS[svi].filled;
  const filled = shift ? !scaleFilled : scaleFilled;
  return filled && hasVariant(svi) ? 'f' : 'o';
}

function rowGeometry() {
  const rows = scoreRows();
  const svgs = document.querySelectorAll('#score .srow svg');
  const placed = [];
  rows.forEach((row, i) => {
    const svg = svgs[i];
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    placed.push({ row, i, rect, k: rect.width / VW, vy: vb.y, ky: vb.height / (rect.height || 1) });
  });
  return { rows, placed };
}

// Where the pointer would drop: a point on the clock, the screen x of that
// boundary, and (for notes) the snapped pitch.
function targetAt(e) {
  const { rows, placed } = drag.geometry;
  if (!placed.length) return null;
  let best = placed[0];
  let bestD = Infinity;
  for (const p of placed) {
    const r = p.rect;
    const d = e.clientY < r.top ? r.top - e.clientY : e.clientY > r.bottom ? e.clientY - r.bottom : 0;
    if (d < bestD) { bestD = d; best = p; }
  }
  const x = Math.max(0, Math.min(best.row.width, (e.clientX - best.rect.left) / best.k - LPAD));
  let unit = null;
  let bx = x;
  for (const b of best.row.boxes) {
    for (const en of b.entries) {
      if (x >= en.x && x < en.x + en.w) {
        const after = x >= en.x + en.w / 2;
        unit = after ? en.at + en.units : en.at;
        bx = after ? en.x + en.w : en.x;
      }
    }
  }
  if (unit == null) unit = Math.round(unitAtX(rows, best.i, x));
  const y = best.vy + (e.clientY - best.rect.top) * best.ky;
  const pitch = drag.rest ? null : pitchAtY(y);
  return { unit, best, x: best.rect.left + (LPAD + bx) * best.k, pitch };
}

// The symbol about to be placed, drawn by the staff's own functions at the
// row's scale, so the ghost is exactly what the drop will write.
const GW = 60;   // ghost width, in row units
function glyphSVG(t, e) {
  const ink = 'var(--accent, #1f6feb)';
  if (drag.rest) return restMark(GW / 2, drag.rest, ink);
  const { svi, oct } = t.pitch;
  const head = headFor(svi, e.shiftKey);
  const src = drag.from != null ? state.notes[drag.from] : null;
  const sym = NOTE_GEOM[src ? src.sym : drag.sym] ? (src ? src.sym : drag.sym) : 'bindu';
  const variant = head === 'f';
  const isM2 = variant && svi === MA_INDEX;
  const dir = stemPointsDown(svi, oct) ? -1 : 1;
  return ledgerLines(GW / 2, svi, oct)
    + noteGlyph(GW / 2, noteY(svi, oct), sym, variant && !isM2, dir, !!(src && src.dot),
      stemTip(svi, oct), isM2, ink);
}

function show(e, t) {
  const nm = ghost.querySelector('.nm');
  const art = ghost.querySelector('.art');
  if (!t) {
    // Off the sheet: no target, nothing drawn — letting go here cancels.
    ghost.style.display = 'none';
    return;
  }
  ghost.style.display = 'block';
  const r = t.best.rect;
  const k = t.best.k;
  const vh = r.height * t.best.ky;
  ghost.style.left = `${t.x - (GW / 2) * k}px`;
  ghost.style.top = `${r.top}px`;
  art.innerHTML = `<svg viewBox="0 ${t.best.vy} ${GW} ${vh}" width="${GW * k}" height="${r.height}"`
    + ` overflow="visible">${glyphSVG(t, e)}</svg>`;
  if (drag.rest) { nm.textContent = ''; return; }
  const { svi, oct } = t.pitch;
  const head = headFor(svi, e.shiftKey);
  nm.style.left = `${(GW / 2) * k + 10}px`;
  nm.style.top = `${(noteY(svi, oct) - t.best.vy) / t.best.ky - 22}px`;
  nm.textContent = `${STHAYI[oct + 1]} ${SCRIPTS.en[svi]} (${TONE_LETTER[semiOf(svi, head)]})`;
  const key = `${svi}:${oct}:${head}`;
  if (key !== drag.lastKey) {
    drag.lastKey = key;
    pluck(freqOf(semiOf(svi, head), oct));
  }
}

function begin(spec, e) {
  drag = { ...spec, sx: e.clientX, sy: e.clientY, moved: false };
}

function move(e) {
  if (!drag) return;
  if (!drag.moved) {
    if (Math.abs(e.clientX - drag.sx) < CLICK_SLOP && Math.abs(e.clientY - drag.sy) < CLICK_SLOP) return;
    drag.moved = true;
    drag.geometry = rowGeometry();
    ghost = document.createElement('div');
    ghost.className = 'note-ghost';
    ghost.innerHTML = '<span class="art"></span><span class="nm"></span>';
    document.body.appendChild(ghost);
    document.body.classList.add('note-dragging');
  }
  drag.target = overSheet(e) ? targetAt(e) : null;
  show(e, drag.target);
}

function clear() {
  ghost?.remove();
  ghost = null;
  document.body.classList.remove('note-dragging');
}

function end(e) {
  if (!drag) return;
  const d = drag;
  drag = null;
  clear();
  if (!d.moved) return;
  swallowClick = true;
  setTimeout(() => { swallowClick = false; }, 0);
  const t = d.target;
  if (!t) return;
  if (d.rest) {
    const sd = SOUND[REST_MAP[d.rest] || 'bindu'] || SOUND.bindu;
    placeAt({ type: 'rest', sym: d.rest, dur: sd.dur }, t.unit);
    return;
  }
  const { svi, oct } = t.pitch;
  const head = headFor(svi, e.shiftKey);
  if (d.from != null) { placeAt({ svaraIndex: svi, oct, head }, t.unit, d.from); return; }
  const sd = SOUND[d.sym] || SOUND.bindu;
  placeAt({
    type: 'note', svaraIndex: svi, oct, head, sym: d.sym, dot: false, dur: sd.dur, deco: sd.deco,
  }, t.unit);
}

function overSheet(e) {
  const sheet = document.querySelector('.sheet') || document.getElementById('score');
  if (!sheet) return true;
  const r = sheet.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
}

export function installNoteDrag() {
  const idle = () => !state.tool && !state.lesson && !state.playing;

  document.getElementById('soundGrid').addEventListener('pointerdown', e => {
    const el = e.target.closest('[data-snd]');
    if (el && idle()) begin({ sym: el.dataset.snd }, e);
  });
  document.getElementById('restGrid').addEventListener('pointerdown', e => {
    const el = e.target.closest('[data-rest]');
    if (el && idle()) begin({ rest: el.dataset.rest }, e);
  });
  // No native image drag out of the palette.
  for (const id of ['soundGrid', 'restGrid']) {
    document.getElementById(id).addEventListener('dragstart', e => e.preventDefault());
  }

  document.getElementById('score').addEventListener('pointerdown', e => {
    const g = e.target.closest('.glyph[data-kind="note"]');
    if (!g || g.dataset.src === '' || !idle() || e.button !== 0) return;
    e.preventDefault();
    begin({ from: Number(g.dataset.src) }, e);
  });

  // A drag ends with a click on whatever is under the pointer; it must not
  // also select a note or clear the inspector.
  window.addEventListener('click', e => {
    if (swallowClick) { e.stopPropagation(); e.preventDefault(); swallowClick = false; }
  }, true);

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', () => { drag = null; clear(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && drag) { drag = null; clear(); }
  });
}
