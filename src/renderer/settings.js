// Preferences that outlive a document.
//
// Not score data: these belong to the person, not the piece, so they are NOT
// written into the .json the way keybinds and custom talas are. localStorage is
// the only store the renderer has — there is no settings file and no IPC — and
// both calls are guarded because this module is also imported under plain Node
// by the tests, where there is no localStorage at all.

import { state } from './state.js';

const STORE_KEY = 'dng.settings.v1';

// Every preference this module owns, with the value it takes when nothing has
// been saved. Adding one here is enough — load and save both walk this table,
// so neither has to be edited again.
const DEFAULTS = {
  // See state.js. 'time' is the default because a played note should be worth
  // what it was actually held for.
  holdWrites: 'time',
  // Where playback sounds. 'internal' by default: the app must make a sound on
  // its own, with no instrument plugged in, and a saved 'device' would be
  // silent on a machine whose keyboard is not connected. deviceSink() falls
  // back on its own if the port is missing, so this is belt and braces.
  midiSink: 'internal',
  // Whether to match the keyboard's MIDI transport clock — see midi-clock.js.
  midiSync: 'follow',
  // The residual nudge, in ms. See state.js.
  midiSyncOffset: 0,
  // What has been LEARNED about each MIDI device, keyed by the name the device
  // reports. Web MIDI exposes no key count and no capabilities — measured, the
  // whole port object is id/name/manufacturer/version/type/state/connection —
  // so everything useful has to be worked out from what the device actually
  // sends. That evidence was thrown away at every relaunch, which meant the
  // first notes of every session were placed against a guessed 49-key range.
  // Remembering it per name means a device is known from its second session on.
  //
  //   { "<device name>": { low, high, velocity, sinkSet } }
  midiDevices: {},
};

// A value is either one of a fixed list, or checked by a function when it has
// structure. Everything here comes back off localStorage, which is editable by
// hand and shared with whatever else the origin stores, so nothing is trusted.
const ALLOWED = {
  holdWrites: ['time', 'fixed', 'palette'],
  midiSink: ['internal', 'device'],
  // 'drive' was a previous third choice. Treat an old saved value as the
  // default so every installation now has the same two visible choices.
  midiSync: ['off', 'follow'],
  midiSyncOffset: cleanOffset,
  midiDevices: cleanDevices,
};

const midiByte = n => (Number.isInteger(n) && n >= 0 && n <= 127 ? n : null);

// A quarter of a second either way. Wide enough for any real audio path and
// for a whole beat at a slow tempo, narrow enough that a corrupt entry cannot
// park the click somewhere it will never be heard against the keyboard.
const MAX_OFFSET_MS = 250;
function cleanOffset(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.max(-MAX_OFFSET_MS, Math.min(MAX_OFFSET_MS, n));
}

// Keep only entries that describe a real device. A range whose low is above
// its high, a name of unreasonable length, or a velocity flag that is not a
// boolean would all sail through JSON.parse and then be used as if measured.
const MAX_REMEMBERED = 24;
function cleanDevices(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  // Bounded, because devices come and go and nothing ever removes an entry —
  // an unbounded map would grow for the life of the install.
  for (const [name, v] of Object.entries(value).slice(0, MAX_REMEMBERED)) {
    if (!name || name.length > 128 || !v || typeof v !== 'object') continue;
    const entry = {};
    const low = midiByte(v.low), high = midiByte(v.high);
    if (low != null && high != null && low <= high) { entry.low = low; entry.high = high; }
    if (typeof v.velocity === 'boolean') entry.velocity = v.velocity;
    // Whether the sink has already been defaulted for this device. A flag and
    // not the choice itself: the choice lives in midiSink, and this only
    // records that it has been made once, so a later change is never undone by
    // the next time the same keyboard is plugged in.
    if (v.sinkSet === true) entry.sinkSet = true;
    if (Object.keys(entry).length) out[name] = entry;
  }
  return out;
}

// Reached through `window` rather than globalThis so the Node tests never touch
// it — bare globalThis.localStorage warns there even inside a try.
function store() {
  try { return globalThis.window?.localStorage || null; } catch { return null; }
}

// Only values this build knows about, so a corrupt or hand-edited entry cannot
// put the app into a mode nothing reads.
function clean(key, value) {
  const allowed = ALLOWED[key];
  if (typeof allowed === 'function') return allowed(value);
  return allowed && allowed.includes(value) ? value : DEFAULTS[key];
}

export function saveSettings() {
  const s = store();
  if (!s) return;
  const out = {};
  for (const key of Object.keys(DEFAULTS)) out[key] = clean(key, state[key]);
  try { s.setItem(STORE_KEY, JSON.stringify(out)); } catch { /* quota, private mode */ }
}

export function loadSettings() {
  for (const [key, value] of Object.entries(DEFAULTS)) state[key] = value;
  const s = store();
  if (!s) return;
  try {
    const raw = s.getItem(STORE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    for (const key of Object.keys(DEFAULTS)) {
      if (key in saved) state[key] = clean(key, saved[key]);
    }
  } catch { /* corrupt entry — the defaults above already stand */ }
}

// Flip a preference and persist it in one step, so no caller can change one
// without writing it and leave the two out of step across a relaunch.
export function setSetting(key, value) {
  if (!(key in DEFAULTS)) return;
  state[key] = clean(key, value);
  saveSettings();
}

// What is remembered about one device, or an empty object. Kept here rather
// than in midi-input.js so the shape is defined and validated in one place.
export function deviceMemory(name) {
  if (!name) return {};
  return (state.midiDevices && state.midiDevices[name]) || {};
}

// Merge new observations into what is already known about a device. Merging
// rather than replacing matters for the range: a session in which only the top
// half of the keyboard was played must not narrow a span learned earlier.
// Un-learn a device's measured span, and the only thing in this module that
// ever NARROWS one.
//
// rememberDevice() merges outward on purpose — a session that played only the
// top half must not shrink a span measured earlier — and that left the range a
// one-way ratchet with nothing on the other end. One note from below the
// keyboard, from a second port being listened to, from a device left
// transposed, or from an octave button pressed by accident, and two keys the
// instrument does not have were drawn on the dock for good: they survived the
// relaunch (that is what the store is for), and the dock's key-count picker
// could not shift them either, because the learned range widened straight back
// past whatever size was chosen.
//
// So the picker forgets first and re-measures after. What is thrown away is
// evidence, which is recoverable by playing the keys again; what it buys back
// is a keyboard the player can correct.
export function forgetDeviceRange(name) {
  if (!name) return;
  const all = { ...(state.midiDevices || {}) };
  const prev = all[name];
  if (!prev) return;
  const { low, high, ...rest } = prev;      // velocity and sinkSet are kept
  all[name] = rest;
  setSetting('midiDevices', all);
}

export function rememberDevice(name, patch) {
  if (!name || !patch) return;
  const all = { ...(state.midiDevices || {}) };
  const prev = all[name] || {};
  const next = { ...prev };
  if (patch.low != null) next.low = prev.low == null ? patch.low : Math.min(prev.low, patch.low);
  if (patch.high != null) next.high = prev.high == null ? patch.high : Math.max(prev.high, patch.high);
  if (typeof patch.velocity === 'boolean') next.velocity = patch.velocity;
  if (patch.sinkSet === true) next.sinkSet = true;
  all[name] = next;
  setSetting('midiDevices', all);
}
