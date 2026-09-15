import { semiOf } from './config.js';

const TICKS_PER_QUARTER = 480;

function be16(value) {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function be32(value) {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function variableLength(value) {
  let buffer = value & 0x7f;
  const bytes = [];
  while ((value >>= 7)) {
    buffer <<= 8;
    buffer |= (value & 0x7f) | 0x80;
  }
  while (true) {
    bytes.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>= 8;
    else break;
  }
  return bytes;
}

function textMeta(type, text) {
  const encoded = new TextEncoder().encode(String(text || 'Untitled'));
  return [0xff, type, ...variableLength(encoded.length), ...encoded];
}

export function buildMidiFile(sequence, options = {}) {
  const bpm = Math.max(20, Math.min(320, Number(options.bpm) || 120));
  const saMidi = Math.max(0, Math.min(127, Math.round(options.saMidi ?? 60)));
  // The metre, so the file bars the way the sheet does. A DNG time signature is
  // a beat COUNT over an implied 4 — every SOUND duration is in beats and a
  // bindu is one beat by definition, so there is no denominator to carry. The
  // additive formula (3+2+2) has no expression in a MIDI time signature; the
  // sum is what a DAW can act on, and it is what the sheet prints as T.S.
  const beatsPerBar = Math.max(1, Math.min(255, Math.round(Number(options.beatsPerBar) || 4)));
  const attacks = [];
  let units = 0;

  for (const item of sequence) {
    const n = item.n;
    const dur = Number(n.dur) || 1;
    // One written beat is one quarter note, matching playback.js and the
    // metronome, so the file lines up with a DAW click at the same bpm.
    const start = Math.round(units * TICKS_PER_QUARTER);
    if (n.type === 'note' && !n.tie) {
      const pitch = Math.max(0, Math.min(127,
        saMidi + semiOf(n.svaraIndex, n.head) + 12 * (Number(n.oct) || 0)));
      // A note is written for its FULL value. Cutting it to 0.92 of that — which
      // this did — leaves a gap before every single onset, puts every duration
      // off the tick grid it was written on (110 ticks where a danta is 120), so
      // the file will not round-trip through our own importer. The overlap guard
      // below is what keeps a repeated pitch from running into itself; it does
      // not need help from a blanket gate. config.js says the same about
      // playback, where the factor was already removed.
      const nominalEnd = start + Math.max(1,
        Math.round((Number(n.full) || dur) * TICKS_PER_QUARTER));
      // A recorded take carries how hard each key was struck; a typed one does
      // not, and 88 is the level everything sounded at before velocity was kept.
      const vel = Math.max(1, Math.min(127, Math.round(Number(n.vel) || 88)));
      attacks.push({ start, nominalEnd, pitch, vel });
    }
    units += dur;
  }

  if (!attacks.length) throw new Error('Add at least one note before exporting MIDI.');
  const events = [];
  attacks.forEach((note, index) => {
    const nextStart = attacks[index + 1]?.start;
    const end = nextStart == null
      ? note.nominalEnd
      : Math.max(note.start + 1, Math.min(note.nominalEnd, nextStart - 1));
    events.push({ tick: note.start, order: 1, bytes: [0x90, note.pitch, note.vel] });
    events.push({ tick: end, order: 0, bytes: [0x80, note.pitch, 0] });
  });
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const microsPerQuarter = Math.round(60000000 / bpm);
  const track = [
    0, ...textMeta(0x03, options.title),
    0, 0xff, 0x51, 0x03,
    (microsPerQuarter >>> 16) & 0xff,
    (microsPerQuarter >>> 8) & 0xff,
    microsPerQuarter & 0xff,
    // nn/2^dd, then MIDI clocks per beat and 32nds per quarter. dd = 2 is the
    // implied 4; 24 clocks is one click a beat, matching the metronome.
    0, 0xff, 0x58, 0x04, beatsPerBar, 0x02, 24, 8,
    0, 0xc0, 0x00, // Acoustic Grand Piano
  ];

  let previousTick = 0;
  for (const event of events) {
    track.push(...variableLength(event.tick - previousTick), ...event.bytes);
    previousTick = event.tick;
  }
  const scoreEnd = Math.max(previousTick, Math.round(units * TICKS_PER_QUARTER));
  track.push(...variableLength(scoreEnd - previousTick), 0xff, 0x2f, 0x00);

  return Uint8Array.from([
    0x4d, 0x54, 0x68, 0x64, ...be32(6), ...be16(0), ...be16(1), ...be16(TICKS_PER_QUARTER),
    0x4d, 0x54, 0x72, 0x6b, ...be32(track.length), ...track,
  ]);
}
