// The key map — a picture of the keyboard in front of you, and the editor for
// what each key writes.
//
// It draws EVERY cap, not only the 21 bound ones, because the map's job is to
// let you find a svara with your eyes on the screen and your fingers on the
// keyboard; a grid of only the bound caps does not line up with anything you
// are touching. Bound caps carry the svara and its sthayi, free caps are dim.
//
// Rebinding works two ways, per the same rule in both: a key writes exactly
// one svara, so binding a key that is already taken steals it and leaves the
// old slot empty (see bindKey() in keybinds.js).
//   · click a cap on the map     → it listens, the next keystroke binds
//   · the card's Edit keys… button → a dialog listing all 21, with a reset
//
// While a slot is listening, keyboard.js must not treat the keystroke as note
// entry, so it asks isCapturing() first.

import { KEYBOARD_LAYOUT, COL, SCRIPTS } from './config.js';
import { state } from './state.js';
import {
  BIND_OCTS, SLOTS, binds, bindOf, bindKey, clearBind, resetBinds,
  isDefaultBinds,
} from './keybinds.js';

const SECTION = { '-1': 'Mandra', '0': 'Madhya', '1': 'Taara' };
const GLYPH   = { '-1': '▼', '0': '■', '1': '▲' };

// DNR shows the regional script; DNG is always English. Same rule the piano
// and the sheet follow, so one language switch moves all three.
function svaraLabel(i) {
  const script = state.sys === 'DNR' ? (SCRIPTS[state.lang] || SCRIPTS.en) : SCRIPTS.en;
  return script[i];
}

// Which slot, if any, is waiting for a keystroke.
let capture = null;   // { oct, idx }

export function isCapturing() { return capture != null; }

function stopCapture() {
  capture = null;
  buildKeyMap();
  syncDialog();
}

function startCapture(oct, idx) {
  capture = { oct, idx };
  buildKeyMap();
  syncDialog();
}

// ---- the keyboard picture -------------------------------------------------

export function buildKeyMap() {
  const host = document.getElementById('kbRow');
  if (!host) return;
  const b = binds();

  // key char -> slot, for the caps. Built once per redraw rather than calling
  // lookupKey() 60 times.
  const slotOf = {};
  BIND_OCTS.forEach(oct => b[oct].forEach((k, idx) => { if (k) slotOf[k] = { oct, idx }; }));

  host.innerHTML = KEYBOARD_LAYOUT.map(row => {
    const caps = row.map(([k, label, u]) => {
      const width = u || 1;
      const style = `flex:${width} 0 0`;
      // A modifier is furniture: it is drawn so the stagger is right, and it
      // is never bindable.
      if (k == null) {
        return `<div class="kcap mod" style="${style}"><span class="key">${label}</span></div>`;
      }
      const slot = slotOf[k];
      const listening = capture && slot && capture.oct === slot.oct && capture.idx === slot.idx;
      const cls = ['kcap', slot ? 'bound' : 'free', listening ? 'listen' : ''].join(' ').trim();
      const cap = label || k.toUpperCase();
      const meta = slot
        ? `<span class="sv" style="color:${COL[slot.idx]}">${svaraLabel(slot.idx)}</span>
           <span class="oc">${GLYPH[slot.oct]}</span>`
        : '';
      const data = slot ? ` data-oct="${slot.oct}" data-idx="${slot.idx}"` : '';
      return `<div class="${cls}" style="${style}" data-key="${k}"${data}
        title="${slot ? `${svaraLabel(slot.idx)} · ${SECTION[slot.oct]} — click to rebind`
                      : 'Unassigned'}">
        <span class="key">${cap}</span>${meta}
      </div>`;
    }).join('');
    return `<div class="krow">${caps}</div>`;
  }).join('');

  host.querySelectorAll('.kcap.bound').forEach(el => {
    el.addEventListener('click', () => startCapture(+el.dataset.oct, +el.dataset.idx));
  });
  // Clicking a free cap while a slot is listening assigns it, so the whole
  // rebind can be done with the mouse.
  host.querySelectorAll('.kcap.free').forEach(el => {
    el.addEventListener('click', () => {
      if (!capture) return;
      bindKey(capture.oct, capture.idx, el.dataset.key);
      stopCapture();
    });
  });

  const hint = document.getElementById('kbHint');
  if (hint) {
    hint.innerHTML = capture
      ? `Press a key for <b>${svaraLabel(capture.idx)} ${SECTION[capture.oct]}</b> — <b>Esc</b> cancels · <b>Del</b> unassigns`
      : 'Click any lit key to rebind it · <b>⇧</b> variant (filled) · <b>Space</b> play · <b>⌫</b> delete';
  }
}

// ---- the dialog -----------------------------------------------------------

function dialogRows() {
  // A grid, not a list: the bindings ARE a 3x7 table — sthayi down, svara
  // across — so the editor is that table. The svara is named once in the
  // column head rather than repeated in all 21 cells, which leaves each cell
  // showing the one thing being edited: the key.
  const head = `<div class="kb-grid-row kb-grid-head">
    <span class="kb-oct"></span>
    ${Array.from({ length: SLOTS }, (_, i) =>
      `<span class="kb-col" style="--sv:${COL[i]}">${svaraLabel(i)}</span>`).join('')}
  </div>`;

  const rows = BIND_OCTS.map(oct => {
    const cells = Array.from({ length: SLOTS }, (_, idx) => {
      const k = bindOf(oct, idx);
      const listening = capture && capture.oct === oct && capture.idx === idx;
      const cls = ['kb-cell', listening ? 'listen' : '', k ? '' : 'none']
        .join(' ').trim();
      const face = listening ? '<span class="kb-press">press a key</span>'
        : (k ? `<span class="kb-k">${k === ' ' ? 'Space' : k.toUpperCase()}</span>`
             : '<span class="kb-k kb-empty">unassigned</span>');
      return `<button class="${cls}" style="--sv:${COL[idx]}"
        data-oct="${oct}" data-idx="${idx}"
        title="${svaraLabel(idx)} ${SECTION[oct]} — click, then press a key">${face}</button>`;
    }).join('');
    return `<div class="kb-grid-row">
      <span class="kb-oct"><b>${GLYPH[oct]}</b> ${SECTION[oct]}</span>${cells}
    </div>`;
  }).join('');

  return `<div class="kb-grid">${head}${rows}</div>`;
}

function syncDialog() {
  const body = document.getElementById('keymapBody');
  if (!body || document.getElementById('keymapOverlay').hidden) return;
  body.innerHTML = dialogRows();
  body.querySelectorAll('.kb-cell').forEach(el => {
    el.addEventListener('click', () => startCapture(+el.dataset.oct, +el.dataset.idx));
  });
  const reset = document.getElementById('keymapReset');
  if (reset) reset.disabled = isDefaultBinds();

  // One line saying what the editor is waiting for, so the armed state is
  // readable without hunting for the highlighted cell.
  const st = document.getElementById('keymapStatus');
  if (st) {
    st.classList.toggle('on', !!capture);
    st.textContent = capture
      ? `Press the key for ${svaraLabel(capture.idx)} ${SECTION[capture.oct]}`
      : '';
  }
}

export function openKeymapDialog() {
  const ov = document.getElementById('keymapOverlay');
  if (!ov) return;
  ov.hidden = false;
  syncDialog();
}

export function closeKeymapDialog() {
  const ov = document.getElementById('keymapOverlay');
  if (!ov) return;
  ov.hidden = true;
  capture = null;
  buildKeyMap();
}

// ---- wiring ---------------------------------------------------------------

export function installKeymapUI() {
  document.getElementById('kbEditBtn')?.addEventListener('click', openKeymapDialog);
  document.getElementById('keymapClose')?.addEventListener('click', closeKeymapDialog);
  document.getElementById('keymapOverlay')?.addEventListener('click', e => {
    if (e.target.id === 'keymapOverlay') closeKeymapDialog();
  });
  document.getElementById('keymapReset')?.addEventListener('click', () => {
    resetBinds();
    capture = null;
    buildKeyMap();
    syncDialog();
  });

  // Esc closes the dialog, the same as the legend's. While a slot is
  // listening the capture handler below takes Esc first, so one press cancels
  // the rebind and a second closes the dialog.
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !capture && !document.getElementById('keymapOverlay')?.hidden) {
      closeKeymapDialog();
    }
  });

  // The capture listener runs in the CAPTURE phase so it beats keyboard.js's
  // bubble-phase handler to the keystroke. Note entry is gated on
  // isCapturing() as well — belt and braces, since a rebind must never also
  // land a note on the staff.
  window.addEventListener('keydown', e => {
    if (!capture) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') return stopCapture();
    if (e.key === 'Delete' || e.key === 'Backspace') {
      clearBind(capture.oct, capture.idx);
      return stopCapture();
    }
    // Only a key the layout actually draws can be bound: binding F13 or a
    // dead key would put a slot beyond reach of the map that documents it.
    const k = e.key.length === 1 ? e.key.toLowerCase() : (e.key === ' ' ? ' ' : '');
    if (!k || !BINDABLE.has(k)) return;
    bindKey(capture.oct, capture.idx, k);
    stopCapture();
  }, true);
}

// Every character cap the layout draws.
const BINDABLE = new Set(
  KEYBOARD_LAYOUT.flat().map(([k]) => k).filter(k => k != null),
);
