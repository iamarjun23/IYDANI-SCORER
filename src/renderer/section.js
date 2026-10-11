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
// must never do. The editor's Notehead buttons are what pay the cost back: they
// flip the notehead in place, the same distinction the ⇧ key makes when typing
// (and shift-click on a block is still the shortcut for it).
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
//
// THE ROLL IS THE PANEL. Laid out the way a DAW's piano roll is: one line of
// readout, the roll, one row of controls. The editor that sat above the roll
// was a button for every edit — svara, octave, move, six lengths, a typed
// field — plus a list repeating the roll in words, and it was judged too much.
// What is left under the roll is only what a drag cannot say: the length as a
// SYMBOL, the chukki, the notehead, and delete. Pitch and position are the
// drags, or the arrow keys once the roll has the focus (↑↓ svara, ⇧↑↓ sthayi,
// ←→ a danta earlier or later, Del). They all end in the same score.js
// functions, so a key and a drag cannot land by different rules. The roll is
// first and the header is one unwrapping line, so selecting a note never moves
// the roll out from under the pointer.

import { state } from './state.js';
import {
  SCRIPTS, SVARA_LETTER, SVARA_RUNG, TIME_UNITS_PER_BEAT,
  MA_INDEX, SOUND, DOT_MULT, DOTTABLE, SVARA_TONES, TONE_LETTER,
  isFilled, hasVariant,
} from './config.js';
import { isGroupStart } from './timesig.js';
import {
  setNoteDuration, setNoteHead, setNotePitch, moveNote, nudgeNote, nudgeRoom,
  removeNote,
} from './score.js';

// Every length is a whole number of dantas, so it is spelled as a fraction
// rather than printed as 0.375.
const EIGHTHS = ['', '⅛', '¼', '⅜', '½', '⅝', '¾', '⅞'];
export function beatsLabel(d) {
  const u = Number(d) * TIME_UNITS_PER_BEAT;
  if (!(u > 0) || !Number.isInteger(u)) return String(d);
  return `${Math.floor(u / 8) || ''}${EIGHTHS[u % 8]}`;
}
const beatsText = b => `${beatsLabel(b)} beat${b > 1 ? 's' : ''}`;

export const SYM_LABEL = {
  Maguru: 'Maguru', guru: 'Guru', bindu: 'Bindu',
  vasu: 'Vasu', praya: 'Praya', danta: 'Danta',
};

export const STHAYI = { '-1': 'mandra', 0: 'madhya', 1: 'taara' };

const OCT_MARK = { '-1': '▼', 0: '■', 1: '▲' };

const unitsToBeats = u => u / TIME_UNITS_PER_BEAT;

const svaraName = n => (SCRIPTS[state.lang] || SCRIPTS.en)[n.svaraIndex] || '?';

// A note is named WITH its sthayi wherever it is named in words. On the roll
// itself the band it sits in already says it, so a block carries the svara only.
const partName = n => (n.type === 'rest'
  ? 'Rest'
  : `${svaraName(n)} · ${STHAYI[n.oct] || ''}`);

// The sheet's own three noteheads, so a block is read the way its glyph is:
// hollow natural, filled lowered, triangle M2.
const headMark = p => (p.m2 ? '△' : p.filled ? '●' : '○');

// Shortest to longest, the way a length control reads.
const LENGTHS = ['danta', 'praya', 'vasu', 'bindu', 'guru', 'Maguru'];

// Which symbol a length IS, chukki included — or null when it takes more than
// one glyph to write (1⅛ beats), and no button should claim to be it.
function symbolOf(units) {
  for (const sym of LENGTHS) {
    const u = SOUND[sym].dur * TIME_UNITS_PER_BEAT;
    if (units === u) return { sym, dot: false };
    if (DOTTABLE.includes(sym) && units === u * DOT_MULT) return { sym, dot: true };
  }
  return null;
}

// ---- which note is being worked on ----------------------------------------
//
// Held as the note OBJECT, not its index: a sideways move splices rests in
// front of the note, so its index changes under the very edit that should keep
// it selected. An undo replaces state.notes wholesale and so drops the
// selection, which is the honest answer — that note is gone.
let selNote = null;
export function selectNote(index) { selNote = state.notes[index] || null; }

// ---- the ladder, as lanes -------------------------------------------------

export const LANE_TOP = 15;                          // taara Ni
export const LANE_BOT = -8;                          // mandra Sa
export const LANE_COUNT = LANE_TOP - LANE_BOT + 1;   // 24
// Tall enough for a block to carry a name that can be read and a body that can
// be grabbed: at 10px both were 7.5px type on an 8px target.
const LANE_H = 13;                                   // px

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

const selectedPart = parts => parts.find(p => editable(p)
  && state.notes[p.index] === selNote) || null;

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

// The sthayi is NAMED down the side, once per band. It used to be one ▲■▼ on
// the Sa of each band, 7px tall, and the gutter then read as the same seven
// letters three times over with nothing saying which seven.
function bandsHTML() {
  return [1, 0, -1].map(oct => `<span class="roll-band" data-oct="${oct}">`
    + `<i>${OCT_MARK[oct]}</i><b>${STHAYI[oct]}</b></span>`).join('');
}

// Only the lanes that hold a note in this division are lettered at full
// strength. 21 equally loud letters is a texture; the three or four in use are
// what the eye is looking for when it reads across from a block.
function keysHTML(lanes, used, selRow) {
  return lanes.map((l, i) => `<span class="roll-key${l.dead ? ' dead' : ''}`
    + `${l.svi === 6 ? ' top' : ''}${used.has(i) ? ' on' : ''}`
    + `${i === selRow ? ' sel' : ''}" data-oct="${l.oct}">`
    + `${l.letter}</span>`).join('');
}

// The grid behind the notes: the lanes themselves, then the metre ruled across
// them. Sub-beat lines are drawn only while they would still read as lines — an
// eight-beat division is 64 dantas wide, and one line per danta in this rail is
// a grey wash, not a grid.
function gridHTML(lanes, cap) {
  let out = lanes.map((l, i) => `<i class="roll-lane${l.dead ? ' dead' : ''}`
    + `${l.svi === 6 ? ' top' : ''}" data-oct="${l.oct}" style="top:${i * LANE_H}px"></i>`).join('');
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

// A note that starts or ends outside this division, said in words. It was two
// arrows (↤ ↦) beside a symbol name, which read as a Vasu that plays for a beat.
const carryText = p => [
  p.before ? 'continues from the box before' : '',
  p.tail > 0 ? 'runs on into the next box' : '',
].filter(Boolean).join(' · ');

function titleOf(p) {
  if (p.index == null) return 'Empty — nothing is written here';
  return [partName(p.note), beatsText(partBeats(p)), carryText(p)].filter(Boolean).join(' · ');
}

function blockHTML(p, boxAt, cap, sel) {
  const rel = p.at - boxAt;
  const w = Math.min(p.units, cap - rel);
  const cls = ['roll-blk',
    p.index == null ? 'derived' : '',
    editable(p) ? 'edit' : '',
    p === sel ? 'sel' : '',
    p.filled ? 'var' : '',
    p.m2 ? 'm2' : '',
    p.offLadder ? 'off' : '',
    p.before ? 'in' : '',
    p.tail > 0 ? 'out' : ''].filter(Boolean).join(' ');
  // A name needs room to be a name. Under a tenth of the division the block is
  // too narrow for one and a clipped letter reads as dirt, so the tooltip and
  // the list below carry it instead.
  const label = w / cap >= 0.1 ? `${headMark(p)} ${svaraName(p.note)}` : '';
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
// full one. Room nobody has written in is drawn too, but faint and unlabelled:
// it is not a rest, it is where the next note goes.
function restsHTML(rests, boxAt, cap, sel) {
  return rests.map(p => {
    const rel = p.at - boxAt;
    const w = Math.min(p.units, cap - rel);
    const cls = ['roll-rest', p.index == null ? 'derived' : '',
      editable(p) ? 'edit' : '', p === sel ? 'sel' : ''].filter(Boolean).join(' ');
    return `<div class="${cls}" data-part="${p.i}" data-left="${pctOf(rel, cap)}"`
      + ` title="${titleOf(p)}"`
      + ` style="left:${pctOf(rel, cap)}%;width:${pctOf(w, cap)}%">`
      + `<span class="roll-len">${p.index == null ? '' : beatsLabel(partBeats(p))}</span>`
      + (editable(p) ? '<span class="roll-grip"></span>' : '')
      + '</div>';
  }).join('');
}

function rollHTML(model, boxAt, sel) {
  const { lanes, notes, rests, cap } = model;
  const used = new Set(notes.map(p => p.row));
  // Where the score is sounding, if it is sounding in THIS division. It rides
  // on the same state the staff's own highlight reads, so the line and the
  // recoloured glyph cannot point at different notes.
  const head = state.playing && state.hlAt != null
    && state.hlAt >= boxAt && state.hlAt < boxAt + cap
    ? `<i class="roll-head" style="left:${pctOf(state.hlAt - boxAt, cap)}%"></i>` : '';
  // Focusable, because the arrow keys edit the selected note only while the
  // roll has the focus — everywhere else they belong to the break tool. The
  // data-act is what lets inspector.js put the focus back after a rebuild.
  return `<div class="roll" tabindex="0" data-act="roll" style="--lane-h:${LANE_H}px;--lanes:${lanes.length}">`
    + '<div class="roll-gut">beat</div>'
    + `<div class="roll-ruler">${rulerHTML(cap)}</div>`
    + `<div class="roll-bands">${bandsHTML()}</div>`
    + `<div class="roll-keys">${keysHTML(lanes, used, sel ? sel.row : null)}</div>`
    + `<div class="roll-track">${gridHTML(lanes, cap)}`
    + `${notes.map(p => blockHTML(p, boxAt, cap, sel)).join('')}${head}</div>`
    + '<div class="roll-gut">rest</div>'
    + `<div class="roll-rests">${restsHTML(rests, boxAt, cap, sel)}</div>`
    + '</div>';
}

// ---- the readout and the control row ---------------------------------------

const btn = (act, label, title, { on = false, off = false, beats = null } = {}) =>
  `<button type="button" class="sed-b${on ? ' on' : ''}" data-act="${act}" title="${title}"`
  + (beats == null ? '' : ` data-beats="${beats}"`)
  + `${off ? ' disabled' : ''}>${label}</button>`;

// What is selected, on one line: which note, where it starts, how long it
// plays. With nothing selected the same line says what the division holds.
function lcdText(p, boxAt) {
  const n = p.note;
  const isNote = n.type !== 'rest';
  return [isNote ? STHAYI[n.oct] || '' : '',
    p.before ? '' : 'beat ' + beatsLabel(unitsToBeats(p.at - boxAt) + 1),
    '<span class="sec-len">' + beatsText(partBeats(p)) + '</span>',
    carryText(p)].filter(Boolean).join(' · ');
}

// Only what a drag cannot say. A control that would do nothing is disabled
// rather than left to be pressed and ignored — a svara with no second form, a
// length the chukki cannot be put on.
function barHTML(p) {
  if (!p) return '<div class="sed empty">Click a note to edit it.</div>';
  const n = p.note;
  const is = symbolOf(p.total);
  // A length that takes more than one glyph to write is no symbol's, so it is
  // listed as itself rather than a symbol being shown that it is not.
  const length = '<select class="sed-len" data-act="len" aria-label="Length">'
    + (is ? '' : `<option selected disabled>${beatsText(unitsToBeats(p.total))}</option>`)
    + LENGTHS.map(sym => `<option value="${SOUND[sym].dur}"${is?.sym === sym ? ' selected' : ''}>`
      + `${SYM_LABEL[sym]} · ${beatsLabel(SOUND[sym].dur)}</option>`).join('')
    + '</select>';
  const dottable = !!is && DOTTABLE.includes(is.sym);
  const dot = btn('dot', '•', 'Chukki — half as long again', {
    on: !!is?.dot,
    off: !dottable,
    beats: dottable ? SOUND[is.sym].dur * (is.dot ? 1 : DOT_MULT) : null,
  });

  let head = '';
  if (n.type !== 'rest') {
    const tone = SVARA_TONES[n.svaraIndex];
    const two = hasVariant(n.svaraIndex);
    const varMark = n.svaraIndex === MA_INDEX ? '△' : '●';
    head = '<span class="sed-pair">'
      + btn('nat', `○ ${TONE_LETTER[tone.natural]}`, 'Hollow — the natural',
        { on: !p.filled, off: !two })
      + (two ? btn('var', `${varMark} ${TONE_LETTER[tone.variant]}`,
        n.svaraIndex === MA_INDEX ? 'Triangle — the raised Ma' : 'Filled — the lowered one',
        { on: p.filled }) : '')
      + '</span>';
  }
  return `<div class="sed">${length}${dot}${head}`
    + '<button type="button" class="sed-b sed-del" data-act="del"'
    + ` title="${n.type === 'rest' ? 'Delete this rest' : 'Delete — leaves silence in its place'}">Delete</button>`
    + '</div>';
}

const stepHTML = (act, at, label, title) =>
  `<button type="button" class="sec-step" data-act="${act}" title="${title}"`
  + (at == null ? ' disabled' : ` data-at="${at}"`) + `>${label}</button>`;

// `nav` is the division on either side, as clock positions, or null at an end.
export function sectionHTML(box, model, cap, nav = {}) {
  const beatsN = cap / TIME_UNITS_PER_BEAT;
  const written = model.parts.filter(p => p.index != null);
  const freeU = cap - written.reduce((u, p) => u + p.units, 0);
  const notes = model.notes.length;
  const sel = selectedPart(model.parts);
  const room = freeU > 0 ? beatsText(unitsToBeats(freeU)) + ' free' : 'full';
  const name = sel && (sel.note.type === 'rest' ? 'Rest' : headMark(sel) + ' ' + svaraName(sel.note));
  const lcd = sel
    ? `<b>${name}</b>${lcdText(sel, Number(box.at))}`
    : `${beatsN} beats · ${notes} note${notes === 1 ? '' : 's'} · ${room}`;
  return '<div class="ihead sec">'
    + stepHTML('prev', nav.prev, '‹', 'Previous box')
    + `<span class="big">Box ${Math.floor(box.at / cap) + 1}</span>`
    + stepHTML('next', nav.next, '›', 'Next box')
    + `<span class="sec-lcd">${lcd}</span></div>`
    + '<div class="iedit"><div class="stime-wrap">'
    + rollHTML(model, Number(box.at), sel)
    + barHTML(sel)
    + '<div class="sed-hint">Drag to move · drag the right edge to resize · '
    + '↑↓ svara · Shift ↑↓ sthayi · ←→ nudge · Del</div>'
    + '</div></div>';
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
// than on the block or through setPointerCapture. A block is a lane tall and
// the pointer leaves it within one lane of vertical travel, so element-bound
// listeners hear the press and then nothing — the note would follow the pointer
// only while the pointer stayed on top of it, which for an upward drag is never.
// The window also survives the element: render() rebuilds the panel, and a
// listener on markup that has just been replaced is a gesture dropped halfway.
//
// `redraw` puts the panel back WITHOUT a score render — a selection changes
// what the editor shows and nothing on the staff. Every edit that turns out to
// be a no-op calls it too, which is what puts a dragged block back where it
// was: an edit that lands re-renders the score, and that rebuilds the panel.
export function wireSection(panel, model, boxAt, cap, redraw, go) {
  const track = panel.querySelector('.roll-track');
  if (!track) return;
  const roll = panel.querySelector('.roll');
  const parts = model.parts;
  const sel = selectedPart(parts);
  const MAX_UNITS = 64 * TIME_UNITS_PER_BEAT;
  const all = [...panel.querySelectorAll('.roll-blk, .roll-rest')];
  const pick = p => { selNote = state.notes[p.index] || null; };

  // Any press on the roll gives it the focus, which is what sends the arrow
  // keys here. In the CAPTURE phase, because the drags below preventDefault()
  // their pointerdown (so the browser would not focus anything) and the grip
  // stops it propagating. It also takes the focus OFF the length menu, which
  // inspector.js will not rebuild the panel under.
  roll.addEventListener('pointerdown', () => roll.focus({ preventScroll: true }), true);

  panel.querySelectorAll('.sec-step[data-at]').forEach(b =>
    b.addEventListener('click', () => go(Number(b.dataset.at))));

  // Everything downstream of a moved note moves with it. A sequence has no room
  // to slide one note through, so this is not decoration — it is what the edit
  // does, shown while it can still be reconsidered.
  const ripple = (from, dUnits) => all.forEach(el => {
    const p = parts[Number(el.dataset.part)];
    if (!p || p.at <= from) return;
    el.style.left = `${Number(el.dataset.left) + pctOf(dUnits, cap)}%`;
  });

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
        const len = el.querySelector('.roll-len');
        if (len) len.textContent = beatsLabel(b);
        const lcd = p === sel && panel.querySelector('.sec-len');
        if (lcd) lcd.textContent = beatsText(b);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        dragging = false;
        pick(p);
        if (!setNoteDuration(p.index, unitsToBeats(total))) redraw();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  });

  // ---- the body: pitch and position, in one gesture ----
  panel.querySelectorAll('.roll-blk.edit').forEach(el => {
    const p = parts[Number(el.dataset.part)];

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
        dragging = false;
        // Whatever was just touched is the note being worked on.
        pick(p);
        // A click that went nowhere is not a move: it selects. With shift it
        // also flips the notehead — the shortcut for the editor's own button,
        // and a no-op on Sa and Pa, which have no second form to flip to.
        const done = moved
          ? moveNote(p.index, { svaraIndex: LANES[row].svi, oct: LANES[row].oct, delta: dUnits })
          : e2.shiftKey
            && setNoteHead(p.index, isFilled(p.note.svaraIndex, p.note.head) ? 'o' : 'f');
        if (!done) redraw();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  });

  // Empty roll puts the selection down, which is what brings the how-to back.
  track.addEventListener('pointerdown', ev => {
    if (ev.target.closest('.roll-blk') || !selNote) return;
    selNote = null;
    redraw();
  });

  // ---- the rest lane: click to select ----
  parts.filter(p => editable(p) && p.note.type === 'rest').forEach(p => {
    all.find(el => Number(el.dataset.part) === p.i)
      ?.addEventListener('click', () => { pick(p); redraw(); });
  });

  // ---- the selected note: the control row and the keys ----
  if (!sel) return;
  const i = sel.index;
  const src = state.notes[i];
  const isNote = src.type === 'note';
  const pitchTo = row => setNotePitch(i, LANES[row].svi, LANES[row].oct);
  const run = {
    up: () => pitchTo(landingRow(sel.row - 1, -1)),
    down: () => pitchTo(landingRow(sel.row + 1, 1)),
    octup: () => setNotePitch(i, src.svaraIndex, src.oct + 1),
    octdown: () => setNotePitch(i, src.svaraIndex, src.oct - 1),
    nat: () => setNoteHead(i, 'o'),
    var: () => setNoteHead(i, 'f'),
    earlier: () => nudgeNote(i, -1),
    later: () => nudgeNote(i, 1),
    del: () => removeNote(i),
  };
  panel.querySelectorAll('.sed button[data-act]').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.beats) setNoteDuration(i, b.dataset.beats);
    else run[b.dataset.act]?.();
  }));
  // The length menu. The panel does not rebuild itself under a focused field
  // (playback would close the menu while it is being read), so it is asked to
  // here.
  const len = panel.querySelector('.sed-len');
  len.addEventListener('change', () => { setNoteDuration(i, len.value); redraw(); });

  // Only with the focus on the roll, and stopped there: on the document the
  // arrows nudge the current break and Backspace deletes the LAST note.
  roll.addEventListener('keydown', e => {
    if (e.target !== roll || e.ctrlKey || e.metaKey || e.altKey) return;
    const act = (e.shiftKey && SHIFT_KEYS[e.key]) || KEYS[e.key];
    if (!act || (act !== 'del' && !isNote)) return;
    e.preventDefault();
    e.stopPropagation();
    run[act]();
  });
}

const KEYS = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'earlier', ArrowRight: 'later',
  Delete: 'del', Backspace: 'del',
};
const SHIFT_KEYS = { ArrowUp: 'octup', ArrowDown: 'octdown' };
