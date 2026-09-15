// Document tabs across the top of the editor. Each tab holds a snapshot
// of (notes, bars, title, preset, tala) and is swapped in/out of `state`.

import { state, docs, getActiveDoc, setActiveDoc } from './state.js';
import { updateUndoButtons } from './history.js';
import { render } from './notation.js';

export function saveDoc() {
  docs[getActiveDoc()] = {
    notes: state.notes,
    bars: state.bars,
    breaks: state.breaks,
    // Which break the user was last working on — a box ordinal is only
    // meaningful against the document it was counted in, so it is stored per
    // tab rather than left standing when another document is swapped in.
    lastBreak: state.lastBreak,
    title: state.title,
    preset: state.preset,
    tala: state.tala,
    bpm: state.bpm,
  };
}

function updateTalaLine() {
  // tala.js would be overkill; the line is updated wherever tala changes.
}

export function loadDoc(i) {
  setActiveDoc(i);
  const d = docs[i];
  state.notes = d.notes;
  state.bars = d.bars;
  state.breaks = d.breaks || [];
  state.lastBreak = d.lastBreak ?? null;
  state.title = d.title;
  state.preset = d.preset;
  state.tala = d.tala;
  state.bpm = d.bpm || 72;
  state.hist = [];
  state.future = [];
  updateUndoButtons();
  document.getElementById('titleVal').textContent = state.title;
  document.getElementById('bpmVal').value = state.bpm;
  // tala line is refreshed via the same render path
  const ev = new Event('tala:changed');
  document.dispatchEvent(ev);
  render();
  buildTabs();
}

export function newDoc() {
  saveDoc();
  docs.push({ notes: [], bars: [], breaks: [], lastBreak: null, title: 'Untitled', preset: null, tala: state.tala, bpm: 72 });
  loadDoc(docs.length - 1);
}

export function closeDoc(i) {
  docs.splice(i, 1);
  let a = getActiveDoc();
  if (a >= docs.length) a = docs.length - 1;
  loadDoc(a);
}

export function buildTabs() {
  const t = document.getElementById('tabs');
  const a = getActiveDoc();
  t.innerHTML = docs.map((d, i) =>
    `<div class="tab ${i === a ? 'active' : ''}" data-i="${i}">
      <span>${d.title || 'Untitled'}</span>
      ${docs.length > 1 ? `<span class="x" data-close="${i}">×</span>` : ''}
    </div>`).join('') + `<div class="tab add" id="addTab">+ New</div>`;

  t.querySelectorAll('.tab[data-i]').forEach(el =>
    el.addEventListener('click', e => {
      if (e.target.dataset.close != null) {
        e.stopPropagation();
        closeDoc(+e.target.dataset.close);
        return;
      }
      saveDoc();
      loadDoc(+el.dataset.i);
    }),
  );

  document.getElementById('addTab').addEventListener('click', newDoc);
}
