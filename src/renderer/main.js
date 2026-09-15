// Entry point. Pulls the modules together, builds the UI, wires every
// listener that doesn't belong to a specific module, and seeds the first
// open document.

import { state, docs, getActiveDoc } from './state.js';
import { BPM } from './config.js';
import { render } from './notation.js';
import { updateUndoButtons, undo } from './history.js';
import { clearAll, clearBars } from './score.js';
import { buildTones, buildBraces, buildPalettes } from './palettes.js';
import { buildPiano, buildSpanPicker, buildMidiKeyPicker } from './piano.js';
import { buildKeyMap, installKeymapUI } from './keymap.js';
import { loadBinds, applyBinds, saveBinds } from './keybinds.js';
import { buildTabs, saveDoc } from './tabs.js';
import { setThemeIcon, toggleTheme } from './theme.js';
import { wireMenus, updateTalaLine, setZoom } from './menus.js';
import { wireToolbar } from './toolbar.js';
import { openLanguagePicker } from './language.js';
import { openCowork } from './cowork.js';
import { installKeyboard } from './keyboard.js';
import { installDismiss } from './popover.js';
import { initUpdater } from './updater-ui.js';
import { installInspector } from './inspector.js';
import { wireLegend } from './legend.js';
import { wireMonitor } from './midi-monitor.js';
import { wireAbout } from './about.js';
import { installBreakTool } from './breaks.js';
import { installRepeatTool } from './repeats.js';
import { loadTalas, registerTala, allTalas } from './timesig.js';
import { loadSettings } from './settings.js';
import { wireTimeSigDialog } from './timesig-ui.js';
import { shortcutLabel } from './platform.js';
import { installMidiUI } from './midi-input.js';
import { wireAuth, initAccount } from './auth-ui.js';


// Toolbar tooltips are typed once in index.html as "New (Ctrl+N)" and read
// wrong on a Mac even though the key itself already works there — every
// modifier check in the app is ctrlKey||metaKey. Rewritten once at startup
// rather than duplicated per-platform in the markup.
function relabelShortcuts() {
  document.querySelectorAll('[title*="Ctrl+"], [title*="Alt+"]').forEach(el => {
    el.title = shortcutLabel(el.title);
  });
}

function wireDock() {
  document.getElementById('undoBtn').addEventListener('click', undo);
  document.getElementById('clearBtn').addEventListener('click', clearAll);
  document.getElementById('clearBars').addEventListener('click', clearBars);
}

function wireHeaderButtons() {
  document.getElementById('themeBtn').addEventListener('click', toggleTheme);
  document.getElementById('langBtn').addEventListener('click', openLanguagePicker);
  document.getElementById('coworkBtn').addEventListener('click', openCowork);
}

function initNetworkIndicator() {
  const el = document.getElementById('netStatus');
  if (!el) return;
  const txt = el.querySelector('.net-text');

  async function checkRealConnectivity() {
    if (!navigator.onLine) {
      return false;
    }
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      await fetch('https://clients3.google.com/generate_204', {
        method: 'HEAD',
        mode: 'no-cors',
        cache: 'no-store',
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      return true;
    } catch (err) {
      return false;
    }
  }

  async function update() {
    const isOnline = await checkRealConnectivity();
    if (isOnline) {
      el.classList.remove('offline');
      txt.textContent = 'Online';
    } else {
      el.classList.add('offline');
      txt.textContent = 'Offline — will sync when connected';
    }
  }

  window.addEventListener('online', update);
  window.addEventListener('offline', update);

  // Check every 10 seconds to handle silent disconnects
  setInterval(update, 10000);

  update();
}

function seedFirstDoc() {
  state.title = 'Untitled';
  state.preset = null;
  document.getElementById('titleVal').textContent = state.title;
  docs.push({
    notes: state.notes,
    bars: state.bars,
    breaks: state.breaks,
    lastBreak: state.lastBreak,
    title: state.title,
    preset: state.preset,
    tala: state.tala,
    bpm: state.bpm,
  });
}

function initFileLoader() {
  const input = document.getElementById('fileInput');
  if (!input) return;

  input.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const name = file.name.toLowerCase();

    try {
      if (name.endsWith('.mid') || name.endsWith('.midi')) {
        const { importMidi } = await import('./import.js');
        const buf = await file.arrayBuffer();
        importMidi(buf, file.name);
        saveDoc();
        buildTabs();
      } else if (name.endsWith('.xml') || name.endsWith('.musicxml') || name.endsWith('.mxl')) {
        const { importMusicXml } = await import('./import.js');
        const text = await file.text();
        importMusicXml(text, file.name);
        saveDoc();
        buildTabs();
      } else {
        // .dng.json / .json — native format
        const text = await file.text();
        const data = JSON.parse(text);
        state.notes = data.notes || [];
        state.bars = data.bars || [];
        state.breaks = data.breaks || [];
        // A file does not carry where somebody was editing it, so the pointer
        // starts clear on the score that has just been opened.
        state.lastBreak = null;
        state.title = data.title || file.name.replace(/\.(dng\.)?json$/i, '');
        // The metre travels with the file. Register the definition before
        // naming it, or a custom time signature opens as the fallback and the
        // score is silently re-barred.
        if (data.timeSig) registerTala(data.timeSig);
        state.tala = data.tala && allTalas()[data.tala] ? data.tala : 'chatusra';
        state.bpm = data.bpm || BPM;
        // The tonic travels with the score. Without this every file opened
        // at Sa = C whatever key it was written in, which also dropped the
        // whole line into the octave that was never recorded — so every
        // note came off a pitch-shifted sample.
        state.saMidi = Number(data.saMidi) || 60;
        // The key layout travels with the score, so a file written on a
        // custom map opens playable on that map. Absent (or from an older
        // file) leaves the current bindings alone rather than resetting them.
        if (data.keyBinds) { applyBinds(data.keyBinds); saveBinds(); buildKeyMap(); }
        state.preset = null;

        document.getElementById('titleVal').textContent = state.title;
        document.getElementById('bpmVal').value = state.bpm;
        updateTalaLine();
        render();
        saveDoc();
        buildTabs();
      }
    } catch (err) {
      alert('Could not open file: ' + err.message);
    }
    input.value = '';
  });
}

function initTitleEditor() {
  const el = document.getElementById('titleVal');
  if (!el) return;

  el.addEventListener('blur', () => {
    const val = el.textContent.trim() || 'Untitled';
    state.title = val;
    el.textContent = val;
    saveDoc();
    buildTabs();
  });

  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      el.blur();
    }
  });
}

function init() {
  // Bindings first: the key map and the keyboard handler both read them, and
  // a saved layout has to be in place before either one is built.
  loadBinds();
  // Custom time signatures, for the same reason: the metre decides how big a
  // division is, so it has to be registered before anything lays out a row.
  loadTalas();
  // Preferences, before anything can read one. holdWrites decides what a held
  // key writes, so it has to be in place before the first note can be played.
  loadSettings();

  // build static UI
  buildTones();
  buildBraces();
  buildPalettes();
  buildSpanPicker();
  buildMidiKeyPicker();
  buildPiano();
  buildKeyMap();

  // visual setup
  setThemeIcon();
  updateTalaLine();
  setZoom(state.zoom);

  relabelShortcuts();

  // wire listeners
  wireMenus();
  wireToolbar();
  wireDock();
  wireHeaderButtons();
  installKeyboard();
  installInspector();
  installBreakTool();
  installRepeatTool();
  wireTimeSigDialog();
  installKeymapUI();
  installMidiUI();
  wireLegend();
  wireMonitor();
  wireAbout();
  wireAuth();
  installDismiss('[data-menu],#zoomBtn,#timeSigBtn,#langBtn,#coworkBtn');

  // seed first document and paint the empty staff
  seedFirstDoc();
  render();
  buildTabs();
  updateUndoButtons();
  initUpdater();
  initNetworkIndicator();
  initFileLoader();
  initTitleEditor();
  // Last, and not awaited: see the note on initAccount().
  initAccount();
}

init();
