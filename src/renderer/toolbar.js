// Top toolbar buttons. Most are thin wrappers around functions exported by
// other modules; we keep all the DOM listeners in one place.

import { state } from './state.js';
import { MIN_BPM, MAX_BPM } from './config.js';
import { undo, redo } from './history.js';
import { clearAll } from './score.js';
import { downloadJSON, exportSVG } from './io.js';
import { togglePlay, stopPlay } from './playback.js';
import { render, updateSheetMeta } from './notation.js';
import { newDoc } from './tabs.js';
import { openVarasePop } from './menus.js';
import { setOct } from './piano.js';
import { buildPiano } from './piano.js';
import { buildKeyMap } from './keymap.js';
import { toggleMetronome, installMetronomeSounds } from './metronome.js';
import { exportPDF } from './pdf.js';
import { exportMP3 } from './mp3.js';
import { exportMIDI } from './midi-export.js';
import { refreshMidiStatus } from './midi-input.js';
import { setSetting } from './settings.js';

function setMode(mode) {
  const was = state.mode;
  state.mode = mode;
  document.querySelectorAll('#inputModes .pillbtn').forEach(x =>
    x.classList.toggle('on', x.dataset.mode === mode),
  );
  const kb = document.querySelector('.kbmap');
  const pw = document.querySelector('.piano-wrap');
  const sp = document.getElementById('pianoSpan');
  const mk = document.getElementById('midiKeys');
  const st = document.getElementById('statusText');

  // The QWERTY map documents the *keyboard* input path, so it belongs to
  // Keyboard mode only. Piano and MIDI mode give the dock's whole width to
  // the on-screen keys instead.
  if (mode === 'keyboard') {
    kb.style.display = '';
    kb.style.flex = '1';
    kb.style.width = 'auto';
    pw.style.display = 'none';
    if (sp) sp.hidden = true;
    if (mk) mk.hidden = true;
    st.textContent = 'Row = sthayi · ⇧ = variant — see the map below';
  } else if (mode === 'midi') {
    kb.style.display = 'none';
    pw.style.display = '';
    // MIDI mode draws the CONNECTED keyboard, so the span picker (which sizes
    // the app's own piano) gives way to the device's key count.
    if (sp) sp.hidden = true;
    if (mk) mk.hidden = false;
    // Whatever the device layer knows — connected, none found, refused. The
    // pill must not claim to be listening when nothing is bound.
    refreshMidiStatus();
  } else {
    kb.style.display = 'none';
    pw.style.display = '';
    if (sp) sp.hidden = false;
    if (mk) mk.hidden = true;
    refreshMidiStatus();
  }

  // Piano and MIDI mode draw different keyboards out of the same element.
  if (was !== mode && mode !== 'keyboard') buildPiano();
}

// 'auto' pads every box at render time; 'metro' leaves the gaps for the
// metronome to write real rests into. The score re-renders either way, since
// the pad rests appear or vanish immediately.
function setFill(fill) {
  state.fill = fill;
  document.querySelectorAll('#fillModes .pillbtn').forEach(x =>
    x.classList.toggle('on', x.dataset.fill === fill),
  );
  render();
}

function setSys(sys) {
  state.sys = sys;
  document.querySelectorAll('#notationSys .pillbtn').forEach(x =>
    x.classList.toggle('on', x.dataset.sys === sys),
  );
  buildPiano();
  buildKeyMap();
}

function setBpm(v) {
  const clamped = Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(v) || state.bpm));
  state.bpm = clamped;
  document.getElementById('bpmVal').value = clamped;
  // The sheet prints the tempo, and changing it does not redraw the score.
  updateSheetMeta();
}

// A4 pages, broken where the PDF breaks them, or one continuous strip. The
// layout itself is render()'s — see pageLayout() in notation.js.
function togglePageView() {
  setSetting('pageView', !state.pageView);
  document.getElementById('pageViewBtn').classList.toggle('on', state.pageView);
  render();
}

// The ▲■▼ sthayi key beside each row, on or off. Screen only and
// not remembered: it is a class on the sheet, which render() never rewrites.
function toggleGutter() {
  const off = document.querySelector('.sheet').classList.toggle('nogutter');
  document.getElementById('gutterBtn').classList.toggle('on', !off);
}

export function wireToolbar() {
  document.getElementById('bNew').addEventListener('click', newDoc);
  document.getElementById('bOpen').addEventListener('click', openVarasePop);
  document.getElementById('bSave').addEventListener('click', downloadJSON);
  document.getElementById('bUndo').addEventListener('click', undo);
  document.getElementById('bRedo').addEventListener('click', redo);
  document.getElementById('bClear').addEventListener('click', clearAll);
  document.getElementById('bExport').addEventListener('click', exportSVG);
  document.getElementById('bPdf').addEventListener('click', exportPDF);
  document.getElementById('bMp3').addEventListener('click', exportMP3);
  document.getElementById('bMidi').addEventListener('click', exportMIDI);
  document.getElementById('metroBtn').addEventListener('click', toggleMetronome);
  installMetronomeSounds();
  document.getElementById('pageViewBtn').addEventListener('click', togglePageView);
  document.getElementById('pageViewBtn').classList.toggle('on', state.pageView);
  document.getElementById('gutterBtn').addEventListener('click', toggleGutter);

  document.getElementById('playBtn').addEventListener('click', togglePlay);
  document.getElementById('bStop').addEventListener('click', stopPlay);
  document.getElementById('bStart').addEventListener('click', stopPlay);

  document.getElementById('inputModes').addEventListener('click', e => {
    const b = e.target.closest('.pillbtn');
    if (b) setMode(b.dataset.mode);
  });

  document.getElementById('fillModes').addEventListener('click', e => {
    const b = e.target.closest('.pillbtn');
    if (b) setFill(b.dataset.fill);
  });

  document.getElementById('notationSys').addEventListener('click', e => {
    const b = e.target.closest('.pillbtn');
    if (b) setSys(b.dataset.sys);
  });

  // octave changes coming from the sidebar grid
  document.addEventListener('oct:set', e => setOct(e.detail));

  // tempo control
  const bpmInput = document.getElementById('bpmVal');
  bpmInput.value = state.bpm;
  document.getElementById('bpmDown').addEventListener('click', () => setBpm(state.bpm - 1));
  document.getElementById('bpmUp').addEventListener('click', () => setBpm(state.bpm + 1));
  bpmInput.addEventListener('change', () => setBpm(+bpmInput.value));
  // The tempo of a keyboard we are FOLLOWING — see midi-clock.js. It arrives
  // by event rather than by call because toolbar.js already imports
  // midi-input.js (refreshMidiStatus, above), and the two importing each other
  // is the same cycle piano.js and midi-input.js avoid the same way. It goes
  // through setBpm() like every other tempo change, so the field, the clamp
  // and the printed sheet header cannot disagree with the transport.
  document.addEventListener('tempo:external', e => setBpm(e.detail?.bpm));

  // The dock's markup is written for one mode; run the mode switch once at
  // startup so what is on screen matches state.mode instead of the markup.
  setMode(state.mode);
}
