// DNG piano UI. A plain piano: 7 whites + 5 blacks, each labelled with its
// DNG svara from the 12-tone chart:
//   whites → S · R2 · G2 · M1 · P · D2 · N2
//   blacks → R1 · G1 · M2 · D1 · N1
//
// Chromatic keys pair up: r/R both write Ri, g/G both write Ga, and so on.
// What separates them is the notehead — black keys write a filled goli, white
// keys a hollow one — which is how the model has always stored the sharpened
// variants, since it only holds the 7 Mayamalavagowla svaras.
//
// The Tools rail's Octave palette (octGrid) picks which sthayi a click plays in.

import { state, toneOn } from './state.js';
import { SVARAS, SVARA_TONES, TONE_LETTER, PIANO_RANGE, PIANO_SPANS } from './config.js';
import {
  resolveDeviceRange, autoOctaveShift, writableWindow, isWritable, noteName,
  isWhiteNote, blackKeyBox, STANDARD_SIZES,
} from './midi-device.js';
import {
  addNote, beginMetronomeEntry, closeMetronomeSilence, endMetronomeEntry, startHoldPromotion,
} from './score.js';
import { freqOf, freqOfMidi, startSustain, stopSustain } from './audio.js';

// Chromatic → nearest Mayamalavagowla SVARAS index (the only 7 the notation
// model can store). Off-scale cells snap to the nearest scale svara.
const SEMI_TO_SVARA = (() => {
  const table = new Array(12);
  for (let pc = 0; pc < 12; pc++) {
    let best = 0, bd = 99;
    for (let i = 0; i < 7; i++) {
      const d = Math.abs(SVARAS[i].semi - pc);
      if (d < bd) { bd = d; best = i; }
    }
    table[pc] = best;
  }
  return table;
})();

// The sharpened (black-key) semis. Membership decides the notehead: filled for
// these, hollow for the rest — the only thing distinguishing r from R once the
// model has snapped both onto svara Ri.
const BLACK_SET = new Set([1, 3, 6, 8, 10]);

// Semis of the 7 whites and 5 blacks (C-anchored keyboard).
const ALL_WHITE_SEMIS = [0, 2, 4, 5, 7, 9, 11];
const ALL_BLACK_SEMIS = [1, 3, 6, 8, 10];

// Every sthayi now carries all 12 keys. The old per-sthayi subsets existed
// because the pre-stem-length staff clamped anything past Mandra Ma / Taara Ma
// onto one position, so those keys had nowhere distinct to land. Octave is
// written as stem length now, so all 21 svaras are representable and nothing
// needs hiding — Mandra Sa in particular was previously unreachable.
function sthayiOct() { return state.oct == null ? 0 : state.oct; }

const SECTION_LABEL = { '-1': 'Mandra', '0': 'Madhya', '1': 'Taara' };

// Key caps use TONE_LETTER — the same twelve letters printed in the sheet's
// tone legend and shown in the note inspector — rather than a second copy that
// can drift from it. (It is not a plain white/black split: Ma's variant is the
// sharp one, so the black key between Ma and Pa is `M` and the white key is
// `m`.)

// ---- The visible key window ----------------------------------------------
// A key now carries its own sthayi (data-oct) rather than borrowing the one
// the tabs select, because the keyboard shows more than one sthayi at a time.
// Pitch is addressed by an absolute rung 0..35 = mandra Sa .. taara Ni.
const WHITE_PC = new Set(ALL_WHITE_SEMIS);
const rungOct  = t => Math.floor(t / 12) - 1;
const rungSemi = t => t % 12;

export function pianoWindow() {
  const span = Math.max(12, Math.min(PIANO_RANGE, state.pianoSpan || 12));
  const base = (sthayiOct() + 1) * 12;      // first rung of the selected sthayi
  // The window is a fixed width: at the ends of the range it slides inward
  // rather than showing empty air where a fourth sthayi would be.
  let start = base - Math.floor((span - 12) / 2);
  start = Math.max(0, Math.min(start, PIANO_RANGE - span));
  let end = start + span - 1;
  // Both edges have to be white keys — a black has no white to hang off, and
  // half a black key at the edge reads as a rendering fault.
  while (start > 0 && !WHITE_PC.has(rungSemi(start))) start--;
  while (end < PIANO_RANGE - 1 && !WHITE_PC.has(rungSemi(end))) end++;
  return { start, end };
}

function pressSemi(semi, sustain = false, sym = state.sym, oct = sthayiOct()) {
  // Notehead follows the physical key type: black → goli (filled),
  // white → dot (hollow).
  const prevHead = state.head;
  state.head = BLACK_SET.has(semi) ? 'f' : 'o';
  const svi = SEMI_TO_SVARA[semi];
  // Close the silence in front of this note BEFORE writing it, so a rest lands
  // between the two notes instead of after both.
  closeMetronomeSilence();
  // oct comes from the key, not from state.oct: clicking a neighbouring
  // sthayi's key writes in that sthayi and leaves the selected tab alone.
  const noteIndex = addNote(svi, { playSound: !sustain, sym, oct });
  // Sound the semitone actually pressed. Going back through
  // SVARAS[svi].semi would snap a white R to R1 and play the wrong pitch.
  const freq = freqOf(semi, oct);
  state.head = prevHead;
  return { frequency: freq, noteIndex };
}

// ---- the connected device's keyboard -------------------------------------
// In MIDI mode the dock stops showing the app's own one-octave-ish piano and
// shows the KEYBOARD THAT IS PLUGGED IN: its real key count, drawn from
// midi-device.js, with the staff's 36 writable semitones sitting over the
// middle of it. Keys outside that window are drawn — it is a picture of your
// keyboard, so leaving them out would misrepresent it — but they carry no
// svara, because the staff cannot write them.

export function deviceRange() {
  return resolveDeviceRange({
    name: state.midiDeviceName,
    override: state.midiKeyOverride,
    learned: state.midiLearned,
  });
}

// Auto-centre, LATCHED. The shift is worked out once per device and then held
// still until the device itself changes — a different keyboard, a size picked
// in the dock, or a new tonic.
//
// It must not be recomputed per note, because deviceRange() widens as keys get
// played and a wider range re-centres the window. That made one stray low note
// silently re-pitch the whole keyboard mid-take: before it, middle C wrote
// madhya Sa; after it, the same key wrote taara Sa. Widening the DRAWN
// keyboard from what was played is right — it is only a picture. Moving the
// writable window from it is not, because the player is holding the same keys.
//
// `midiKeyOverride` is therefore also the escape hatch for re-centring: pick a
// size in the dock and the latch is retaken.
function shiftKey() {
  return `${state.midiDeviceName}|${state.midiKeyOverride ?? ''}|${state.saMidi ?? 60}`;
}

export function deviceShift() {
  const key = shiftKey();
  if (state.midiShiftKey !== key) {
    state.midiShiftKey = key;
    state.midiShift = autoOctaveShift(deviceRange(), state.saMidi ?? 60);
  }
  return state.midiShift;
}

// What a device key SOUNDS, written or not.
//
// A writable key sounds the note the staff shows for it, which is the key
// transposed by the auto-centre shift. An unwritable one used to sound its own
// untransposed pitch, so the two disagreed by `shift` octaves and an ascending
// physical scale fell 11 semitones the moment it crossed the window edge
// (69,70,71 sounded 81,82,83 and then key 72 sounded 72). One rule for both:
// the whole device sounds transposed by the shift, so the keyboard is
// continuous and what is written is still what is heard.
export function deviceFreq(midi) {
  return freqOfMidi(midi - deviceShift() * 12);
}

// A device note -> what the staff writes for it, or null when it falls outside
// the window. Octave-shifted first, so "auto-centre" is applied in one place.
export function writtenFor(midi) {
  const saMidi = state.saMidi ?? 60;
  const shift = deviceShift();
  if (!isWritable(midi, saMidi, shift)) return null;
  const rel = midi - shift * 12 - saMidi;
  const semi = ((rel % 12) + 12) % 12;
  return { semi, oct: Math.floor(rel / 12) };
}

function midiEmptyState() {
  return `<div class="midi-empty">
    <div class="midi-empty-ttl">No MIDI device connected</div>
    <div class="midi-empty-sub">Connect a keyboard by USB and switch it on — its keys
      appear here as soon as it is found.</div>
    <button type="button" id="midiEmptyBtn">Scan for devices</button>
  </div>`;
}

function buildMidiKeyboard(keys) {
  if (!state.midiListening) {
    keys.className = 'piano-keys empty';
    keys.innerHTML = midiEmptyState();
    keys.querySelector('#midiEmptyBtn')?.addEventListener('click', () => {
      // Sent as an event rather than calling midi-input.js, which imports this
      // module — a straight call would make the two modules circular.
      document.dispatchEvent(new CustomEvent('midi:reconnect'));
    });
    return;
  }
  keys.className = 'piano-keys';

  const range = deviceRange();
  const notes = [];
  for (let m = range.low; m <= range.high; m++) notes.push(m);
  const whites = notes.filter(isWhiteNote);
  const N = whites.length;
  // Past this many keys the svara letter is all that fits; the note name goes
  // on the C keys only, which is what you count octaves by anyway. `C#` also
  // starts with a C, so the test has to exclude it — otherwise every C sharp
  // on the keyboard carried a name none of the other blacks did, which reads
  // as five keys picked out for no reason.
  const dense = N > 30;

  const face = m => {
    const w = writtenFor(m);
    const nm = noteName(m);
    const showName = !dense || (nm[0] === 'C' && nm[1] !== '#');
    return (w ? `<span class="sv">${TONE_LETTER[w.semi]}</span>` : '')
      + (showName ? `<span class="nn">${nm}</span>` : '')
      + (w ? '' : `<span class="off" title="Outside the staff's range">·</span>`);
  };

  // Keys under the player's fingers right now. Painted in at BUILD time, not
  // only toggled on the press: buildPiano() rewrites this markup whenever the
  // drawn range widens or the device changes, and a class put on the old
  // elements dies with them — which would drop the highlight off a key that is
  // still being held. state.midiHeld is midi-input.js's published list.
  const down = new Set(state.midiHeld || []);
  // Letter struck through when the legend has that tone switched off: it sounds, writes nothing.
  const offCls = w => (w && !toneOn(w.semi, w.oct) ? ' toneoff' : '');

  keys.innerHTML = whites.map(m => {
    const w = writtenFor(m);
    return `<div class="wkey${w ? '' : ' unmapped'}${offCls(w)}${down.has(m) ? ' playing' : ''}" data-midi="${m}">${face(m)}</div>`;
  }).join('');

  notes.filter(m => !isWhiteNote(m)).forEach(m => {
    let after = -1;
    for (let i = 0; i < N; i++) if (whites[i] < m) after = i;
    if (after < 0) return;
    const el = document.createElement('div');
    const w = writtenFor(m);
    el.className = 'bkey' + (w ? '' : ' unmapped') + offCls(w) + (down.has(m) ? ' playing' : '');
    el.dataset.midi = m;
    const box = blackKeyBox(after, N, m);
    el.style.width = box.width + '%';
    el.style.left = box.left + '%';
    el.innerHTML = face(m);
    keys.appendChild(el);
  });

  wireKeys(keys, (el, sym) => {
    const midi = +el.dataset.midi;
    const w = writtenFor(midi);
    // Outside the window there is nothing to write, so the key only sounds —
    // which is exactly what the blank label promises.
    if (!w) return { frequency: deviceFreq(midi), noteIndex: null };
    return pressSemi(w.semi, true, sym, w.oct);
  });
}

// One pointer path for both keyboards: press, sustain, promote on hold,
// release. `press` is what differs, so it is the only thing passed in.
function wireKeys(keys, press) {
  keys.querySelectorAll('.wkey,.bkey').forEach(k => {
    k.addEventListener('pointerdown', e => {
      e.preventDefault();
      const selectedSym = state.sym;
      const { frequency, noteIndex } = press(k, selectedSym);
      if (noteIndex != null) beginMetronomeEntry();
      const voice = startSustain(frequency);
      const stopPromotion = noteIndex == null
        ? () => {} : startHoldPromotion(noteIndex, selectedSym);
      k.classList.add('down');
      k.setPointerCapture?.(e.pointerId);

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        stopPromotion();
        if (noteIndex != null) endMetronomeEntry();
        stopSustain(voice);
        k.classList.remove('down');
      };
      k.addEventListener('pointerup', release, { once: true });
      k.addEventListener('pointercancel', release, { once: true });
      k.addEventListener('lostpointercapture', release, { once: true });
    });
  });
}

export function buildPiano() {
  const keys = document.getElementById('pianoKeys');
  if (!keys) return;
  if (state.mode === 'midi') return buildMidiKeyboard(keys);
  keys.className = 'piano-keys';

  const { start, end } = pianoWindow();
  const rungs = [];
  for (let t = start; t <= end; t++) rungs.push(t);
  const whites = rungs.filter(t => WHITE_PC.has(rungSemi(t)));
  const N_WHITES = whites.length;

  keys.innerHTML = whites.map(t => {
    const semi = rungSemi(t);
    // Sa is the only key labelled with its sthayi. The keys are otherwise
    // identical across octaves, so this is what says where one sthayi ends.
    const lbl = semi === 0
      ? `<span class="oct-lbl">${SECTION_LABEL[rungOct(t)]}</span>` : '';
    return `<div class="wkey${toneOn(semi, rungOct(t)) ? '' : ' toneoff'}" data-semi="${semi}" data-oct="${rungOct(t)}">
      <span class="sv">${TONE_LETTER[semi]}</span>${lbl}
    </div>`;
  }).join('');

  rungs.filter(t => !WHITE_PC.has(rungSemi(t))).forEach(t => {
    // Position relative to how many whites of the window sit before it.
    let after = -1;
    for (let i = 0; i < N_WHITES; i++) if (whites[i] < t) after = i;
    if (after < 0) return;
    const el = document.createElement('div');
    el.className = 'bkey' + (toneOn(rungSemi(t), rungOct(t)) ? '' : ' toneoff');
    el.dataset.semi = rungSemi(t);
    el.dataset.oct = rungOct(t);
    // A black key is a fixed fraction of a white's width whatever the span is,
    // so widening the keyboard cannot leave the blacks the fixed 8.6% the CSS
    // assumes. Placement is blackKeyBox()'s, the same rule the device keyboard
    // draws by — the two must not be laid out differently.
    const box = blackKeyBox(after, N_WHITES, t);
    el.style.width = box.width + '%';
    el.style.left = box.left + '%';
    el.innerHTML = `<span class="sv">${TONE_LETTER[rungSemi(t)]}</span>`;
    keys.appendChild(el);
  });

  wireKeys(keys, (k, sym) => pressSemi(+k.dataset.semi, true, sym, +k.dataset.oct));

  updateStatus();
}

// Light a key from outside — the MIDI input module calls this so a physical
// key press looks the same on screen as a clicked one. Both the white and the
// black key carrying this semitone are matched, though only one exists.
export function highlightSemi(semi, on, oct = null) {
  const keys = document.getElementById('pianoKeys');
  if (!keys) return;
  // The same semitone now appears once per visible sthayi, so an octave is
  // needed to light the right one. Without it every copy lights, which is
  // what a caller that does not know its octave means anyway.
  const sel = oct == null
    ? `[data-semi="${semi}"]`
    : `[data-semi="${semi}"][data-oct="${oct}"]`;
  keys.querySelectorAll(sel).forEach(k => k.classList.toggle('down', !!on));
}

// Light the key a PHYSICAL press landed on, in MIDI mode.
//
// The device's keyboard addresses a key by its MIDI NUMBER — that is what
// buildMidiKeyboard() puts in data-midi — so this does not go through
// highlightSemi(): that one matches on data-semi/data-oct, which the device
// keyboard does not carry at all, so it silently matched nothing and a played
// key never lit. Addressing by midi number also means the keys OUTSIDE the
// writable window light like any other. They are drawn, they sound, and the
// dock is a picture of your keyboard — a key you can hear yourself playing
// that stays dark reads as a dead key.
//
// `playing` and not `down`: `down` is the mouse's own :active feedback, and a
// physical press wants to be visible across the room while you are looking at
// your hands, not at the screen.
export function highlightDeviceKey(midi, on) {
  const keys = document.getElementById('pianoKeys');
  if (!keys) return;
  keys.querySelectorAll(`[data-midi="${midi}"]`).forEach(k =>
    k.classList.toggle('playing', !!on));
}

// The dock's MIDI key-count picker. Auto is the default and is usually right:
// the name is parsed and the range widens to whatever gets played. Picking a
// size is the escape hatch for a device whose name says nothing.
export function buildMidiKeyPicker() {
  const sel = document.getElementById('midiKeys');
  if (!sel) return;
  sel.innerHTML = '<option value="">Auto-detect keys</option>'
    + STANDARD_SIZES.map(n => `<option value="${n}">${n}-key</option>`).join('');
  sel.value = state.midiKeyOverride ? String(state.midiKeyOverride) : '';
  sel.addEventListener('change', () => {
    state.midiKeyOverride = sel.value ? +sel.value : null;
    // FORGET FIRST. The learned range only ever widens — a key not yet pressed
    // proves nothing — so picking a size here used to change nothing at all
    // when the problem was the learned range: whatever count was chosen, the
    // stored span widened straight back past it and the phantom keys stayed,
    // relaunch after relaunch. Picking a size is the player stating what is in
    // front of them, so it re-measures from scratch; Auto-detect does the same,
    // because "start again" is what picking Auto on a wrong keyboard means.
    //
    // By event, not by calling midi-input.js: that module imports this one.
    // buildPiano() is called from there once the range is cleared.
    document.dispatchEvent(new CustomEvent('midi:forget-range'));
  });
}

// The dock's key-span picker. Built from PIANO_SPANS so the list cannot drift
// from the range the window code clamps to.
export function buildSpanPicker() {
  const sel = document.getElementById('pianoSpan');
  if (!sel) return;
  sel.innerHTML = PIANO_SPANS.map(n =>
    `<option value="${n}">${n} keys</option>`).join('');
  sel.value = String(state.pianoSpan);
  sel.addEventListener('change', () => {
    state.pianoSpan = +sel.value;
    buildPiano();
  });
}

function updateStatus() {
  const s = document.getElementById('statusText');
  if (s && state.mode === 'piano') {
    s.textContent = `${SECTION_LABEL[sthayiOct()] || 'Madhya'} sthayi — click a svara`;
  }
}

export function setOct(v) {
  v = Math.max(-1, Math.min(1, v));
  state.oct = v;
  document.querySelectorAll('#octGrid .glyph').forEach(g =>
    g.classList.toggle('sel', +g.dataset.oct === v),
  );
  buildPiano();                       // repaint: the key glyphs are sthayi-specific
  updateStatus();
  // The sheet's tone legend shows the selected sthayi's row. By event:
  // palettes.js imports this module.
  document.dispatchEvent(new Event('oct:changed'));
}
