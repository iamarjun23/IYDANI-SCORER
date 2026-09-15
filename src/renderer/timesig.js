// The metre. One place answers "how big is a division", and everything that
// used to read the BOX_CAPACITY constant now reads it here: box packing, the
// metronome accent, the note inspector's box-fill line, and the T.S. printed
// on the sheet and in the PDF.
//
// A time signature is a NAME plus an additive formula — `3+2+2` is seven
// beats grouped three-two-two. The sum is the division's capacity; the
// interior group edges are the lighter dividers inside it and the beats the
// metronome accents, so `4+2` is six clicks with the loud one on 1 and 5. The
// denominator is not a field: every SOUND duration in config.js is expressed
// in beats against TIME_UNITS_PER_BEAT, so a bindu is one beat by definition
// and a denominator would rename the unit without changing a single number.
// T.S. therefore always prints over 4 — and `6/4` is accepted as a way of
// WRITING the metre, meaning one group of six, because that is how it is
// printed back. A denominator other than 4 is refused rather than rounded to
// one, since printing back a metre nobody typed is worse than saying no.
//
// The four Carnatic talas plus CHATUSRA are builtins and cannot be edited or
// deleted — saved documents name them by key, so removing one would break
// files already written. Custom entries are stored twice on purpose: in
// localStorage so they survive a relaunch, and inside the saved .json so a
// score carries its own metre to a machine that has never seen it.
//
// Pure apart from the two storage calls, which are guarded the same way
// keybinds.js guards its own — the Node tests import this module and have no
// localStorage at all.

import { state } from './state.js';
import {
  TALAS, BOX_CAPACITY, TIME_UNITS_PER_BEAT, MAX_TS_BEATS, MAX_TS_GROUPS, SOUND,
  BOXES_PER_ROW, USABLE_W, MIN_BEAT_W,
} from './config.js';

const STORE_KEY = 'dng.timesig.v1';

// key -> definition, for user-made metres only. Builtins are never in here.
let customs = {};

// ---- parsing -------------------------------------------------------------

// The denominator this app counts in, and the only one a formula may name.
// See the note at the top: every SOUND duration is expressed in beats, so a
// bindu is one beat by definition and T.S. always prints over 4. Accepting
// `6/8` would mean printing it back as `6/4`, which is a metre the user did
// not type — so it is refused with a reason instead.
export const TS_DENOM = 4;

// Which symbol a formula's numbers are counted in. A group is always stored
// and printed as BEATS — a bindu is one beat by definition, see above — but
// typing the box you want is easier in whatever symbol you're about to write
// there, so the dialog offers a unit picker and this table is the only place
// that says how many beats each one is worth. Values come straight off
// SOUND so this can never drift from what the symbol actually plays as.
export const TS_UNITS = ['bindu', 'vasu', 'praya', 'danta'];
export function unitBeats(unit) {
  return SOUND[unit] ? SOUND[unit].dur : 1;
}

// '3+2+2' -> [3,2,2]. Spaces, commas and hyphens are accepted as separators
// because people type all three; anything else, a zero, a fraction or a sum
// past the sanity bound gives null, which is what the dialog reports as an
// invalid formula rather than silently writing a metre nobody asked for.
//
// A conventional time signature is accepted as well — `6/4` is the same metre
// as `6`, one group of six beats — because that is how most people write one
// down, and the T.S. field on the sheet prints it back in exactly that form.
// The denominator carries no information here, so it is checked rather than
// read: only /4 is a metre, and anything else is an error with a sentence.
// A trailing `/4` is only meaningful in bindu — the unit picker already says
// what a bare number counts, so `6/4` under a different unit is refused
// rather than silently reinterpreted.
//
// `unit` (default 'bindu') is what each number COUNTS IN. Every group is
// converted to beats via `unitBeats(unit)` before anything downstream ever
// sees it, so groupEdges/accents/box-capacity stay in beats unchanged — the
// unit is purely how you'd rather type the box, not a second stored form. A
// count that doesn't land on a whole beat (5 dantas, say) is refused: this
// app only accents on whole-beat edges, so a fractional beat has nowhere to
// go.
export function parseFormula(text, unit = 'bindu') {
  let raw = String(text == null ? '' : text).trim();
  if (!raw) return null;
  const over = raw.match(/\/\s*(\d+)\s*$/);
  if (over) {
    if (unit !== 'bindu' || Number(over[1]) !== TS_DENOM) return null;
    raw = raw.slice(0, over.index).trim();
    if (!raw) return null;
  }
  const parts = raw.split(/[+,\-\s]+/).filter(Boolean);
  if (!parts.length || parts.length > MAX_TS_GROUPS) return null;
  const factor = unitBeats(unit);
  const groups = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (!Number.isInteger(n) || n < 1) return null;
    const beats = n * factor;
    if (!Number.isInteger(beats) || beats < 1) return null;
    groups.push(beats);
  }
  const beats = groups.reduce((a, b) => a + b, 0);
  if (beats < 1 || beats > MAX_TS_BEATS) return null;
  return groups;
}

export function formulaOf(groups) {
  return (groups || []).join('+');
}

export function beatsOf(groups) {
  return (groups || []).reduce((a, b) => a + b, 0);
}

// Why a formula did not parse, as a sentence for the dialog, or null when it
// did. It lives here rather than in the dialog so the rules are stated once —
// a second copy of "only /4" in the UI would be free to drift from the one
// parseFormula() actually enforces.
export function formulaError(text, unit = 'bindu') {
  const raw = String(text == null ? '' : text).trim();
  const uLabel = unit === 'bindu' ? 'beats' : `${unit}s`;
  if (!raw) {
    return unit === 'bindu'
      ? 'Write the division as beats joined by + (3+2+2), or as a time signature (6/4).'
      : `Write the division as ${uLabel} joined by + (e.g. 3+2+2).`;
  }
  const over = raw.match(/\/\s*(\d+)\s*$/);
  if (over) {
    if (unit !== 'bindu') {
      return `A "/${over[1]}" only makes sense counting in bindu — switch the unit to`
        + ` bindu, or drop the /${over[1]} and write the count in ${uLabel}.`;
    }
    if (Number(over[1]) !== TS_DENOM) {
      return `Only /${TS_DENOM} is supported — every duration here is counted in beats.`
        + ` Write ${raw.slice(0, over.index).trim() || '6'}/${TS_DENOM}, or the groups as 3+2+2.`;
    }
  }
  if (parseFormula(raw, unit)) return null;
  if (unit !== 'bindu') {
    const factor = unitBeats(unit);
    const perBeat = Math.round(1 / factor);
    return `Each group must land on a whole beat — a beat is ${perBeat} ${unit}${perBeat === 1 ? '' : 's'},`
      + ` so write ${uLabel} in multiples of ${perBeat} (e.g. ${perBeat}+${perBeat}+${perBeat}).`;
  }
  return `Write the division as whole numbers joined by + (3+2+2), or as a time`
    + ` signature over ${TS_DENOM} (6/${TS_DENOM}). At most ${MAX_TS_BEATS} beats.`;
}

// Accept a definition from anywhere — the registry, localStorage, a loaded
// document — and give back a complete one, or null if it cannot be trusted.
// The formula is the source of truth: `beats` is always recomputed from it, so
// a hand-edited file cannot claim a length its own groups do not add up to.
export function normaliseTala(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const groups = Array.isArray(raw.groups) && raw.groups.length
    ? parseFormula(formulaOf(raw.groups))
    : parseFormula(raw.formula);
  if (!groups) return null;
  const key = String(raw.key || '').trim();
  const label = String(raw.label || '').trim() || formulaOf(groups);
  return {
    key: key || null,
    label,
    formula: formulaOf(groups),
    beats: beatsOf(groups),
    groups,
    custom: true,
  };
}

// ---- the registry --------------------------------------------------------

export function isBuiltin(key) {
  return Object.prototype.hasOwnProperty.call(TALAS, key);
}

export function isCustom(key) {
  return Object.prototype.hasOwnProperty.call(customs, key);
}

// Builtins first, in their declared order, then customs in creation order.
export function allTalas() {
  const out = {};
  for (const k of Object.keys(TALAS)) out[k] = { ...TALAS[k], key: k, custom: false };
  for (const k of Object.keys(customs)) out[k] = { ...customs[k], key: k, custom: true };
  return out;
}

export function talaDef(key) {
  const all = allTalas();
  return all[key] || all.chatusra || {
    key: 'chatusra', label: 'CHATUSRA', formula: String(BOX_CAPACITY),
    beats: BOX_CAPACITY, groups: [BOX_CAPACITY], custom: false,
  };
}

export function currentTala() {
  return talaDef(state.tala);
}

// What every consumer actually wants.
export function beatsPerBox() {
  return currentTala().beats;
}

export function boxUnits() {
  return beatsPerBox() * TIME_UNITS_PER_BEAT;
}

// How many divisions a row of the staff holds under this metre.
//
// It used to be four, always. That reads as an equal grid and is one under
// CHATUSRA, but a division holds one CYCLE, so four of them is four cycles:
// sixteen beats under CHATUSRA and thirty-two under ADI, both drawn in the
// same 18 cm. The metre never changed how much staff the music got — only how
// much music was asked to fit in it — so choosing a longer tala silently
// halved every glyph on the page.
//
// So a row is measured in BEATS instead of in divisions: a beat is never given
// less than MIN_BEAT_W of staff, and a row takes as many whole cycles as that
// allows, up to BOXES_PER_ROW. Four beats to a division still fits four
// divisions, which is why nothing about an ordinary sheet moves; KHANDA (5)
// and RUPAKA (6) take three, MISRA (7) and ADI (8) two.
//
// FLOORED, never rounded up: a row left short of the staff edge is stretched
// back out to it by the justifier in scoreRows(), so the cost of taking one
// division too few is spacing, while the cost of taking one too many is the
// crowding this exists to stop. A cycle too long to fit even once still gets
// its row — one division, which then takes the room its symbols ask for.
export function boxesPerRow(beats = beatsPerBox()) {
  const b = Number(beats);
  if (!Number.isFinite(b) || b <= 0) return BOXES_PER_ROW;
  return Math.max(1, Math.min(BOXES_PER_ROW,
    Math.floor(USABLE_W / (b * MIN_BEAT_W))));
}

export function groupsOf() {
  return currentTala().groups;
}

// Beat offsets of the INTERIOR group edges — the first beat of every group
// after the first. `[4,4]` gives `[4]`, `[3,2,2]` gives `[3,5]`. The division
// edge itself is never in here: it is already drawn as a division line, and
// the metronome's downbeat accent already lands on it.
export function groupEdges(groups = groupsOf()) {
  const out = [];
  let at = 0;
  for (let i = 0; i < groups.length - 1; i += 1) {
    at += groups[i];
    out.push(at);
  }
  return out;
}

// Does this beat of the cycle start a group? Beat 0 (the division line) does,
// which is what keeps the metronome's loud tick on the box line.
export function isGroupStart(beatInBox, groups = groupsOf()) {
  if (beatInBox === 0) return true;
  return groupEdges(groups).includes(beatInBox);
}

// ---- mutation ------------------------------------------------------------

// Keys are derived from the label so a saved file reads plainly, prefixed so a
// custom metre can never collide with — or shadow — a builtin key.
function keyFor(label) {
  const slug = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'metre';
  let key = `u-${slug}`;
  let n = 2;
  while (isBuiltin(key) || isCustom(key)) key = `u-${slug}-${n++}`;
  return key;
}

export function addTala({ label, formula }) {
  const def = normaliseTala({ label, formula });
  if (!def) return null;
  const key = keyFor(def.label);
  customs[key] = { ...def, key };
  saveTalas();
  return key;
}

// Editing a metre in use re-renders the score under it, which the caller does;
// nothing here touches state beyond the registry.
export function updateTala(key, { label, formula }) {
  if (!isCustom(key)) return null;
  const def = normaliseTala({ label, formula, key });
  if (!def) return null;
  customs[key] = { ...def, key };
  saveTalas();
  return key;
}

// A document already using this metre keeps working: its own copy travels in
// the .json, and re-opening it registers the definition again.
export function removeTala(key) {
  if (!isCustom(key)) return false;
  delete customs[key];
  saveTalas();
  if (state.tala === key) state.tala = 'chatusra';
  return true;
}

// Adopt a definition that arrived with a document. A key that already exists
// is left alone — the file must not silently rewrite a metre the user has
// been editing — and a builtin key is never overwritten.
export function registerTala(raw) {
  const def = normaliseTala(raw);
  if (!def) return null;
  const key = def.key;
  if (!key || isBuiltin(key)) return key || null;
  if (!isCustom(key)) {
    customs[key] = { ...def, key };
    saveTalas();
  }
  return key;
}

// What a save writes beside `tala`, so the file is self-contained.
export function talaForSave(key = state.tala) {
  const def = talaDef(key);
  return {
    key: def.key || key,
    label: def.label,
    formula: def.formula,
    groups: def.groups.slice(),
  };
}

// ---- persistence ---------------------------------------------------------
// Same shape as keybinds.js: localStorage is the only store the renderer has,
// and it is reached through `window` so the Node tests never touch it.

function store() {
  try { return globalThis.window?.localStorage || null; } catch { return null; }
}

export function saveTalas() {
  const s = store();
  if (!s) return;
  try { s.setItem(STORE_KEY, JSON.stringify(Object.values(customs))); } catch { /* quota */ }
}

export function loadTalas() {
  const s = store();
  if (!s) return customs;
  try {
    const raw = s.getItem(STORE_KEY);
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        customs = {};
        for (const item of list) {
          const def = normaliseTala(item);
          if (def && def.key && !isBuiltin(def.key)) customs[def.key] = { ...def, key: def.key };
        }
      }
    }
  } catch { /* corrupt entry — start with none rather than throwing at boot */ }
  return customs;
}

// Test seam: drop everything the registry holds.
export function resetTalas() {
  customs = {};
}
