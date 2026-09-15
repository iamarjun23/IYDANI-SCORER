// The section panel — one DIVISION of the score, drawn as a piano roll.
//
// WHY A ROLL AND NOT A STRIP. What this replaced measured time and nothing
// else: every note sat in the same lane at the same height, so the panel could
// not tell Ga from Pa without being read word by word. A division is a shape —
// a phrase rises or falls — and a strip cannot draw a shape. The roll adds the
// axis the staff already has.
//
// LANES ARE RUNGS, NOT SEMITONES. A lane is a position on the staff's own
// ladder (`oct * 8 + SVARA_RUNG[svi]`), running -8 at mandra Sa to 15 at taara
// Ni: 24 lanes, of which 21 are writable and THREE ARE DEAD. The dead ones are
// the magic line and its two octave echoes — the rungs the notation carries no
// note on — and drawing them is what keeps an octave 8 lanes tall here exactly
// as it is 8 rungs tall on the sheet. Take them out and the panel would draw
// two notes an octave apart at 7 lanes' distance in one place and 8 in another.
//
// What that costs is that R1 and R2 SHARE A LANE, because they share a rung on
// the staff — the notehead is what separates them, not the height. A chromatic
// 36-lane roll would split them and would then be drawing a pitch relationship
// the sheet contradicts, which is the one thing a second view of the same score
// must never do. Shift-click is what pays the cost back: it flips the notehead
// in place, the same distinction the ⇧ key makes when typing.
//
// WHAT A DRAG MEANS. Three things move, and each ends in score.js:
//
//   right edge      how long the note PLAYS          setNoteDuration()
//   body, sideways  the SILENCE in front of it       moveNote()
//   body, up/down   which RUNG it sits on            moveNote()
//
// The sideways one is the one with a story. A score is a SEQUENCE — a note has
// no x of its own, only the durations stacked up before it — so there is no
// position to write and a DAW-style free move is not expressible. What IS
// expressible is the gap, so that is what the gesture edits, and it stops dead
// at the previous note because there is no silence there to take. nudgeRoom()
// is asked on every pointermove so the block stops on screen exactly where it
// would stop in the score, rather than sliding past a wall and snapping back.
//
// A division's entries are NOT one per note. A note longer than the room left
// is cut at the box line, and a long value is written as several glyphs
// (splitGlyphs), so one source note can arrive here as two or three entries in
// a row. They are merged back into ONE block, because the length being reported
// is the length the note was PLAYED — not the length of the piece of it that
// happens to be drawn in this division. The same fact is what makes `before`
// necessary: a block whose note started in the division above is only its tail,
// and a drag on it sets the note's WHOLE length, so what is off to the left has
// to be added back or every tied note would be truncated by the act of looking
// at it.

import { state } from './state.js';
import {
  SCRIPTS, SVARA_LETTER, SVARA_RUNG, TIME_UNITS_PER_BEAT, REST_MAP,
  MA_INDEX, isFilled, hasVariant,
} from './config.js';
import { isGroupStart } from './timesig.js';
import {
  setNoteDuration, setNoteHead, moveNote, nudgeRoom,
} from './score.js';

// Durations are always a symbol value or a chukki of one, so the set is small
// and closed — spell them rather than printing 0.375.
const BEATS = {
  6: '6', 4: '4', 3: '3', 2: '2', 1.5: '1½', 1: '1',
  0.75: '¾', 0.5: '½', 0.375: '⅜', 0.25: '¼', 0.125: '⅛',
};
export const beatsLabel = d => BEATS[d] || String(d);

export const SYM_LABEL = {
  Maguru: 'Maguru', guru: 'Guru', bindu: 'Bindu',
  vasu: 'Vasu', praya: 'Praya', danta: 'Danta',
};

const OCT_MARK = { '-1': '▼', 0: '■', 1: '▲' };

const unitsToBeats = u => u / TIME_UNITS_PER_BEAT;

const partName = n => (n.type === 'rest'
  ? 'rest'
  : `${(SCRIPTS[state.lang] || SCRIPTS.en)[n.svaraIndex] || '?'}${n.oct ? OCT_MARK[n.oct] : ''}`);

const partSym = n => SYM_LABEL[n.type === 'rest' ? (REST_MAP[n.sym] || n.sym) : n.sym] || n.sym;

// ---- the ladder, as lanes -------------------------------------------------

export const LANE_TOP = 15;                          // taara Ni
export const LANE_BOT = -8;                          // mandra Sa
export const LANE_COUNT = LANE_TOP - LANE_BOT + 1;   // 24
const LANE_H = 10;                                   // px

// The staff's own placement rule, with nothing added: one rung per lane, the
// Ga-Ma gap included, so this and noteY() cannot disagree about what an octave
// is worth.
export function laneOf(svaraIndex, oct) {
  return oct * 8 + SVARA_RUNG[svaraIndex];
}

export const rowOfLane = pos => LANE_TOP - pos;

// Top-down, highest pitch first — the order they are drawn in.
export function laneList() {
  const out = [];
  for (let pos = LANE_TOP; pos >= LANE_BOT; pos -= 1) {
    const oct = Math.floor(pos / 8);
    const rung = pos - oct * 8;
    const svi = SVARA_RUNG.slice(0, 7).indexOf(rung);
    out.push({
      pos,
      oct,
      svi: svi < 0 ? null : svi,
      dead: svi < 0,
      letter: svi < 0 ? '' : SVARA_LETTER[svi],
      // The Sa of each sthayi carries the band's mark, the same ▲■▼ the sheet's
      // row gutter uses — three marks down the side rather than 21.
      mark: svi === 0 ? OCT_MARK[oct] : '',
    });
  }
  return out;
}

// A part is editable when it is a written note or rest with ONE source index.
// The collapsed whole-division rest (`covers`) is not: it stands for several
// source notes at once, so there is no single length a drag on it could set.
const editable = p => p.index != null && !p.merged && p.total != null;

// What the panel REPORTS a part as lasting: the source note's whole played
// length where there is one, and the room it takes in this division otherwise.
const partBeats = p => unitsToBeats(editable(p) ? p.total : p.units);

export function partsOf(box, rows) {
  const startOf = new Map();
  rows.forEach(r => r.boxes.forEach(b => b.entries.forEach(e => {
    if (e.index == null) return;
    const at = startOf.get(e.index);
    if (at == null || e.at < at) startOf.set(e.index, e.at);
  })));

  const parts = [];
  box.entries.forEach(e => {
    const last = parts[parts.length - 1];
    if (last && e.index != null && last.index === e.index) {
      last.units += e.units;
      return;
    }
    const src = e.index == null ? null : state.notes[e.index];
    parts.push({
      index: e.index,
      note: e.note,
      merged: !!(e.covers && e.covers.length > 1),
      total: src ? Math.round(src.dur * TIME_UNITS_PER_BEAT) : null,
      at: e.at,
      units: e.units,
      before: e.index == null ? 0 : e.at - (startOf.get(e.index) ?? e.at),
    });
  });
  // How much of the note is still to come after this division. It can only be
  // worked out once the run has finished merging, since `units` grows as the
  // pieces are folded in.
  parts.forEach(p => { p.tail = editable(p) ? p.total - p.before - p.units : 0; });
  return parts;
}

// Everything the roll needs to draw itself, and nothing that needs a document.
//
// A note whose sthayi is off the ladder — only reachable from a hand-edited
// file — is pinned to the edge lane and MARKED rather than dropped: silently
// not drawing a note that the staff does draw is the worse failure.
export function rollModel(box, rows, cap) {
  const lanes = laneList();
  const parts = partsOf(box, rows);
  parts.forEach((p, i) => {
    p.i = i;
    const n = p.note;
    if (n.type === 'rest') { p.lane = null; p.row = null; return; }
    const pos = laneOf(n.svaraIndex, n.oct);
    const clamped = Math.max(LANE_BOT, Math.min(LANE_TOP, pos));
    p.lane = clamped;
    p.row = rowOfLane(clamped);
    p.offLadder = clamped !== pos;
    p.filled = isFilled(n.svaraIndex, n.head);
    p.m2 = p.filled && n.svaraIndex === MA_INDEX;
  });
  return {
    cap,
    lanes,
    parts,
    notes: parts.filter(p => p.note.type !== 'rest'),
    rests: parts.filter(p => p.note.type === 'rest'),
  };
}

// ---- drawing --------------------------------------------------------------

const pctOf = (u, cap) => (u / cap) * 100;

function rulerHTML(cap) {
  const beatsN = cap / TIME_UNITS_PER_BEAT;
  let out = '';
  for (let b = 0; b < beatsN; b += 1) {
    out += `<span class="roll-tick${isGroupStart(b) ? ' grp' : ''}"`
      + ` style="left:${pctOf(b * TIME_UNITS_PER_BEAT, cap)}%">${b + 1}</span>`;
  }
  return out;
}

function keysHTML(lanes) {
  return lanes.map(l => `<span class="roll-key${l.dead ? ' dead' : ''}" data-oct="${l.oct}">`
    + `<b>${l.letter}</b><i>${l.mark}</i></span>`).join('');
}

// The grid behind the notes: the lanes themselves, then the metre ruled across
// them. Sub-beat lines are drawn only while they would still read as lines — an
// eight-beat division is 64 dantas wide, and one line per danta in this rail is
// a grey wash, not a grid.
function gridHTML(lanes, cap) {
  let out = lanes.map((l, i) => `<i class="roll-lane${l.dead ? ' dead' : ''}"`
    + ` data-oct="${l.oct}" style="top:${i * LANE_H}px"></i>`).join('');
  const sub = cap <= 4 * TIME_UNITS_PER_BEAT;
  for (let u = 1; u < cap; u += 1) {
    const onBeat = u % TIME_UNITS_PER_BEAT === 0;
    if (!onBeat && !sub) continue;
    const cls = onBeat
      ? (isGroupStart(u / TIME_UNITS_PER_BEAT) ? 'roll-beat grp' : 'roll-beat')
      : 'roll-sub';
    out += `<i class="${cls}" style="left:${pctOf(u, cap)}%"></i>`;
  }
  return out;
}

function titleOf(p) {
  const len = beatsLabel(partBeats(p));
  return `${partName(p.note)} · ${partSym(p.note)} · ${len} beat`
    + `${partBeats(p) === 1 ? '' : 's'} played`
    + (p.before ? ' · carried in from the division above' : '')
    + (p.tail > 0 ? ' · carries on into the next division' : '');
}

function blockHTML(p, boxAt, cap) {
  const rel = p.at - boxAt;
  const w = Math.min(p.units, cap - rel);
  const cls = ['roll-blk',
    p.index == null ? 'derived' : '',
    editable(p) ? 'edit' : '',
    p.filled ? 'var' : '',
    p.m2 ? 'm2' : '',
    p.offLadder ? 'off' : '',
    p.before ? 'in' : '',
    p.tail > 0 ? 'out' : ''].filter(Boolean).join(' ');
  // A name needs room to be a name. Below half a beat the block is a few pixels
  // wide and a clipped letter reads as dirt, so the tooltip and the list below
  // carry it instead.
  const label = p.units >= TIME_UNITS_PER_BEAT / 2 ? partName(p.note) : '';
  return `<div class="${cls}" data-part="${p.i}" data-left="${pctOf(rel, cap)}"`
    + ` title="${titleOf(p)}"`
    + ` style="left:${pctOf(rel, cap)}%;width:${pctOf(w, cap)}%;top:${p.row * LANE_H}px">`
    + `<span class="roll-nm">${label}</span>`
    + (editable(p) ? '<span class="roll-grip"></span>' : '')
    + '</div>';
}

// Silence gets a lane of its own under the roll rather than being drawn as
// empty space. A true piano roll would show nothing there — but a written
// Maguru rest IS score, and one that cannot be seen or reached from this panel
// is one nobody can edit; a half-empty division would also look exactly like a
// full one.
function restsHTML(rests, boxAt, cap) {
  return rests.map(p => {
    const rel = p.at - boxAt;
    const w = Math.min(p.units, cap - rel);
    const cls = ['roll-rest', p.index == null ? 'derived' : '',
      editable(p) ? 'edit' : ''].filter(Boolean).join(' ');
    return `<div class="${cls}" data-part="${p.i}" data-left="${pctOf(rel, cap)}"`
      + ` title="${titleOf(p)}"`
      + ` style="left:${pctOf(rel, cap)}%;width:${pctOf(w, cap)}%">`
      + `<span class="roll-len">${beatsLabel(partBeats(p))}</span>`
      + (editable(p) ? '<span class="roll-grip"></span>' : '')
      + '</div>';
  }).join('');
}

function rollHTML(model, boxAt) {
  const { lanes, notes, rests, cap } = model;
  // Where the score is sounding, if it is sounding in THIS division. It rides
  // on the same state the staff's own highlight reads, so the line and the
  // recoloured glyph cannot point at different notes.
  const head = state.playing && state.hlAt != null
    && state.hlAt >= boxAt && state.hlAt < boxAt + cap
    ? `<i class="roll-head" style="left:${pctOf(state.hlAt - boxAt, cap)}%"></i>` : '';
  return `<div class="roll" style="--lane-h:${LANE_H}px;--lanes:${lanes.length}">`
    + '<div class="roll-gut"></div>'
    + `<div class="roll-ruler">${rulerHTML(cap)}</div>`
    + `<div class="roll-keys">${keysHTML(lanes)}</div>`
    + `<div class="roll-track">${gridHTML(lanes, cap)}`
    + `${notes.map(p => blockHTML(p, boxAt, cap)).join('')}${head}</div>`
    + '<div class="roll-gut rest">rest</div>'
    + `<div class="roll-rests">${restsHTML(rests, boxAt, cap)}</div>`
    + '</div>';
}

function listRowHTML(p, i) {
  const len = beatsLabel(partBeats(p));
  const fixedWhy = p.index == null ? 'auto-filled silence' : 'stands for several notes';
  // The symbol column names the glyph DRAWN in this division, while the length
  // is the whole note's — so a note that starts or ends outside the division is
  // marked, or the row reads as a Vasu that plays for a beat.
  const carry = (p.before ? '<span class="stime-carry" title="starts in the division above">↤</span>' : '')
    + (p.tail > 0 ? '<span class="stime-carry" title="carries on into the next division">↦</span>' : '');
  return `<div class="stime-row" data-part="${i}">`
    + `<span class="stime-n">${i + 1}</span>`
    + `<span class="stime-nm">${partName(p.note)}${carry}</span>`
    + `<span class="stime-sym">${partSym(p.note)}</span>`
    + (editable(p)
      ? '<input class="stime-input" type="number" min="0.125" max="64" step="0.125"'
        + ` value="${unitsToBeats(p.total)}" aria-label="${partName(p.note)} played length in beats">`
      : `<span class="stime-fixed" title="${fixedWhy}">${len}</span>`)
    + '</div>';
}

// The list under the roll. It is the typed-length path and the only one a
// keyboard can reach, so it stays exactly as it was when the strip was there.
function rowsHTML(parts) {
  return `<div class="stime-rows">${parts.map(listRowHTML).join('')}</div>`;
}

export function sectionHTML(box, model, cap) {
  const beatsN = cap / TIME_UNITS_PER_BEAT;
  const parts = model.parts;
  const written = parts.filter(p => p.index != null);
  const playedU = written.reduce((u, p) => u + p.units, 0);
  const notes = written.filter(p => p.note.type !== 'rest').length;
  return `<div class="ihead"><span class="big">Section</span>
      <span class="sub">box ${Math.floor(box.at / cap) + 1} · ${beatsN} beats · `
    + `${notes} note${notes === 1 ? '' : 's'}</span></div>
    <div class="iedit"><div class="stime-wrap">
      ${rollHTML(model, Number(box.at))}
      ${rowsHTML(parts)}
      <div class="stime-sum">${beatsLabel(unitsToBeats(playedU))} of ${beatsN} beats written</div>
      <div class="dim">Drag a block to move or re-pitch it, its right edge to
      change how long it plays, or shift-click to flip the notehead.</div>
    </div></div>`;
}

// ---- dragging -------------------------------------------------------------

// A drag survives a re-render only because nothing commits until the pointer is
// released — but playback re-renders on every beat, and replacing the markup
// under a moving finger would drop the gesture on the floor. The panel asks
// this before putting itself back, exactly as it already asks whether a field
// has the focus.
let dragging = false;
export const sectionBusy = () => dragging;

const LANES = laneList();

// Where a vertical drag lands. Dead lanes cannot be written on, so one is
// stepped OVER in the direction of travel rather than snapped back from —
// refusing the drop would make the empty rung feel like a wall two lanes thick,
// when what it actually is on the staff is a line you pass through.
export function landingRow(row, dir) {
  const r = Math.max(0, Math.min(LANES.length - 1, row));
  if (!LANES[r].dead) return r;
  const step = r + (dir >= 0 ? 1 : -1);
  return step < 0 || step >= LANES.length ? r - (dir >= 0 ? 1 : -1) : step;
}

// Both ways of changing a length end in setNoteDuration(), and both axes of a
// move end in moveNote(), so a dragged note and a typed one cannot land by
// different rules — and one gesture is one undo.
//
// A drag listens on the WINDOW, the way breaks.js and repeats.js do, rather
// than on the block or through setPointerCapture. A block is 8 pixels tall and
// the pointer leaves it within one lane of vertical travel, so element-bound
// listeners hear the press and then nothing — the note would follow the pointer
// only while the pointer stayed on top of it, which for an upward drag is never.
// The window also survives the element: render() rebuilds the panel, and a
// listener on markup that has just been replaced is a gesture dropped halfway.
export function wireSection(panel, model, boxAt, cap) {
  const track = panel.querySelector('.roll-track');
  if (!track) return;
  const parts = model.parts;
  const MAX_UNITS = 64 * TIME_UNITS_PER_BEAT;
  const all = [...panel.querySelectorAll('.roll-blk, .roll-rest')];
  const inputOf = i => panel.querySelector(`.stime-row[data-part="${i}"] .stime-input`);

  // Everything downstream of a moved note moves with it. A sequence has no room
  // to slide one note through, so this is not decoration — it is what the edit
  // does, shown while it can still be reconsidered.
  const ripple = (from, dUnits) => all.forEach(el => {
    const p = parts[Number(el.dataset.part)];
    if (!p || p.at <= from) return;
    el.style.left = `${Number(el.dataset.left) + pctOf(dUnits, cap)}%`;
  });
  const unripple = () => all.forEach(el => { el.style.left = `${el.dataset.left}%`; });

  // ---- right edge: how long it plays ----
  all.filter(el => el.classList.contains('edit')).forEach(el => {
    const i = Number(el.dataset.part);
    const p = parts[i];
    const grip = el.querySelector('.roll-grip');
    const lane = el.closest('.roll-track, .roll-rests');
    if (!grip || !lane) return;

    grip.addEventListener('pointerdown', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      dragging = true;
      const r = lane.getBoundingClientRect();
      const rel = p.at - boxAt;
      const left = r.left + (rel / cap) * r.width;
      let total = p.total;

      const move = e2 => {
        // Where the pointer is, read as a position on the division's clock —
        // the roll measures the metre, so a boundary means the beat it is over.
        // Dragging past the right edge is a real answer (the note runs on into
        // the next division), so only the DRAWING is clamped.
        const inBox = Math.round(((e2.clientX - left) / r.width) * cap);
        total = Math.max(1, Math.min(MAX_UNITS, p.before + inBox));
        const shown = Math.max(1, Math.min(total - p.before, cap - rel));
        el.style.width = `${pctOf(shown, cap)}%`;
        el.classList.toggle('out', total - p.before > cap - rel);
        const b = unitsToBeats(total);
        const input = inputOf(i);
        if (input) input.value = b;
        const len = el.querySelector('.roll-len');
        if (len) len.textContent = beatsLabel(b);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        dragging = false;
        setNoteDuration(p.index, unitsToBeats(total));
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  });

  // ---- the body: pitch and position, in one gesture ----
  panel.querySelectorAll('.roll-blk.edit').forEach(el => {
    const p = parts[Number(el.dataset.part)];
    // Shift-click on a svara with no second form is a no-op rather than a wrong
    // note — Sa and Pa have no lowered form, exactly as ⇧ on those keys writes
    // nothing. The class is what stops the cursor promising otherwise.
    if (!hasVariant(p.note.svaraIndex)) el.classList.add('novar');

    el.addEventListener('pointerdown', ev => {
      if (ev.target.closest('.roll-grip')) return;
      ev.preventDefault();
      dragging = true;
      const r = track.getBoundingClientRect();
      const x0 = ev.clientX;
      const y0 = ev.clientY;
      const row0 = p.row;
      let dUnits = 0;
      let row = row0;
      let moved = false;

      const move = e2 => {
        const dx = e2.clientX - x0;
        const dy = e2.clientY - y0;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
        // The wall is asked about, not assumed: nudgeRoom() answers with the
        // units actually available, so the block stops in front of the previous
        // note here exactly as it would in the score.
        dUnits = nudgeRoom(p.index, Math.round((dx / r.width) * cap));
        row = landingRow(row0 + Math.round(dy / LANE_H), dy);
        el.classList.toggle('walled', dx < -6 && dUnits === 0);
        el.style.left = `${Number(el.dataset.left) + pctOf(dUnits, cap)}%`;
        el.style.top = `${row * LANE_H}px`;
        ripple(p.at, dUnits);
      };
      const up = e2 => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        el.classList.remove('walled');
        dragging = false;
        if (!moved) {
          // A click that went nowhere is not a move. With shift it is the one
          // edit a shared rung makes necessary — the notehead — and without it
          // the division is already selected, so it is simply a click.
          if (e2.shiftKey) {
            setNoteHead(p.index, isFilled(p.note.svaraIndex, p.note.head) ? 'o' : 'f');
          }
          return;
        }
        const lane = LANES[row];
        unripple();
        if (!moveNote(p.index, { svaraIndex: lane.svi, oct: lane.oct, delta: dUnits })) {
          el.style.left = `${el.dataset.left}%`;
          el.style.top = `${row0 * LANE_H}px`;
        }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  });

  // ---- the list: the typed length, and the only keyboard-reachable path ----
  parts.forEach((p, i) => {
    const input = inputOf(i);
    input?.addEventListener('change', () => setNoteDuration(p.index, input.value));
    const rowEl = panel.querySelector(`.stime-row[data-part="${i}"]`);
    const blk = all.find(el => Number(el.dataset.part) === i);
    if (!rowEl || !blk) return;
    const lit = on => { rowEl.classList.toggle('lit', on); blk.classList.toggle('lit', on); };
    rowEl.addEventListener('pointerenter', () => lit(true));
    rowEl.addEventListener('pointerleave', () => lit(false));
    blk.addEventListener('pointerenter', () => lit(true));
    blk.addEventListener('pointerleave', () => lit(false));
  });
}
