// Left-hand sidebar palettes (notes, rests, repeat braces, octaves, layout),
// plus the tones table. Glyph names carry data-i18n; i18n.js translates them.

import { state } from './state.js';
import {
  SOUND, TONE_LETTER, TONE_MARK, SYM_FILE, REST_MAP,
} from './config.js';
import { repeatGlyphSVG } from './notation.js';
import { addRest } from './score.js';
import { setBreakTool, isBreakTool } from './breaks.js';
import { setRepeatTool, repeatToolState } from './repeats.js';
import { setOct, buildPiano } from './piano.js';
import { l10n } from './i18n.js';

// Icon dimensions in each palette grid. Centralised so it's one edit when
// the tool sidebar needs resizing.
const SIZE = {
  sound: { w: 20, h: 28 },
  rest: { w: 18, h: 24 },
  repeat: { w: 26, h: 34 },     // sidebar palette icons — bigger
};

function img(src, w, h) {
  return `<img src="${src}" width="${w}" height="${h}" style="object-fit:contain;display:block" alt=""/>`;
}

function weightLabel(dur) {
  return ({ 4: '4', 2: '2', 1: '1', 0.5: '1/2', 0.25: '1/4', 0.125: '1/8' })[dur] || String(dur);
}

// One half of a repeat brace, drawn by the staff's own repeatMark() rather
// than fetched from symbols/ — so the palette advertises the exact mark the
// sheet writes, at any size, and inherits the sidebar's ink through
// currentColor instead of needing the dark theme's invert filter.
function halfImg(kind, count, w, h) {
  return repeatGlyphSVG(kind, count, w, h, 'rep-half');
}

function octGlyph(t) {
  const C = 'currentColor';
  let g = '<svg width="22" height="22" viewBox="0 0 22 22">';
  if (t === 'dn') g += `<path d="M5 8h12l-6 8z" fill="${C}"/>`;
  if (t === 'mid') g += `<rect x="7" y="8" width="8" height="7" fill="${C}"/>`;
  if (t === 'up') g += `<path d="M5 14h12l-6-8z" fill="${C}"/>`;
  return g + '</svg>';
}

// The Break tool's icon: the return arrow, the same mark the sheet writes at
// the end of a broken row. Drawn rather than imported because it is a UI tool,
// not one of the notation symbols in symbols/.
function breakGlyph() {
  const C = 'currentColor';
  return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${C}"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M20 5v6a3 3 0 0 1-3 3H5"/><path d="M9 10l-4 4 4 4"/></svg>`;
}

// The tone legend printed at the top right of the sheet: the twelve tones in
// semitone order with the notehead each one is written with underneath. Both
// rows come straight from config — TONE_LETTER and TONE_MARK — so the key
// cannot say one thing while the staff draws another.
//
// M2's triangle is drawn rather than styled: a hollow triangle is not something
// a border trick renders honestly, and this way it matches the notehead on the
// staff — point up, hollow, thin ink.
const TRI_MARK = '<svg class="mk-t" viewBox="0 0 12 11" aria-hidden="true">'
  + '<polygon points="6,1.2 11,9.8 1,9.8" fill="none" stroke="#111" stroke-width="1.5"'
  + ' stroke-linejoin="round"/></svg>';

//
// The marks row is also a row of SWITCHES, one per tone, for the sthayi the
// legend is showing — which is state.oct, the same sthayi the piano's tabs
// select, stepped from here by the two arrows either side of the table. A tone
// switched off is a blank white cell; score.js refuses to write it.
export function buildTones() {
  const on = state.tones[state.oct + 1];
  const head = `<tr>${TONE_LETTER.map(l => `<td>${l}</td>`).join('')}</tr>`;
  const marks = `<tr>${TONE_MARK.map((m, semi) => {
    const cls = `mk${on[semi] ? '' : ' off'}`;
    if (m === 't') return `<td class="${cls}" data-semi="${semi}">${TRI_MARK}</td>`;
    return `<td class="${cls}" data-semi="${semi}"><span class="mk-${m}"></span></td>`;
  }).join('')}</tr>`;
  document.getElementById('tonesTable').innerHTML = head + marks;
  const name = document.getElementById('toneName');
  name.dataset.i18n = ['Mandra', 'Madhya', 'Taara'][state.oct + 1];
  name.textContent = l10n(name.dataset.i18n);
  document.getElementById('tonePrev').disabled = state.oct <= -1;
  document.getElementById('toneNext').disabled = state.oct >= 1;
}

export function initTones() {
  buildTones();
  document.getElementById('tonesTable').addEventListener('click', e => {
    const td = e.target.closest('td.mk');
    if (!td) return;
    const row = state.tones[state.oct + 1];
    row[+td.dataset.semi] = !row[+td.dataset.semi];
    buildTones();
    buildPiano();
  });
  document.getElementById('tonePrev').addEventListener('click', () => setOct(state.oct - 1));
  document.getElementById('toneNext').addEventListener('click', () => setOct(state.oct + 1));
  document.addEventListener('oct:changed', buildTones);
  // Another document's selection was swapped in (tab, file, import).
  document.addEventListener('tones:changed', () => { buildTones(); buildPiano(); });
}

// A repeat glyph ARMS the tool rather than inserting anything: the pair is
// then placed on the sheet by two clicks, the way the Break tool is armed and
// then aimed. Clicking the armed glyph again puts the tool away, and clicking
// a different count re-arms at that count.
//
// The button is the tool's own display. It shows the LEFT half of the brace
// while the tool is waiting for the loop's start and the RIGHT half once that
// has been picked, so the glyph under the pointer is the end being placed.
function armRepeat(count) {
  const st = repeatToolState();
  setRepeatTool(!(st.on && st.count === count), count);
}

function syncRepeat(el, count) {
  const st = repeatToolState();
  const armed = st.on && st.count === count;
  const kind = armed ? st.kind : 'open';
  const was = el.dataset.rkind;
  el.classList.toggle('sel', armed);
  el.dataset.rkind = kind;
  el.title = armed
    ? (kind === 'open'
      ? `Repeat ×${count} — click the note the loop starts on`
      : `Repeat ×${count} — now click the note it ends on (Esc to cancel)`)
    : `Repeat ×${count} — click here, then click the sheet where the loop`
      + ' starts and where it ends';
  // Redrawn when the tool moves from the loop's start to its end, not
  // re-cropped: the two halves are two drawings now, not two windows onto one
  // image. Its own box is the size to redraw at, so the swap cannot resize it.
  const svg = el.querySelector('svg.rep-half');
  if (svg && was !== kind) {
    svg.outerHTML = repeatGlyphSVG(kind, count,
      svg.getAttribute('width'), svg.getAttribute('height'), 'rep-half');
  }
}

function syncRepeatUI() {
  document.querySelectorAll('#repeatGrid .glyph.rep').forEach(
    el => syncRepeat(el, +el.dataset.rcount));
}

function setSelected(gridSelector, predicate) {
  document.querySelectorAll(`${gridSelector} .glyph`).forEach(g => {
    g.classList.toggle('sel', predicate(g));
  });
}

export function buildPalettes() {
  const sounds = [
    ['bindu', 'Bindu'], ['vasu', 'Vasu'], ['praya', 'Praya'],
    ['danta', 'Danta'], ['guru', 'Guru'], ['Maguru', 'Maguru'],
  ];
  document.getElementById('soundGrid').innerHTML = sounds.map((s, i) =>
    `<div class="glyph ${i === 0 ? 'sel' : ''}" data-snd="${s[0]}" title="${s[1]} — weight ${weightLabel(SOUND[s[0]].dur)}">
      <span class="art">${img(SYM_FILE[s[0]].white, SIZE.sound.w, SIZE.sound.h)}</span>
      <span class="nm" data-i18n="${s[1]}">${s[1]}</span>
    </div>`).join('');

  const rests = [
    ['rest_symbol_1', 'Bindu Rest'], ['rest_2', 'Vasu Rest'],
    ['rest_3', 'Praya Rest'], ['rest4', 'Danta Rest'],
    ['rest_5', 'Guru Rest'], ['rest_6', 'Maguru Rest'],
  ];
  document.getElementById('restGrid').innerHTML = rests.map(s =>
    `<div class="glyph" data-rest="${s[0]}" title="Insert ${s[1]}">
      <span class="art">${img(SYM_FILE[REST_MAP[s[0]]].rest, SIZE.rest.w, SIZE.rest.h)}</span>
      <span class="nm" data-i18n="${s[1]}">${s[1]}</span>
    </div>`).join('');

  // Three repeat types. The glyph shows the LEFT half of the SVG while the
  // tool is waiting for the loop's start and the RIGHT half once it has one;
  // both ends are placed by clicking the sheet, so nothing is written until
  // the pair is complete.
  const reps = [
    ['repeat', 2, '×2'],
    ['repeat_3', 3, '×3'],
    ['repeat_4', 4, '×4'],
  ];
  document.getElementById('repeatGrid').innerHTML = reps.map(r =>
    `<div class="glyph rep" data-rkey="${r[0]}" data-rcount="${r[1]}" data-rkind="open" data-rw="${SIZE.repeat.w}" title="Open repeat ×${r[1]}">
      <span class="art">${halfImg('open', r[1], SIZE.repeat.w, SIZE.repeat.h)}</span>
      <span class="nm">${r[2]}</span>
    </div>`).join('');

  const octs = [['dn', -1, 'Mandra'], ['mid', 0, 'Madhya'], ['up', 1, 'Taara']];
  document.getElementById('octGrid').innerHTML = octs.map(o =>
    `<div class="glyph ${o[1] === 0 ? 'sel' : ''}" data-oct="${o[1]}">
      <span class="art">${octGlyph(o[0])}</span>
      <span class="nm" data-i18n="${o[2]}">${o[2]}</span>
    </div>`).join('');

  // Layout tools act on the SHEET rather than on the score: arming Break and
  // clicking a division moves it, and everything after it, onto a new row.
  document.getElementById('layoutGrid').innerHTML =
    `<div class="glyph" data-tool="break" title="Break — click a division on the sheet to move it, and everything after it, down to a new row. The break you worked on last is marked on the staff: nudge it with ←/→, drag its ↵ badge to move it, click that badge to remove it.">
      <span class="art">${breakGlyph()}</span>
      <span class="nm" data-i18n="Break">Break</span>
    </div>`;

  // -------- listeners --------

  document.getElementById('layoutGrid').addEventListener('click', e => {
    const el = e.target.closest('.glyph');
    if (!el) return;
    const on = !isBreakTool();
    setBreakTool(on);
    setSelected('#layoutGrid', g => on && g === el);
  });

  // Anything that disarms the tool elsewhere (Escape, another surface) has to
  // clear the sidebar selection too, or the palette lies about the mode.
  document.addEventListener('tool:changed', () => {
    setSelected('#layoutGrid', g => isBreakTool() && g.dataset.tool === 'break');
  });

  document.getElementById('soundGrid').addEventListener('click', e => {
    const el = e.target.closest('.glyph');
    if (!el) return;
    setSelected('#soundGrid', g => g === el);
    state.sym = el.dataset.snd;
  });

  document.getElementById('restGrid').addEventListener('click', e => {
    const el = e.target.closest('.glyph');
    if (!el) return;
    addRest(el.dataset.rest);
  });

  document.getElementById('repeatGrid').addEventListener('click', e => {
    const el = e.target.closest('.glyph');
    if (!el) return;
    armRepeat(+el.dataset.rcount);
  });

  // The tool reports itself - armed, disarmed, and which end it is waiting
  // for - and both palettes redraw from that. Nothing here tracks the mode on
  // its own, so a tool put away by Escape or by arming Break cannot leave a
  // glyph lit that is no longer listening.
  document.addEventListener('repeat:armed', syncRepeatUI);
  document.addEventListener('tool:changed', syncRepeatUI);
  syncRepeatUI();

  document.getElementById('octGrid').addEventListener('click', e => {
    const el = e.target.closest('.glyph');
    if (!el) return;
    // delegate to setOct in piano.js via a custom event so this module
    // doesn't take a hard dependency on piano.js
    document.dispatchEvent(new CustomEvent('oct:set', { detail: +el.dataset.oct }));
  });

  // collapsible sections
  document.querySelectorAll('.tsec .head').forEach(h =>
    h.addEventListener('click', () => {
      const g = h.nextElementSibling;
      g.style.display = g.style.display === 'none' ? '' : 'none';
    }),
  );
}
