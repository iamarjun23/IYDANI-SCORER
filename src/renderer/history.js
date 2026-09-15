// Undo / redo stack. We snapshot the score (notes + bars) as a JSON string
// after each user action and replay snapshots on undo / redo.

import { state, snapshot } from './state.js';
import { MAX_HIST } from './config.js';
import { render } from './notation.js';

function updateUndoButtons() {
  const undoBtn = document.getElementById('bUndo');
  const redoBtn = document.getElementById('bRedo');
  if (undoBtn) undoBtn.disabled = !state.hist.length;
  if (redoBtn) redoBtn.disabled = !state.future.length;
}

// Save current snapshot to history. Call BEFORE mutating the score.
export function pushHist() {
  state.hist.push(snapshot());
  if (state.hist.length > MAX_HIST) state.hist.shift();
  state.future = [];
  updateUndoButtons();
}

function restore(str) {
  const o = JSON.parse(str);
  state.notes = o.notes;
  state.bars  = o.bars;
  // Older snapshots predate manual breaks; treat them as unbroken.
  state.breaks = o.breaks || [];
  // The pointer at the break last worked on travels with them, so undoing a
  // move marks the division the break went back to rather than the one it
  // was dragged from. Older snapshots have none; render() drops a pointer
  // that names no break anyway.
  state.lastBreak = o.lastBreak ?? null;
  // ...and predate the metre being real. Leaving the current one alone is the
  // only safe reading: an undefined key would fall back to CHATUSRA and
  // silently re-bar the score.
  if (o.tala) {
    state.tala = o.tala;
    document.dispatchEvent(new Event('tala:changed'));
  }
  render();
  updateUndoButtons();
}

export function undo() {
  if (!state.hist.length) return;
  state.future.push(snapshot());
  restore(state.hist.pop());
}

export function redo() {
  if (!state.future.length) return;
  state.hist.push(snapshot());
  restore(state.future.pop());
}

export { updateUndoButtons };
