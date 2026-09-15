// Menubar (File / Edit / View / Plugins / Help) plus the Zoom and Tala
// pickers that anchor to the toolbar. All of these share one popover.

import { state } from './state.js';
import { MENUS, TITLES } from './config.js';
import { shortcutLabel } from './platform.js';
import { show, hide, pop } from './popover.js';
import { openAuth } from './auth-ui.js';
import { undo, redo } from './history.js';
import { clearAll, clearBars, loadPreset } from './score.js';
import { downloadJSON, exportSVG } from './io.js';
import { newDoc, saveDoc, buildTabs } from './tabs.js';
import { toggleTheme } from './theme.js';
import { openLegend } from './legend.js';
import { openAbout } from './about.js';
import { openMonitor } from './midi-monitor.js';
import { exportMP3 } from './mp3.js';
import { exportMIDI } from './midi-export.js';
// The metre picker lives with the metre. It reports a change by the same
// 'tala:changed' event this module already listens for, so neither imports
// the other.
import { openTimeSigPicker } from './timesig-ui.js';
import { currentTala } from './timesig.js';
import { setSetting } from './settings.js';

function updateZoomContainerSize() {
  const sheetwrap = document.getElementById('sheetwrap');
  const container = document.getElementById('zoomContainer');
  if (!sheetwrap || !container) return;

  container.style.width = `${1000 * state.zoom}px`;
  container.style.height = `${sheetwrap.offsetHeight * state.zoom}px`;
}

function setZoom(z) {
  state.zoom = Math.max(0.5, Math.min(2, z));
  const sheetwrap = document.getElementById('sheetwrap');
  if (sheetwrap) {
    sheetwrap.style.transform = `scale(${state.zoom})`;
  }
  updateZoomContainerSize();
  document.getElementById('zoomVal').textContent = Math.round(state.zoom * 100) + '%';
}

// The printed sheet carries no tala caption — the reference header is emblem,
// rule and tone legend, and metre is stated by T.S. The tala still drives
// layout, so this stays as the one place a caption would be written if the
// sheet ever wants one back, and updates the element only if it is there.
function updateTalaLine() {
  const t = currentTala();
  // The T.S. button says which metre is selected — the sheet prints only the
  // number, so the NAME has to be readable somewhere.
  const btn = document.getElementById('timeSigBtn');
  if (btn) btn.title = `Time signature — ${t.label} (${t.formula} = ${t.beats}/4)`;
  const el = document.getElementById('talaLine');
  if (!el) return;
  el.innerHTML = `${t.label} &nbsp;=&nbsp; (${t.formula})`;
}

// Items that show a state rather than just firing. menuHtml() is rebuilt every
// time a menu opens, so the tick is always current without anything having to
// remember to refresh it.
const CHECKED = {
  // A radio group: exactly one of these is ticked, so the menu shows which of
  // the three rules is in force rather than making you infer it from a single
  // toggle that could only ever describe two of them.
  holdTime:    () => state.holdWrites === 'time',
  holdFixed:   () => state.holdWrites === 'fixed',
  holdPalette: () => state.holdWrites === 'palette',
};

function menuHtml(name) {
  return MENUS[name].map(it =>
    it[0] === '—'
      ? '<div class="hr"></div>'
      // it[0] gets the same treatment as it[2] — the Help menu spells its
      // shortcut inline ("Ctrl+Z / Y  →  undo / redo") rather than in the
      // trailing column, and shortcutLabel() is a no-op everywhere it does
      // not match, so running it over both is safe.
      : `<div class="it" data-act="${it[1]}">${CHECKED[it[1]] ? (CHECKED[it[1]]() ? '✓ ' : '   ') : ''}${shortcutLabel(it[0])}${it[2] ? `<span class="sc">${shortcutLabel(it[2])}</span>` : ''}</div>`
  ).join('');
}

function doAct(a) {
  switch (a) {
    case 'newDoc':     newDoc(); break;
    case 'openVarase': openVarasePop(); return;
    case 'save':       downloadJSON(); break;
    case 'exportSvg':  exportSVG(); break;
    case 'exportMp3':  exportMP3(); break;
    case 'exportMidi': exportMIDI(); break;
    case 'print':      window.print(); break;
    case 'legend':     openLegend(); break;
    case 'about':      openAbout(); break;
    case 'midiMonitor': openMonitor(); break;
    case 'undo':       undo(); break;
    case 'redo':       redo(); break;
    case 'clearAll':   clearAll(); break;
    case 'clearBars':  clearBars(); break;
    case 'zin':        setZoom(state.zoom + 0.1); break;
    case 'zout':       setZoom(state.zoom - 0.1); break;
    case 'zreset':     setZoom(1); break;
    case 'theme':      toggleTheme(); break;
    case 'page':       document.getElementById('pageViewBtn').click(); break;
    // What a played note is worth. Set outright rather than cycled: with three
    // rules a toggle would have to be pressed twice to reach one of them, and
    // which two it sat between would depend on where you started.
    case 'holdTime':    setSetting('holdWrites', 'time'); break;
    // The selected symbol IS the value — pick bindu and every key writes a
    // bindu, however long it is held.
    case 'holdFixed':   setSetting('holdWrites', 'fixed'); break;
    case 'holdPalette': setSetting('holdWrites', 'palette'); break;
  }
}

export function openVarasePop() {
  const anchor = document.getElementById('bOpen');
  const html = '<div class="ttl">Open Varase</div>' +
    Object.keys(TITLES).map(k => `<div class="it" data-pre="${k}">${TITLES[k]}</div>`).join('') +
    '<div class="hr"></div>' +
    '<div class="it" data-open="dng">Open .dng.json…</div>' +
    '<div class="it" data-open="midi">Import MIDI (.mid)…</div>' +
    '<div class="it" data-open="xml">Import MusicXML (.xml/.musicxml)…</div>';
  show(html, anchor, 'left');

  pop().querySelectorAll('[data-pre]').forEach(el =>
    el.addEventListener('click', () => {
      loadPreset(el.dataset.pre);
      saveDoc();
      buildTabs();
      hide();
    }),
  );

  const input = document.getElementById('fileInput');
  pop().querySelectorAll('[data-open]').forEach(el =>
    el.addEventListener('click', () => {
      const kind = el.dataset.open;
      input.accept = kind === 'midi' ? '.mid,.midi'
        : kind === 'xml' ? '.xml,.musicxml,.mxl'
        : '.json,.dng.json';
      input.click();
      hide();
    }),
  );
}

function openZoomPicker() {
  const anchor = document.getElementById('zoomBtn');
  const opts = [50, 75, 100, 125, 150, 200];
  show(opts.map(z =>
    `<div class="it ${Math.round(state.zoom * 100) === z ? 'sel' : ''}" data-z="${z}">${z}%</div>`
  ).join(''), anchor, 'left');
  pop().querySelectorAll('[data-z]').forEach(el =>
    el.addEventListener('click', () => { setZoom(+el.dataset.z / 100); hide(); }),
  );
}

export function wireMenus() {
  // menubar
  document.getElementById('menubar').addEventListener('click', e => {
    const m = e.target.closest('.m');
    if (!m) return;
    const open = m.classList.contains('open');
    hide();
    if (open) return;
    m.classList.add('open');
    show(menuHtml(m.dataset.menu), m, 'left');
  });

  // popover item activation
  pop().addEventListener('click', e => {
    const it = e.target.closest('.it');
    if (!it || !it.dataset.act) return;
    const a = it.dataset.act;
    if (a !== 'noop') {
      doAct(a);
      hide();
    }
  });

  // zoom + tala buttons in the toolbar
  document.getElementById('zoomBtn').addEventListener('click', openZoomPicker);
  document.getElementById('timeSigBtn').addEventListener('click', openTimeSigPicker);
  // The header's account button opens the real account dialog. What used to be
  // here was a popover with a hardcoded "Guest User / Offline Mode" and a Sign
  // In that did nothing.
  document.getElementById('profileBtn').addEventListener('click', openAuth);

  // doc tab change updates the tala line
  document.addEventListener('tala:changed', updateTalaLine);
  // update zoom container layout when score is re-rendered
  document.addEventListener('score:rendered', updateZoomContainerSize);
}

export { updateTalaLine, setZoom };
