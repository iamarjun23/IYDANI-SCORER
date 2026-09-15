// Everything the keyboard actually sends.
//
// Web MIDI reports no capabilities at all — a port carries a name and nothing
// else — so every question about an instrument in this app is answered by
// watching what arrives. midi-device.js does that for the key range and the
// velocity sensor. This does it for the WHOLE stream, and exists because of
// one question that could not otherwise be settled: does this piano transmit
// its metronome tempo in any form?
//
// The honest way to answer that is to look. So every message from every input
// is decoded and either logged or counted, and the report can be copied out
// whole — a keyboard that says nothing about its tempo and a keyboard that
// says it somewhere unexpected look identical until somebody reads the bytes.
//
// This module is PURE — no DOM, no WebMidi, no state — apart from the panel at
// the foot of the file, which is the only part that touches the document.
// tests/midi-monitor.test.mjs drives the decoder and the log against byte
// arrays, with no device and no browser.

// ---------- decoding ----------

const NOTE_LETTER = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Middle C is C4 here, matching what a keyboard prints on its own keys and
// what midi-device.js's noteName() reports, so a line in this log and a label
// on the dock's drawn keyboard name the same key.
function noteName(n) {
  return `${NOTE_LETTER[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}

// The controllers worth naming. Not a complete table — an unnamed controller
// still prints its number, which is what matters for reading a dump.
const CC_NAMES = {
  0: 'bank select MSB', 1: 'modulation', 5: 'portamento time', 6: 'data entry MSB',
  7: 'volume', 10: 'pan', 11: 'expression', 32: 'bank select LSB',
  38: 'data entry LSB', 64: 'sustain pedal', 65: 'portamento', 66: 'sostenuto',
  67: 'soft pedal', 71: 'resonance', 74: 'brightness', 84: 'portamento control',
  91: 'reverb depth', 93: 'chorus depth', 96: 'data increment', 97: 'data decrement',
  98: 'NRPN LSB', 99: 'NRPN MSB', 100: 'RPN LSB', 101: 'RPN MSB',
  120: 'all sound off', 121: 'reset controllers', 122: 'local control',
  123: 'all notes off', 124: 'omni off', 125: 'omni on', 126: 'mono on', 127: 'poly on',
};

// The three-byte manufacturer prefixes are a long list; these are the ones a
// piano on a desk is likely to be.
const MAKERS = {
  0x41: 'Roland', 0x42: 'Korg', 0x43: 'Yamaha', 0x44: 'Casio', 0x40: 'Kawai',
  0x47: 'Akai', 0x00: 'extended id', 0x7D: 'non-commercial',
  0x7E: 'universal non-realtime', 0x7F: 'universal realtime',
};

export function hex(bytes) {
  return Array.from(bytes || []).map(b => (b & 0xFF).toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

// One message -> { family, name, text }.
//
// `family` is what the log groups and counts by, and is also what decides
// whether a message earns a LINE or only a tally — see FLOOD below. `name` is
// the family in words; `text` is the whole message in words.
export function describeMessage(data) {
  const d = Array.from(data || []).map(b => b & 0xFF);
  const s = d[0];
  if (s == null) return { family: 'empty', name: 'empty', text: 'empty message' };

  // A running-status continuation, or a stray data byte. Not decodable on its
  // own, and worth showing as itself rather than guessed at.
  if (s < 0x80) return { family: 'data', name: 'data bytes', text: `data ${hex(d)}` };

  if (s >= 0xF0) return describeSystem(d);

  const ch = (s & 0x0F) + 1;
  const a = d[1] ?? 0;
  const b = d[2] ?? 0;
  switch (s & 0xF0) {
    case 0x80:
      return { family: 'noteoff', name: 'note off', text: `note off  ${noteName(a)} (${a})  vel ${b}  ch ${ch}` };
    case 0x90:
      // Velocity zero IS a note off — the running-status form nearly every
      // keyboard actually sends. Counting it as a note on would make every
      // dump claim twice as many notes as were played.
      return b === 0
        ? { family: 'noteoff', name: 'note off', text: `note off  ${noteName(a)} (${a})  vel 0 (as note-on)  ch ${ch}` }
        : { family: 'noteon', name: 'note on', text: `note on   ${noteName(a)} (${a})  vel ${b}  ch ${ch}` };
    case 0xA0:
      return { family: 'polypressure', name: 'poly aftertouch', text: `aftertouch ${noteName(a)}  ${b}  ch ${ch}` };
    case 0xB0: {
      // Built in two steps rather than as a nested template literal. Nesting
      // one backtick inside another is legal JS and unreadable to anything
      // that strips strings with a regex — tools/check-imports.mjs among them,
      // which then reads the string contents as code.
      const named = CC_NAMES[a];
      const label = named ? ` (${named})` : '';
      return { family: 'cc', name: 'control change', text: `CC ${a}${label} = ${b}  ch ${ch}` };
    }
    case 0xC0:
      return { family: 'program', name: 'program change', text: `program ${a}  ch ${ch}` };
    case 0xD0:
      return { family: 'pressure', name: 'channel pressure', text: `channel pressure ${a}  ch ${ch}` };
    case 0xE0:
      return { family: 'bend', name: 'pitch bend', text: `pitch bend ${((b << 7) | a) - 8192}  ch ${ch}` };
    default:
      return { family: 'unknown', name: 'unknown', text: hex(d) };
  }
}

function describeSystem(d) {
  const s = d[0];
  switch (s) {
    case 0xF0: {
      const maker = MAKERS[d[1]] || `maker 0x${(d[1] ?? 0).toString(16).toUpperCase()}`;
      return { family: 'sysex', name: 'sysex', text: `sysex  ${maker}  ${d.length} bytes  ${hex(d)}` };
    }
    // Quarter-frame timecode. A flood at 100 messages a second, and about
    // position on tape rather than tempo.
    case 0xF1:
      return { family: 'mtc', name: 'MTC quarter frame', text: `MTC quarter frame ${d[1] ?? 0}` };
    case 0xF2: {
      const pos = (d[1] ?? 0) | ((d[2] ?? 0) << 7);
      return { family: 'songposition', name: 'song position', text: `song position ${pos} sixteenths (beat ${(pos / 4).toFixed(2)})` };
    }
    case 0xF3:
      return { family: 'songselect', name: 'song select', text: `song select ${d[1] ?? 0}` };
    case 0xF6:
      return { family: 'tunerequest', name: 'tune request', text: 'tune request' };
    case 0xF7:
      return { family: 'sysexend', name: 'sysex end', text: 'end of sysex' };
    case 0xF8:
      return { family: 'clock', name: 'beat clock', text: 'clock (0xF8)' };
    case 0xFA:
      return { family: 'start', name: 'start', text: 'START (0xFA)' };
    case 0xFB:
      return { family: 'continue', name: 'continue', text: 'CONTINUE (0xFB)' };
    case 0xFC:
      return { family: 'stop', name: 'stop', text: 'STOP (0xFC)' };
    case 0xFE:
      return { family: 'activesensing', name: 'active sensing', text: 'active sensing (0xFE)' };
    case 0xFF:
      return { family: 'reset', name: 'system reset', text: 'SYSTEM RESET (0xFF)' };
    default:
      return { family: 'unknown', name: 'unknown system', text: hex(d) };
  }
}

// ---------- the log ----------

// Messages that arrive faster than anyone can read and say the same thing
// every time. Counted, never logged: 24 clocks to the quarter and active
// sensing three times a second would push everything else out of the window
// within seconds, which is precisely how a rare and interesting message gets
// missed.
const FLOOD = new Set(['clock', 'activesensing', 'mtc']);

// How many lines to keep. Enough to hold a phrase of playing plus whatever
// happened around it, small enough to read.
export const MAX_ROWS = 300;

export function newMonitor() {
  return { ports: new Map(), rows: [], total: 0, firstMs: null, lastMs: null };
}

function portRecord(mon, port) {
  let p = mon.ports.get(port);
  if (!p) {
    p = { counts: new Map(), total: 0 };
    mon.ports.set(port, p);
  }
  return p;
}

// One message, from `port`, at `ms` on the performance clock. Everything is
// COUNTED; everything that is not a flood also gets a line.
export function monitorRecord(mon, port, data, ms) {
  const seen = describeMessage(data);
  const p = portRecord(mon, port || 'unnamed port');
  p.counts.set(seen.name, (p.counts.get(seen.name) || 0) + 1);
  p.total += 1;
  mon.total += 1;
  if (mon.firstMs == null) mon.firstMs = ms;
  mon.lastMs = ms;

  if (!FLOOD.has(seen.family)) {
    mon.rows.push({ ms, port, family: seen.family, text: seen.text, hex: hex(data) });
    if (mon.rows.length > MAX_ROWS) mon.rows.splice(0, mon.rows.length - MAX_ROWS);
  }
  return seen;
}

export function monitorClear(mon) {
  mon.ports.clear();
  mon.rows.length = 0;
  mon.total = 0;
  mon.firstMs = null;
  mon.lastMs = null;
}

// Did any port send this family? Asked by the verdict, which is the part of
// the report that answers the question the monitor was built for.
export function sawFamily(mon, name) {
  for (const p of mon.ports.values()) if ((p.counts.get(name) || 0) > 0) return true;
  return false;
}

function secs(mon) {
  if (mon.firstMs == null || mon.lastMs == null) return 0;
  return Math.max(0, (mon.lastMs - mon.firstMs) / 1000);
}

function clockAt(ms, base) {
  const t = Math.max(0, (ms - base) / 1000);
  return t.toFixed(3).padStart(8, ' ');
}

// The whole thing as plain text, ready to be copied out and read by somebody
// who is not sitting at the machine. Three parts and they answer three
// different questions: what is CONNECTED, what ARRIVED, and — the one this
// exists for — whether anything in the stream carries a tempo.
export function monitorReport(mon, meta = {}) {
  const L = [];
  const inputs = meta.inputs || [];

  L.push('IYDANI — MIDI input monitor');
  const can = meta.supported ? 'supported' : 'NOT SUPPORTED';
  const got = meta.enabled ? 'access granted' : 'access NOT granted';
  const sx = meta.sysex ? 'enabled' : 'not requested';
  L.push(`Web MIDI: ${can}, ${got}, sysex ${sx}`);
  L.push('');

  L.push(`Inputs (${inputs.length})`);
  if (!inputs.length) L.push('  — none. Nothing is connected, or the OS is not reporting it.');
  inputs.forEach(i => {
    const maker = i.manufacturer ? `  [${i.manufacturer}]` : '';
    L.push(`  • ${i.name}${maker}  id ${i.id}`);
  });
  L.push('');

  const span = secs(mon);
  L.push(`Messages: ${mon.total} over ${span.toFixed(1)}s`);
  if (!mon.total) {
    L.push('  — nothing has arrived yet. Play a key, and switch the metronome on');
    L.push('    at the instrument, then look again.');
  }
  for (const [port, p] of mon.ports) {
    L.push(`  ${port}  (${p.total})`);
    [...p.counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([name, n]) => L.push(`      ${String(n).padStart(7, ' ')}  ${name}`));
  }
  L.push('');

  // The verdict. Every line here is a fact about what did or did not arrive,
  // because "this keyboard cannot be followed" and "the app is not listening"
  // are indistinguishable from the outside and are fixed in different places.
  L.push('Can the app take the beat from this keyboard?');
  const rows = [
    ['beat clock (0xF8)', sawFamily(mon, 'beat clock') ? 'YES' : 'not sent'],
    ['start / stop / continue',
      sawFamily(mon, 'start') || sawFamily(mon, 'stop') || sawFamily(mon, 'continue') ? 'YES' : 'not sent'],
    ['song position', sawFamily(mon, 'song position') ? 'YES' : 'not sent'],
    // "not sent" would be a claim this cannot make: with sysex not requested,
    // the browser never delivers one, so silence here is OUR doing and saying
    // the instrument sent nothing would be reporting our own guard as a fact
    // about the keyboard.
    ['sysex', !meta.sysex ? 'not requested' : (sawFamily(mon, 'sysex') ? 'YES' : 'not sent')],
  ];
  rows.forEach(([label, verdict]) => {
    L.push(`  ${label.padEnd(26, '.')} ${verdict}`);
  });
  if (rows[0][1] !== 'YES') {
    L.push('');
    L.push('  No beat clock. The tempo of this keyboard’s metronome is not on the');
    L.push('  wire in any form the MIDI spec defines, so it cannot be read — look');
    L.push('  for MIDI Clock / Sync / Transmit Clock in the instrument’s settings.');
  }
  if (!meta.sysex) {
    L.push('');
    L.push('  Sysex is not requested, so any manufacturer message is invisible here.');
    L.push('  That is deliberate — sysex can rewrite an instrument’s memory.');
  }
  L.push('');

  L.push(`Log (last ${Math.min(mon.rows.length, MAX_ROWS)} messages; clock, active sensing and MTC are counted above, not listed)`);
  if (!mon.rows.length) L.push('  — nothing loggable yet.');
  const base = mon.firstMs ?? 0;
  mon.rows.forEach(r => {
    L.push(`  ${clockAt(r.ms, base)}  ${r.port}  ${r.text}   [${r.hex}]`);
  });
  return L.join('\n');
}

// ---------- the panel ----------
//
// The only part of this file that touches the document. It reuses the legend's
// .lgd-scrim/.lgd card rather than growing a third modal idiom, and repaints
// on a timer only while it is open — a monitor that re-rendered on every
// message would repaint a few hundred times a second under a held pedal.

let liveTimer = null;
let source = null;      // () => { mon, meta }

// Wired by midi-input.js, which owns the monitor and the port list. Passed in
// rather than imported so this module stays free of WebMidi and of state.
export function setMonitorSource(fn) {
  source = fn;
}

function paint() {
  const body = document.getElementById('midiMonBody');
  if (!body || !source) return;
  const { mon, meta } = source();
  body.textContent = monitorReport(mon, meta);
}

export function openMonitor() {
  const overlay = document.getElementById('midiMonOverlay');
  if (!overlay) return;
  overlay.hidden = false;
  paint();
  if (liveTimer == null) liveTimer = setInterval(paint, 400);
}

export function closeMonitor() {
  const overlay = document.getElementById('midiMonOverlay');
  if (overlay) overlay.hidden = true;
  if (liveTimer != null) clearInterval(liveTimer);
  liveTimer = null;
}

// Copy the whole report out. navigator.clipboard is not available in every
// context this app runs in, so a failure falls back to SELECTING the text —
// which leaves the player one Ctrl+C away rather than with a button that
// silently did nothing.
async function copyReport(btn) {
  const body = document.getElementById('midiMonBody');
  if (!body) return;
  const text = body.textContent;
  let done = false;
  try {
    await navigator.clipboard.writeText(text);
    done = true;
  } catch {
    const sel = window.getSelection?.();
    const range = document.createRange();
    range.selectNodeContents(body);
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
  if (!btn) return;
  btn.textContent = done ? 'Copied' : 'Selected — press Ctrl+C';
  setTimeout(() => { btn.textContent = 'Copy'; }, 1800);
}

export function wireMonitor() {
  const overlay = document.getElementById('midiMonOverlay');
  if (!overlay) return;
  document.getElementById('midiMonClose')?.addEventListener('click', closeMonitor);
  const copy = document.getElementById('midiMonCopy');
  copy?.addEventListener('click', () => copyReport(copy));
  document.getElementById('midiMonClear')?.addEventListener('click', () => {
    document.dispatchEvent(new Event('midi:monitor-clear'));
    paint();
  });
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) closeMonitor(); });
  // Modal, so it swallows the keyboard while it is up — otherwise typing over
  // it would go on writing notes onto the staff behind. Captured on the way
  // DOWN so it lands before the note-entry listener.
  document.addEventListener('keydown', e => {
    if (overlay.hidden) return;
    if (e.key === 'Escape') closeMonitor();
    e.stopPropagation();
  }, true);
}
