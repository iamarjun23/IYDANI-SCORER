// The played key lights up on the dock's drawn keyboard.
//
// This is pinned because the way it FAILED is invisible. The device keyboard
// identifies a key by data-midi; highlightSemi() matches on data-semi/data-oct,
// which that keyboard never carries. So the call succeeded, matched nothing,
// toggled nothing, and threw no error — a played key simply stayed dark. A
// selector that silently matches nothing cannot be caught by reading the code,
// so it is caught here instead.
//
// Both halves are covered: the class going on for a LIVE press, and the class
// being painted in at BUILD time so a rebuild mid-hold (the drawn range widens
// as notes are played) does not drop the highlight off a key still held.

import { state } from '../src/renderer/state.js';
import { buildPiano, highlightDeviceKey } from '../src/renderer/piano.js';

// The class list of the white key drawn for `midi`, or null if it was not
// drawn. Read off the built markup with one regex rather than by splitting, so
// the assertion cannot pass on a chunk that lost the attribute it was testing.
function whiteClass(html, midi) {
  const m = html.match(new RegExp(`<div class="([^"]*)" data-midi="${midi}"`));
  return m ? m[1] : null;
}

let checks = 0;
function ok(cond, msg) {
  checks++;
  if (!cond) { console.error('FAIL: ' + msg); process.exit(1); }
}

// ---- a DOM small enough to answer what buildMidiKeyboard() asks it ----------
function fakeEl() {
  return {
    className: '', innerHTML: '', dataset: {}, style: {},
    children: [],
    appendChild(c) { this.children.push(c); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
}

let keysEl = fakeEl();
globalThis.document = {
  getElementById: id => (id === 'pianoKeys' ? keysEl : null),
  createElement: () => {
    const e = fakeEl();
    e.classList = {
      toggle(name, on) { e._toggled = [name, on]; },
    };
    return e;
  },
};

// A CASIO reports no key count in its name, so it resolves to the default 49
// (MIDI 36..84) — the same range the real device came up as.
state.mode = 'midi';
state.midiListening = true;
state.midiDeviceName = 'CASIO USB-MIDI';
state.midiKeyOverride = null;
state.midiLearned = { low: null, high: null };
state.midiShiftKey = null;
state.saMidi = 60;

// ---- 1. build with nothing held: no key is lit -----------------------------
state.midiHeld = [];
buildPiano();
const blank = keysEl.innerHTML;
ok(blank.includes('data-midi="60"'), 'the drawn keyboard contains middle C');
ok(!blank.includes('playing'), 'nothing is lit when no key is held');

// ---- 2. build with a key held: that key is drawn already lit ---------------
// White keys are built as an innerHTML string, so the class is asserted there.
keysEl = fakeEl();
state.midiHeld = [60];
buildPiano();
const withHeld = keysEl.innerHTML;
const cell = whiteClass(withHeld, 60);
ok(cell !== null, 'middle C is still drawn while held');
ok(cell.split(/\s+/).includes('playing'), 'a held white key is built lit');
// Exactly one key is lit — a held key must not light its neighbours or its
// octaves, which is what a semitone-based match would have done.
ok(withHeld.split('playing').length - 1 === 1, 'only the held key is lit');

// ---- 3. a black key is built lit too --------------------------------------
// Blacks are appended as elements rather than written into the string.
keysEl = fakeEl();
state.midiHeld = [61];                       // C#4
buildPiano();
ok(!keysEl.innerHTML.includes('playing'), 'no white key lit for a held black');
const litBlacks = keysEl.children.filter(c => c.className.includes('playing'));
ok(litBlacks.length === 1, 'exactly one black key is built lit');
ok(litBlacks[0].dataset.midi === 61, 'it is the black key that is held');

// ---- 4. an UNWRITABLE key lights as well -----------------------------------
// It is a real key on the device and it sounds, so it must not stay dark. 36
// is the bottom of a 49-key range and falls outside the staff's 36-semitone
// writable window wherever that window is centred.
keysEl = fakeEl();
state.midiHeld = [36];
buildPiano();
const lowCell = whiteClass(keysEl.innerHTML, 36);
ok(lowCell !== null, 'the lowest key is drawn');
ok(lowCell.split(/\s+/).includes('unmapped'), 'the lowest key really is outside the window');
ok(lowCell.split(/\s+/).includes('playing'), 'an unwritable key still lights when played');

// ---- 5. the LIVE toggle addresses the key by midi number -------------------
// This is the call the original bug missed entirely.
keysEl = fakeEl();
const toggles = [];
keysEl.querySelectorAll = sel => {
  toggles.push(sel);
  const el = { classList: { toggle: (n, on) => toggles.push([n, on]) } };
  return [el];
};
highlightDeviceKey(64, true);
ok(toggles[0] === '[data-midi="64"]', 'the live toggle selects by data-midi, not data-semi');
ok(toggles[1][0] === 'playing' && toggles[1][1] === true, 'it turns `playing` on');

toggles.length = 0;
highlightDeviceKey(64, false);
ok(toggles[1][0] === 'playing' && toggles[1][1] === false, 'and the key going up turns it off');

console.log(`midi-highlight: ${checks} checks passed`);
