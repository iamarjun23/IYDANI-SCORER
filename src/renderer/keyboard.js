// Global keydown handler. Three letter rows are the three sthayis — QWERTYU
// taara, ASDFGHJ madhya, ZXCVBNM mandra — each reading S R G M P D N across.
// A plain key writes THE SCALE'S OWN svara and Shift writes its alternate; see
// SVARA_TONES and SVARAS in config.js. , / . shift the octave UI, Backspace
// deletes the last note, Space plays, Ctrl+Z/Y undo/redo.
//
// Which key writes which svara is NOT read from config any more — those three
// rows are only the default. lookupKey() in keybinds.js is the live answer, so
// a rebound keyboard takes effect here with nothing to rebuild.

import { SVARA_TONES, SVARAS, semiOf } from './config.js';
import { lookupKey } from './keybinds.js';
import { isCapturing } from './keymap.js';
import { state } from './state.js';
import {
  addNote, beginMetronomeEntry, closeMetronomeSilence, deleteLast, endMetronomeEntry,
  startHoldPromotion,
} from './score.js';
import { deleteSelectedBar } from './repeats.js';
import { freqOf, startSustain, stopSustain } from './audio.js';
import { undo, redo } from './history.js';
import { togglePlay, playPart } from './playback.js';
import { setOct } from './piano.js';
import { newDoc } from './tabs.js';
import { downloadJSON } from './io.js';
import { openVarasePop, setZoom } from './menus.js';

function flash(el) {
  if (!el) return;
  el.classList.add('down');
  setTimeout(() => el.classList.remove('down'), 130);
}

export function installKeyboard() {
  const heldVoices = new Map();

  document.addEventListener('keydown', e => {
    if (e.repeat) return;
    // A slot on the key map is waiting for a keystroke: that keystroke is the
    // binding, not a note.
    if (isCapturing()) return;
    const k = e.key.toLowerCase();

    // shortcuts
    if (e.ctrlKey || e.metaKey) {
      if (k === 'z') { e.preventDefault(); return undo(); }
      if (k === 'y') { e.preventDefault(); return redo(); }
      if (k === 'n') { e.preventDefault(); return newDoc(); }
      if (k === 's') { e.preventDefault(); return downloadJSON(); }
      if (k === 'o') { e.preventDefault(); return openVarasePop(); }
      if (k === '=' || k === '+') { e.preventDefault(); return setZoom(state.zoom + 0.1); }
      if (k === '-') { e.preventDefault(); return setZoom(state.zoom - 0.1); }
      if (k === '0') { e.preventDefault(); return setZoom(1); }
      return;
    }

    // svara keys. A plain key writes the svara THE SCALE HAS, and Shift writes
    // the other one. Sa and Pa have no alternate, so Shift on those does
    // nothing rather than writing the same note again.
    //
    // This used to be "plain = hollow, Shift = filled", which is right for
    // five of the seven and backwards for the other two. The app's scale is
    // Mayamalavagowla — S R1 G3 M1 P D1 N3 — and Ri and Da are the only svaras
    // it takes the LOWERED form of, which is why SVARAS marks exactly those
    // two `filled: true`. Ga, Ma and Ni take their hollow form, so plain-is-
    // hollow happened to be right for them. For Ri and Da it meant the plain
    // key wrote R2 and D2 while Shift wrote R1 and D1 — the two interchanged
    // against every other key on the row, and against the scale the file
    // itself is saved as. On the madhya home row (ASDFGHJ) that is the first
    // thing a player meets.
    //
    // Typing a note is the *keyboard* input path, so the letters only write
    // in Keyboard mode. In Piano and MIDI mode they are inert — the map that
    // documents them is not even on screen there, and a stray keystroke while
    // clicking keys or playing a device should not land a note on the staff.
    const m = state.mode === 'keyboard' ? lookupKey(k) : null;
    if (m) {
      const tone = SVARA_TONES[m.idx];
      if (e.shiftKey && tone.variant == null) { e.preventDefault(); return; }
      // The notehead the scale writes this svara with, and its opposite.
      const scaleFilled = !!SVARAS[m.idx].filled;
      const head = (e.shiftKey ? !scaleFilled : scaleFilled) ? 'f' : 'o';

      const selectedSym = state.sym;
      // Keep the sthayi selector in step with the row being typed on, so the
      // piano and the status line agree with what is being written.
      if (state.oct !== m.oct) setOct(m.oct);

      // Sound FIRST: the key is heard the instant it goes down, and the
      // score catches up on the next frame.
      const voice = startSustain(freqOf(semiOf(m.idx, head), m.oct));
      closeMetronomeSilence();
      const noteIndex = addNote(m.idx, {
        playSound: false,
        sym: selectedSym,
        head,
        oct: m.oct,
      });
      // null: the tone is switched off in the legend — sounded, nothing written.
      const written = noteIndex != null;
      if (written) beginMetronomeEntry();
      heldVoices.set(e.code, {
        voice,
        stopPromotion: written ? startHoldPromotion(noteIndex, selectedSym) : () => {},
        noteIndex,
        written,
      });
      flash(document.querySelector(`.kcap[data-key="${k}"]`));
      flash(document.querySelector(`.wkey[data-svi="${m.idx}"][data-ko="0"]`));
      e.preventDefault();
      return;
    }

    // octave shifts
    if (k === ',') { flash(document.querySelector('.kcap[data-key=","]')); return setOct(state.oct - 1); }
    if (k === '.') { flash(document.querySelector('.kcap[data-key="."]')); return setOct(state.oct + 1); }

    // edit / transport
    // Delete belongs to the SELECTED repeat mark when there is one — which is
    // why a brace has to be clicked before the key removes it. With nothing
    // selected, Backspace still deletes the last note exactly as before.
    if (k === 'delete' || k === 'backspace') {
      if (deleteSelectedBar()) { e.preventDefault(); return; }
    }
    if (k === 'backspace') { deleteLast(); e.preventDefault(); return; }
    if (k === ' ')         { (e.shiftKey ? playPart : togglePlay)(); e.preventDefault(); return; }
  });

  document.addEventListener('keyup', e => {
    const held = heldVoices.get(e.code);
    if (!held) return;
    heldVoices.delete(e.code);
    held.stopPromotion();
    if (held.written) endMetronomeEntry();
    stopSustain(held.voice);
  });

  window.addEventListener('blur', () => {
    heldVoices.forEach(held => {
      held.stopPromotion();
      if (held.written) endMetronomeEntry();
      stopSustain(held.voice);
    });
    heldVoices.clear();
  });
}
