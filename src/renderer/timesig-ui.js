// The time-signature picker and its editor dialog.
//
// The picker hangs off the T.S. button in the toolbar and lists every metre —
// the five builtins first, then the ones you have made. A custom row carries
// its own edit and delete controls; a builtin does not, because saved files
// name those by key and deleting one would break them.
//
// The dialog is the legend's scrim/card again rather than a third modal idiom.
// It asks for two things: a NAME, and the division written as its groups. The
// formula is the whole definition — the sum is how many beats a division
// holds, the interior edges are the lighter dividers drawn inside it and the
// beats the metronome accents. There is no lower number to choose; see the
// note at the top of timesig.js.
//
// Nothing here decides what a metre means — timesig.js does. This module only
// collects the two fields, reports what the formula parses to, and re-renders.

import { state } from './state.js';
import { show, hide, pop } from './popover.js';
import { render } from './notation.js';
import { pushHist } from './history.js';
import {
  allTalas, talaDef, parseFormula, formulaError, beatsOf, formulaOf,
  addTala, updateTala, removeTala, isCustom,
} from './timesig.js';

// The formula is always TYPED in one symbol at a time (the tsUnit picker),
// but always STORED in beats — parseFormula() does that conversion, so the
// only place the unit matters is reading the field and reporting on it.
function currentUnit() {
  const sel = el('tsUnit');
  return sel ? sel.value : 'bindu';
}

// Which custom metre the dialog is editing, or null when it is making a new
// one. The dialog is modal, so one variable is the whole of its state.
let editing = null;

function el(id) { return document.getElementById(id); }

export function setTala(key) {
  if (!allTalas()[key]) return;
  // The metre re-bars the whole score, so switching it is an edit in its own
  // right — snapshot first, or undo would revert it only as a side effect of
  // whatever note change happened to be underneath.
  if (state.tala !== key) pushHist();
  state.tala = key;
  // Everything that shows the metre — the T.S. field on the sheet, the row
  // packing, the metronome accent — comes out of the same render pass and the
  // one event menus.js already listens for.
  document.dispatchEvent(new Event('tala:changed'));
  render();
}

// ---- picker --------------------------------------------------------------

function rowHtml(def) {
  const sel = state.tala === def.key ? ' sel' : '';
  const tools = def.custom
    ? `<span class="ts-tools">`
      + `<button class="ts-mini" data-edit="${def.key}" title="Edit ${def.label}">✎</button>`
      + `<button class="ts-mini" data-del="${def.key}" title="Delete ${def.label}">✕</button>`
      + `</span>`
    : '';
  // The formula is shown beside the name, and the beat count after it, so the
  // list says both what the metre is called and how long a division is.
  return `<div class="it ts-it${sel}" data-t="${def.key}">${def.label}`
    + `<span class="sc">${def.formula} · ${def.beats}/4</span>${tools}</div>`;
}

export function openTimeSigPicker() {
  const anchor = el('timeSigBtn');
  const defs = Object.values(allTalas());
  const html = '<div class="ttl">Time Signature</div>'
    + defs.map(rowHtml).join('')
    + '<div class="hr"></div>'
    + '<div class="it" data-tsnew="1">＋ New time signature…</div>';
  show(html, anchor, 'right');

  pop().querySelectorAll('[data-t]').forEach(item =>
    item.addEventListener('click', e => {
      // The edit and delete controls sit inside the row; a click on one of
      // them is not a click on the row.
      if (e.target.closest('[data-edit],[data-del]')) return;
      setTala(item.dataset.t);
      hide();
    }),
  );

  pop().querySelectorAll('[data-edit]').forEach(b =>
    b.addEventListener('click', () => { hide(); openTimeSigDialog(b.dataset.edit); }),
  );

  pop().querySelectorAll('[data-del]').forEach(b =>
    b.addEventListener('click', () => {
      const key = b.dataset.del;
      const def = talaDef(key);
      // A score already written in this metre keeps its own copy in the file,
      // so deleting here only takes it off the list.
      if (!confirm(`Delete the time signature "${def.label}" (${def.formula})?`)) return;
      const wasCurrent = state.tala === key;
      removeTala(key);
      hide();
      if (wasCurrent) setTala(state.tala);
      else render();
    }),
  );

  pop().querySelectorAll('[data-tsnew]').forEach(b =>
    b.addEventListener('click', () => { hide(); openTimeSigDialog(null); }),
  );
}

// ---- dialog --------------------------------------------------------------

// The beats a cycle accents, counted from 1 the way a player counts them —
// `[4,2]` is heard as 1 and 5. groupEdges() answers the same question from 0
// for the staff's group lines; this is that answer said out loud.
function accentBeats(groups) {
  const out = [];
  let at = 1;
  for (const g of groups) { out.push(at); at += g; }
  return out;
}

// What the two fields currently add up to, or why they do not parse. Shown
// live under the inputs so a bad formula is caught before Save, not after.
function updatePreview() {
  const out = el('tsPreview');
  const save = el('tsSave');
  if (!out) return;
  const text = el('tsFormula').value;
  const unit = currentUnit();
  const groups = parseFormula(text, unit);
  if (!groups) {
    out.className = 'ts-preview bad';
    // timesig.js says WHY, so the dialog cannot describe a rule the parser
    // does not enforce — `6/8` gets its own sentence rather than the generic
    // hint, which reads as if the whole line were gibberish.
    out.textContent = formulaError(text, unit);
    if (save) save.disabled = true;
    return;
  }
  const beats = beatsOf(groups);
  const edges = groups.length > 1
    ? ` · group edges after beat ${groups.slice(0, -1)
        .reduce((acc, g) => { acc.push((acc.length ? acc[acc.length - 1] : 0) + g); return acc; }, [])
        .join(', ')}`
    : ' · no interior groups';
  out.className = 'ts-preview';
  // Say the click count outright: this sentence is the only place before you
  // press Save that tells you how many times the metronome will tick, and how
  // the formula will be heard.
  const beat1 = accentBeats(groups);
  out.textContent = `${beats}/4 — a division holds ${beats} beat${beats === 1 ? '' : 's'}`
    + ` as ${formulaOf(groups)}${edges}. The metronome ticks ${beats} times a cycle,`
    + ` accented on beat${beat1.length === 1 ? '' : 's'} ${beat1.join(', ')}.`;
  if (save) save.disabled = false;
}

export function openTimeSigDialog(key) {
  const overlay = el('tsOverlay');
  if (!overlay) return;
  editing = key && isCustom(key) ? key : null;
  const def = editing ? talaDef(editing) : null;
  el('tsDlgTitle').textContent = editing ? 'Edit Time Signature' : 'New Time Signature';
  el('tsName').value = def ? def.label : '';
  el('tsFormula').value = def ? def.formula : '';
  // The stored formula is always beats, so re-opening one for editing shows
  // it in bindu regardless of what unit it was originally typed in — there
  // is nothing that remembers that choice, and beats is the unit it will
  // read back correctly in.
  el('tsUnit').value = 'bindu';
  el('tsDelete').hidden = !editing;
  updatePreview();
  overlay.hidden = false;
  el('tsName').focus();
}

export function closeTimeSigDialog() {
  const overlay = el('tsOverlay');
  if (overlay) overlay.hidden = true;
  editing = null;
}

function commit() {
  const label = el('tsName').value.trim();
  const unit = currentUnit();
  const groups = parseFormula(el('tsFormula').value, unit);
  if (!groups) { updatePreview(); return; }
  // addTala/updateTala — and the registry they write to — only ever store a
  // formula in beats, same as a saved file: convert here, once, rather than
  // teaching the registry a unit it would then have to persist and reload.
  const formula = formulaOf(groups);
  const key = editing
    ? updateTala(editing, { label, formula })
    : addTala({ label, formula });
  if (!key) { updatePreview(); return; }
  closeTimeSigDialog();
  // Making one selects it; editing the one in use re-lays the score under it.
  setTala(key);
}

export function wireTimeSigDialog() {
  const overlay = el('tsOverlay');
  if (!overlay) return;

  el('tsClose').addEventListener('click', closeTimeSigDialog);
  el('tsCancel').addEventListener('click', closeTimeSigDialog);
  el('tsSave').addEventListener('click', commit);
  el('tsDelete').addEventListener('click', () => {
    const key = editing;
    if (!key) return;
    const def = talaDef(key);
    if (!confirm(`Delete the time signature "${def.label}" (${def.formula})?`)) return;
    const wasCurrent = state.tala === key;
    removeTala(key);
    closeTimeSigDialog();
    if (wasCurrent) setTala(state.tala);
    else render();
  });

  ['tsName', 'tsFormula'].forEach(id =>
    el(id).addEventListener('input', updatePreview));
  el('tsUnit').addEventListener('change', updatePreview);

  // Clicking the scrim closes; clicking the card does not.
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) closeTimeSigDialog(); });

  // Captured on the way DOWN, like the About and key-binding dialogs: the
  // dialog is modal, so typing into it must not also write notes onto the
  // staff behind it. Enter commits, which is what a two-field form should do.
  document.addEventListener('keydown', e => {
    if (overlay.hidden) return;
    if (e.key === 'Escape') closeTimeSigDialog();
    else if (e.key === 'Enter') commit();
    e.stopPropagation();
  }, true);
}
