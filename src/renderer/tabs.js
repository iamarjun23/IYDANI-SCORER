// Document tabs across the top of the editor. Each tab holds a snapshot
// of (notes, bars, title, preset, tala) and is swapped in/out of `state`.

import { BPM } from './config.js';
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
    file: state.file,
    preset: state.preset,
    tala: state.tala,
    bpm: state.bpm,
  };
}

// What a tab is called: the file it was saved or opened as, else its title.
export function tabLabel(d) {
  return d.file || d.title || 'Untitled';
}

// The Save dialog's answer, reported back by the main process. Exports come
// through the same channel and are not the document, so only a .json counts.
export function onFileSaved(name) {
  if (!/\.json$/i.test(name)) return;
  state.file = name.replace(/\.(dng\.)?json$/i, '');
  saveDoc();
  buildTabs();
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
  state.file = d.file || '';
  state.preset = d.preset;
  state.tala = d.tala;
  state.bpm = d.bpm || BPM;
  state.hist = [];
  state.future = [];
  // A lesson belongs to the tab it was opened in; cowork.js sets it again
  // after loading the lesson's own tab.
  if (state.lesson) { state.lesson = null; document.dispatchEvent(new Event('lesson:changed')); }
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
  docs.push({ notes: [], bars: [], breaks: [], lastBreak: null, title: 'Untitled', preset: null, tala: state.tala, bpm: BPM });
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
      <span></span>
      ${docs.length > 1 ? `<span class="x" data-close="${i}">×</span>` : ''}
    </div>`).join('') + `<div class="tab add" id="addTab">+ New</div>`;

  t.querySelectorAll('.tab[data-i]').forEach(el => {
    // A file name and a title are somebody else's text: set, never interpolated.
    el.firstElementChild.textContent = tabLabel(docs[+el.dataset.i]);
    el.addEventListener('click', e => {
      if (e.target.dataset.close != null) {
        e.stopPropagation();
        closeDoc(+e.target.dataset.close);
        return;
      }
      saveDoc();
      loadDoc(+el.dataset.i);
    });
  });

  document.getElementById('addTab').addEventListener('click', newDoc);
}

// ---------- autosave ----------
//
// Every open tab, written to localStorage a moment after the score last
// changed and again as the window closes, and put back at the next launch.
// There was no recovery at all before this: a crash, or a window closed by
// habit, took everything not yet saved to a file. It is a safety net and not
// the save format — the .dng.json is still what a score is kept and shared as.
const AUTOSAVE_KEY = 'dng.autosave.v1';

export function autosaveNow() {
  saveDoc();
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({
      docs, active: getActiveDoc(), saMidi: state.saMidi,
    }));
  } catch {
    // Storage full or blocked. The session is simply not recoverable; failing
    // the edit that triggered this would be worse.
  }
}

// Put the last session back. False — and nothing touched — when there is none
// or it does not have the shape of one, so the caller seeds a blank document.
export function restoreDocs() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(AUTOSAVE_KEY)); } catch { return false; }
  const ok = saved && Array.isArray(saved.docs) && saved.docs.length
    && saved.docs.every(d => d && Array.isArray(d.notes) && Array.isArray(d.bars));
  if (!ok) return false;
  docs.length = 0;
  docs.push(...saved.docs);
  state.saMidi = Number(saved.saMidi) || 60;
  loadDoc(Math.max(0, Math.min(docs.length - 1, Number(saved.active) || 0)));
  return true;
}

export function initAutosave() {
  let timer = null;
  // render() also runs on every beat of playback, so this is debounced: nothing
  // is written until the score has been still for a moment.
  document.addEventListener('score:rendered', () => {
    clearTimeout(timer);
    timer = setTimeout(autosaveNow, 800);
  });
  window.addEventListener('beforeunload', autosaveNow);
}
