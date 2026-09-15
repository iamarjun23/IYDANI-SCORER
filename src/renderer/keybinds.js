// Which physical key writes which svara.
//
// The mapping used to be KEY_ROWS in config.js — three fixed strings, read
// straight by keyboard.js. It is now editable, so the strings are only the
// DEFAULT and the live answer lives in state.keyBinds. This module is the one
// place that answers "what does this key write" and "what key writes this
// svara", which is why it is pure: no DOM, no rendering. keymap.js draws it,
// keyboard.js reads it, tests/keybinds.test.mjs drives it.
//
// Shape: { '-1': [7 keys], '0': [...], '1': [...] } — index is the svara
// position (S R G M P D N), the row is the sthayi. An empty string is an
// unbound slot, which is a legal state: stealing a key from another slot has
// to leave that slot with nothing rather than silently keeping a duplicate.

import { KEY_ROWS } from './config.js';
import { state } from './state.js';

const STORE_KEY = 'dng.keybinds.v1';

// The three sthayi rows in the order the map draws them, top to bottom.
export const BIND_OCTS = [1, 0, -1];
export const SLOTS = 7;

export function defaultBinds() {
  const b = {};
  KEY_ROWS.forEach(row => { b[row.oct] = [...row.keys]; });
  return b;
}

// A binding is one lowercase character. Anything else — a dead slot, a stray
// multi-character string out of an edited file — normalises to unbound rather
// than being trusted into the lookup table.
function cleanKey(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return s.length === 1 ? s : '';
}

// Accept only a well-formed 3×7 map, and drop any duplicate: a key can write
// exactly one svara, so the first row to claim it keeps it.
export function normaliseBinds(raw) {
  const out = defaultBinds();
  if (!raw || typeof raw !== 'object') return out;
  const seen = new Set();
  BIND_OCTS.forEach(oct => {
    const row = raw[oct] ?? raw[String(oct)];
    out[oct] = new Array(SLOTS).fill('');
    for (let i = 0; i < SLOTS; i++) {
      const k = cleanKey(Array.isArray(row) ? row[i] : '');
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out[oct][i] = k;
    }
  });
  return out;
}

export function binds() {
  if (!state.keyBinds) state.keyBinds = defaultBinds();
  return state.keyBinds;
}

export function bindOf(oct, idx) { return binds()[oct]?.[idx] || ''; }

// key -> { idx, oct }, or null. Built fresh each call: 21 entries is nothing,
// and a cache here would be one more thing to invalidate on every rebind.
export function lookupKey(ch) {
  const k = cleanKey(ch);
  if (!k) return null;
  const b = binds();
  for (const oct of BIND_OCTS) {
    const i = b[oct].indexOf(k);
    if (i >= 0) return { idx: i, oct };
  }
  return null;
}

// Assign a key to a slot. A key writes one svara, so binding one that is
// already taken STEALS it — the old slot is left unbound rather than both
// slots claiming the same keystroke.
export function bindKey(oct, idx, ch) {
  const k = cleanKey(ch);
  if (!k || idx < 0 || idx >= SLOTS) return false;
  const b = binds();
  if (!b[oct]) return false;
  const prev = lookupKey(k);
  if (prev) {
    if (prev.oct === oct && prev.idx === idx) return true;   // already there
    b[prev.oct][prev.idx] = '';
  }
  b[oct][idx] = k;
  saveBinds();
  return true;
}

export function clearBind(oct, idx) {
  const b = binds();
  if (!b[oct]) return;
  b[oct][idx] = '';
  saveBinds();
}

export function resetBinds() {
  state.keyBinds = defaultBinds();
  saveBinds();
  return state.keyBinds;
}

// Adopt a map from outside — a saved document, or localStorage at startup.
export function applyBinds(raw) {
  state.keyBinds = normaliseBinds(raw);
  return state.keyBinds;
}

export function isDefaultBinds() {
  const d = defaultBinds(), b = binds();
  return BIND_OCTS.every(o => d[o].every((k, i) => k === b[o][i]));
}

// ---- persistence ---------------------------------------------------------
// localStorage is the only store the renderer has; there is no settings file
// and no IPC. Both calls are guarded because the module is also imported by
// the Node tests, where there is no localStorage at all.

// Reached through `window` rather than globalThis so the Node tests never
// touch it — bare globalThis.localStorage warns there even inside a try.
function store() {
  try { return globalThis.window?.localStorage || null; } catch { return null; }
}

export function saveBinds() {
  const s = store();
  if (!s) return;
  try { s.setItem(STORE_KEY, JSON.stringify(binds())); } catch { /* quota, private mode */ }
}

export function loadBinds() {
  const s = store();
  if (!s) return binds();
  try {
    const raw = s.getItem(STORE_KEY);
    if (raw) return applyBinds(JSON.parse(raw));
  } catch { /* corrupt entry — fall back to defaults */ }
  return binds();
}
