// Note inspector. Click any glyph on the staff and the right-hand panel says
// what it is — which svara and sthayi, which sound symbol, what it is WORTH
// (its value in beats) and how much of the box it WEIGHS (its timing units).
//
// Everything is read off the clicked element's own data attributes, written by
// rowSVG(). Nothing is looked up in state.notes, because the pad rests that
// fill a part-played box are derived at render time and were never stored
// there — they are just as clickable as a real note.

import { state } from './state.js';
import {
  SCRIPTS, SVARA_TONES, TONE_LETTER, TIME_UNITS_PER_BEAT,
  TOPY, BOTY, STEP, MA_INDEX, STEM_ANCHOR_ABOVE,
  STEM_ANCHOR_BELOW, toCM, isFilled,
} from './config.js';
import { noteY, stemMetrics, scoreRows } from './notation.js';
import { boxUnits } from './timesig.js';
import { setNoteDuration } from './score.js';
// The section panel is its own module — it is a piano roll with three drag
// gestures on it, and it had outgrown living beside the thing that describes a
// single glyph. What is shared is the vocabulary, and it travels one way only:
// inspector -> section, never back.
import {
  beatsLabel, SYM_LABEL, STHAYI, rollModel, sectionHTML, wireSection, sectionBusy,
  selectNote,
} from './section.js';

function ledgersOf(y) {
  if (y > BOTY) return Math.floor((y - BOTY) / STEP);
  if (y < TOPY) return Math.floor((TOPY - y) / STEP);
  return 0;
}

// Staff units -> the physical measurement the sheet actually prints, since
// that is the number anyone checking a glyph against the drawings needs.
const cm = u => `${toCM(u).toFixed(2)} cm`;
const mm = u => `${(toCM(u) * 10).toFixed(2)} mm`;

const row = (k, v, cls = '') =>
  `<div class="irow ${cls}"><span class="k">${k}</span><span class="v">${v}</span></div>`;

// Exported so any other surface that wants to explain a glyph — a tooltip, the
// status line — describes it the same way rather than growing its own copy.
export function describeGlyph(d) {
  const units = +d.units;
  const dur = +d.dur;
  const dot = d.dot === '1';
  const sound = d.sym;
  const at = +d.at;

  // Where it falls on the clock. `at` is absolute timing units from the start.
  // How big a division is comes from the METRE, not a constant, so the panel
  // reports the box the glyph is actually in.
  const boxCap = boxUnits();
  const box = Math.floor(at / boxCap) + 1;
  const beatInBox = Math.floor((at % boxCap) / TIME_UNITS_PER_BEAT) + 1;
  const intoBeat = at % TIME_UNITS_PER_BEAT;

  const value = `${beatsLabel(dur)} beat${dur > 1 ? 's' : ''}`;
  const weight = `${units} / ${boxCap} units`;

  let head = `<div class="ihead">${SYM_LABEL[sound] || sound}${dot ? ' <b>+ chukki</b>' : ''}</div>`;
  let out = '';

  if (d.kind === 'note') {
    const svi = +d.svi;
    const oct = +d.oct;
    const name = (SCRIPTS[state.lang] || SCRIPTS.en)[svi] || '?';
    const tone = SVARA_TONES[svi];
    const filled = isFilled(svi, d.head);
    // M2 is the one variant that is SHARP, so it cannot use the filled goli
    // that means "lowered" — it is drawn as a hollow triangle instead.
    const isM2 = filled && svi === MA_INDEX;
    const variant = filled && tone && tone.variant != null;
    const semi = variant ? tone.variant : tone ? tone.natural : 0;
    const y = noteY(svi, oct);
    const led = ledgersOf(y);

    head = `<div class="ihead"><span class="big">${name}</span>
      <span class="sub">${STHAYI[oct] || 'madhya'} sthayi</span></div>`;

    out += row('Symbol', `${SYM_LABEL[sound] || sound}${dot ? ' + chukki' : ''}`);
    out += row('Value', value, 'hi');
    out += row('Weight', weight, 'hi');
    out += row('Tone', `${TONE_LETTER[semi]} — ${variant ? 'variant' : 'natural'}`);
    out += row('Notehead', isM2 ? 'hollow triangle (M2)'
      : filled ? 'filled (goli)' : 'hollow (goli)');
    out += row('Position', `box ${box} · beat ${beatInBox}`
      + (intoBeat ? ` <span class="dim">+${intoBeat}/${TIME_UNITS_PER_BEAT}</span>` : ''));
    out += row('Staff', `y = ${y} · ${led ? `${led} ledger${led > 1 ? 's' : ''}` : 'no ledger'}`);
    // The stem is measured, not assumed: madhya keeps the fixed 0.54 cm, but
    // mandra and taara stems run back to an anchor beside the magic line, so
    // their length varies with how far out the goli sits. Report what is drawn.
    const stem = stemMetrics(svi, oct, isM2);
    const anchored = oct !== 0;
    out += row('Stem', stem.dir === 1 ? 'up' : 'down');
    out += row('Stem length', `${cm(stem.length)} <span class="dim">${isM2 ? 'apex' : 'edge'} → `
      + (anchored
        ? `anchor y=${oct < 0 ? STEM_ANCHOR_BELOW : STEM_ANCHOR_ABOVE}`
        : `tip, fixed`)
      + '</span>');
    out += row('Stem width', `${mm(stem.width)}`
      + ' <span class="dim">stem, curl, ring, goli outline</span>');
    if (d.tie === '1') out += row('Joined', 'continues a split note', 'note');
    out += row('Source', d.src === '' ? 'derived' : `note ${+d.src + 1}`);
  } else {
    head = `<div class="ihead"><span class="big">Rest</span>
      <span class="sub">${SYM_LABEL[sound] || sound}</span></div>`;
    out += row('Symbol', `${SYM_LABEL[sound] || sound} rest`);
    out += row('Value', value, 'hi');
    out += row('Weight', weight, 'hi');
    out += row('Position', `box ${box} · beat ${beatInBox}`
      + (intoBeat ? ` <span class="dim">+${intoBeat}/${TIME_UNITS_PER_BEAT}</span>` : ''));
    out += row('Origin', d.src === ''
      ? 'auto-filled <span class="dim">(not stored)</span>'
      : `written · note ${+d.src + 1}`, 'note');
  }

  return head + `<div class="ilist">${out}</div>`;
}

const EMPTY = `<div class="iempty">Click any note or rest on the staff to see
  what it is worth.</div>`;

function editorFor(d) {
  const index = d.src === '' ? null : Number(d.src);
  if (index == null || !Number.isInteger(index) || d.kind !== 'note') return '';
  return `<div class="iedit"><label>Played length (beats)
    <input id="inspectDur" type="number" min="0.125" max="64" step="0.125" value="${Number(d.dur)}">
  </label><div class="itime" data-beats="${Number(d.dur)}" title="Drag the line to change the played length">
    <div class="itime-fill"></div><div class="itime-line"></div></div>
  <button id="inspectApply" type="button">Apply</button></div>`;
}


export function installInspector() {
  const panel = document.getElementById('inspectBody');
  if (!panel) return;
  panel.innerHTML = EMPTY;

  // Which division is selected, as a position on the CLOCK. Changing a note's
  // length re-renders the whole score and throws these elements away, and it
  // can reflow the boxes as well — so neither an element reference nor a box
  // ordinal survives an edit made from this panel. `at` does, which is what
  // lets the section put itself back instead of blanking after every drag.
  let selAt = null;

  const clear = () => {
    document.querySelectorAll('#score .glyph.sel')
      .forEach(g => g.classList.remove('sel'));
    document.querySelectorAll('#score .section-hit.sel')
      .forEach(g => g.classList.remove('sel'));
  };

  const boxAtUnit = (rows, at) =>
    rows.flatMap(r => r.boxes).find(b => Number(b.at) === Number(at));

  const openSection = at => {
    const rows = scoreRows();
    const box = boxAtUnit(rows, at);
    if (!box || !box.entries.length) { selAt = null; panel.innerHTML = EMPTY; return; }
    selAt = Number(at);
    const cap = boxUnits();
    const model = rollModel(box, rows, cap);
    // A rebuild replaces the button that was just pressed. The focus goes back
    // to its successor, or a keyboard user pressing the same step twice would
    // have to tab back to it after every press.
    const act = panel.contains(document.activeElement)
      ? document.activeElement.dataset.act : null;
    // The division on either side, for the header's ‹ › — by its place in the
    // flow, and only if there is something in it to open.
    const boxes = rows.flatMap(r => r.boxes);
    const k = boxes.indexOf(box);
    const atOf = b => (b && b.entries.length ? Number(b.at) : null);
    panel.innerHTML = sectionHTML(box, model, cap,
      { prev: atOf(boxes[k - 1]), next: atOf(boxes[k + 1]) });
    wireSection(panel, model, Number(box.at), cap, () => openSection(selAt),
      to => { clear(); openSection(to); mark(to); });
    if (act) panel.querySelector('[data-act="' + act + '"]')?.focus();
  };

  const mark = at => [...document.querySelectorAll('#score .section-hit')]
    .find(s => Number(s.dataset.boxAt) === at)?.classList.add('sel');

  document.getElementById('score').addEventListener('click', e => {
    const g = e.target.closest('.glyph');
    clear();
    if (g) {
      const at = Number(g.dataset.at);
      const hit = [...document.querySelectorAll('#score .section-hit')]
        .find(s => Number(s.dataset.boxAt) <= at && at < Number(s.dataset.boxAt) + boxUnits());
      if (hit) {
        // The note that was clicked is the one the editor opens on.
        selectNote(g.dataset.src === '' ? null : Number(g.dataset.src));
        hit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return;
      }
    }
    if (!g) {
      const section = e.target.closest('.section-hit');
      if (!section) { selAt = null; panel.innerHTML = EMPTY; return; }
      section.classList.add('sel');
      openSection(section.dataset.boxAt);
      return;
    }
    selAt = null;
    g.classList.add('sel');
    panel.innerHTML = describeGlyph(g.dataset) + editorFor(g.dataset);
    const apply = panel.querySelector('#inspectApply');
    const input = panel.querySelector('#inspectDur');
    const timeline = panel.querySelector('.itime');
    const line = panel.querySelector('.itime-line');
    const fill = panel.querySelector('.itime-fill');
    const base = Number(g.dataset.dur);
    const paint = b => {
      const width = Math.max(8, Math.min(100, b / 8 * 100));
      line.style.left = `${width}%`;
      fill.style.width = `${width}%`;
      input.value = Math.round(b * 8) / 8;
    };
    paint(base);
    timeline?.addEventListener('pointerdown', ev => {
      ev.preventDefault();
      timeline.setPointerCapture?.(ev.pointerId);
      const move = e2 => {
        const r = timeline.getBoundingClientRect();
        const b = Math.max(0.125, Math.min(64, ((e2.clientX - r.left) / r.width) * 8));
        paint(b);
      };
      const up = () => {
        timeline.removeEventListener('pointermove', move);
        timeline.removeEventListener('pointerup', up);
        setNoteDuration(Number(g.dataset.src), Number(input.value));
      };
      timeline.addEventListener('pointermove', move);
      timeline.addEventListener('pointerup', up, { once: true });
    });
    apply?.addEventListener('click', () => {
      const index = Number(g.dataset.src);
      if (setNoteDuration(index, input.value)) {
        const next = document.querySelector(`#score .glyph[data-src="${index}"]`);
        if (next) {
          next.classList.add('sel');
          panel.innerHTML = describeGlyph(next.dataset) + editorFor(next.dataset);
        }
      }
    });
  });

  // A re-render throws the old elements away. A selected DIVISION is put back
  // — an edit made in this panel re-renders, and blanking the thing being
  // dragged the moment it moves makes it unusable — but not while a field in
  // it has the focus: playback re-renders on every beat, and replacing the
  // markup under someone's fingers would take the caret out of the input. (A
  // FIELD, not anything focusable: the editor's buttons are focused by the
  // click that presses them, and must not freeze the panel they just edited.) A
  // drag on the roll is the same fact one gesture further on: nothing there
  // commits until the pointer is released, so rebuilding the block under a
  // moving finger would drop the whole move.
  document.addEventListener('score:rendered', () => {
    if (selAt == null) { panel.innerHTML = EMPTY; return; }
    if (panel.querySelector('input:focus, select:focus') || sectionBusy()) return;
    const at = selAt;
    openSection(at);
    if (selAt != null) mark(at);
  });
}
