// MIDI → DNG score conversion. Pure: no DOM, no state, no rendering — so the
// whole converter is testable in node and import.js stays thin wiring.
//
// Three things have to come out right, and the old converter got all three
// wrong:
//
//   PITCH   A written note sounds through semiOf(), which reads SVARA_TONES
//           (Ri natural = 2, lowered = 1, ...). The converter used to snap the
//           incoming semitone to the nearest SVARAS[i].semi — the Mayamalavagowla
//           table — so an imported C major scale came back C C# E F G Ab B.
//           SVARA_TONES covers all twelve semitones exactly (7 naturals + 5
//           variants), so nothing needs snapping at all: the semitone chooses a
//           rung AND a goli, and what is written sounds what was imported.
//
//   OCTAVE  `Math.round(rel / 12)` put everything a fifth or more above Sa into
//           the next sthayi — madhya Pa imported as taara Pa. It is a floor
//           division, not a rounding.
//
//   RHYTHM  Every note used to become `sym: 'bindu'` with a beat count rounded
//           to 1..4, so an eighth note lasted a whole beat, the glyph disagreed
//           with its own `dur`, and rests between notes vanished. Durations are
//           now quantised onto the danta grid and written as the symbol (plus
//           chukki) that actually carries that weight, with real rests filling
//           the gaps.

import {
  SOUND, REST_MAP, SVARA_TONES, DOT_MULT, TIME_UNITS_PER_BEAT,
  MIN_BPM, MAX_BPM, BPM,
} from './config.js';

// ---------- pitch ----------

// One entry per semitone class. Naturals are written first and are never
// overwritten, so a semitone that is some svara's natural is always written as
// that svara with a hollow goli, and only the five leftovers take a filled one.
export const SEMI_TO_WRITTEN = (() => {
  const table = new Array(12);
  SVARA_TONES.forEach((tone, svaraIndex) => {
    table[tone.natural % 12] = { svaraIndex, head: 'o' };
  });
  SVARA_TONES.forEach((tone, svaraIndex) => {
    if (tone.variant == null) return;
    const pc = tone.variant % 12;
    if (!table[pc]) table[pc] = { svaraIndex, head: 'f' };
  });
  return table;
})();

// ---------- duration ----------

const UNITS = TIME_UNITS_PER_BEAT;

// A chukki is only writable where it lands on a whole danta, which is every
// symbol except danta itself (1 unit x 1.5 = 1.5).
const GLYPH_UNITS = (() => {
  const out = [];
  for (const [sym, v] of Object.entries(SOUND)) {
    const units = Math.round(v.dur * UNITS);
    out.push({ sym, dot: false, units, dur: v.dur, deco: v.deco });
    const dotted = v.dur * DOT_MULT * UNITS;
    if (Number.isInteger(dotted)) {
      out.push({ sym, dot: true, units: dotted, dur: v.dur * DOT_MULT, deco: v.deco });
    }
  }
  return out.sort((a, b) => b.units - a.units);
})();

const MIN_UNITS = GLYPH_UNITS[GLYPH_UNITS.length - 1].units;
const MAX_UNITS = GLYPH_UNITS[0].units;

// Rest values, largest first — undotted only, since padRests writes rests the
// same way and a dotted rest has no glyph of its own.
const REST_OF = Object.fromEntries(
  Object.entries(REST_MAP).map(([restKey, sound]) => [sound, restKey]),
);
const REST_UNITS = Object.entries(SOUND)
  .map(([sym, v]) => ({ sym, units: Math.round(v.dur * UNITS), dur: v.dur }))
  .sort((a, b) => b.units - a.units);

// The single glyph closest to `units`. Nearest in RATIO, not in difference: at
// these weights an eighth of a beat out matters far more near a danta than near
// a Maguru.
// `cap` is the most units the caller can afford to spend. Nearest-in-ratio can
// round UP — a 1.25-beat span is closer in ratio to a dotted guru (1.5) than to
// a guru (1) — and midiToScore() advances its cursor by the units the glyph
// actually carries, so an overrun does not just mis-time one note: it pushes
// every note after it later, off the grid the rest of the file sits on.
export function glyphForUnits(units, cap = Infinity) {
  const want = Math.min(MAX_UNITS, Math.max(MIN_UNITS, units));
  let best = null;
  let bestErr = Infinity;
  for (const g of GLYPH_UNITS) {
    if (g.units > cap) continue;
    const err = Math.abs(Math.log(g.units / want));
    if (err < bestErr - 1e-9) { best = g; bestErr = err; }
  }
  // Nothing is short enough — even a danta overruns. Write the danta anyway:
  // the staff has no shorter symbol, and dropping the note is worse.
  return best || GLYPH_UNITS[GLYPH_UNITS.length - 1];
}

export function noteFor(midi, units, saMidi = 60, cap = Infinity) {
  const rel = Math.round(midi) - Math.round(saMidi);
  // Floor, not round: pitches 6..11 semitones above Sa belong to the SAME
  // sthayi as Sa, not the one above it.
  let oct = Math.floor(rel / 12);
  const pc = rel - oct * 12;
  oct = Math.max(-1, Math.min(1, oct));
  const written = SEMI_TO_WRITTEN[pc] || SEMI_TO_WRITTEN[0];
  const g = glyphForUnits(units, cap);
  return {
    type: 'note',
    svaraIndex: written.svaraIndex,
    oct,
    head: written.head,
    sym: g.sym,
    dot: g.dot,
    dur: g.dur,
    deco: g.deco,
    units: g.units,
  };
}

export function restsFor(units) {
  const out = [];
  let left = Math.round(units);
  for (const r of REST_UNITS) {
    while (left >= r.units) {
      out.push({ type: 'rest', sym: REST_OF[r.sym] || 'rest_symbol_1', dur: r.dur, units: r.units });
      left -= r.units;
    }
  }
  return out;
}

// ---------- Standard MIDI File parsing ----------

function readVarLen(bytes, pos) {
  let v = 0, b;
  do {
    b = bytes[pos.i++];
    v = (v << 7) | (b & 0x7f);
  } while (b & 0x80);
  return v;
}

function u32(bytes, i) {
  return ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
}
function u16(bytes, i) { return (bytes[i] << 8) | bytes[i + 1]; }

// Returns { notes, tpq, bpm, trackNames } — notes as absolute ticks, every
// track and channel kept so the melody picker below can choose between them.
export function parseMidi(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes[0] !== 0x4d || bytes[1] !== 0x54 || bytes[2] !== 0x68 || bytes[3] !== 0x64) {
    throw new Error('Not a MIDI file (missing MThd)');
  }
  const headerLen = u32(bytes, 4);
  const division = u16(bytes, 12);
  if (division & 0x8000) throw new Error('SMPTE time division is not supported');
  const tpq = division || 480;

  const notes = [];
  const trackNames = new Map();
  let bpm = null;
  let pos = 8 + headerLen;
  let track = 0;

  while (pos + 8 <= bytes.length) {
    const isTrack = bytes[pos] === 0x4d && bytes[pos + 1] === 0x54
      && bytes[pos + 2] === 0x72 && bytes[pos + 3] === 0x6b;
    const len = u32(bytes, pos + 4);
    const end = Math.min(bytes.length, pos + 8 + len);
    if (!isTrack) { pos = end; continue; }

    const cur = { i: pos + 8 };
    track++;
    let tick = 0;
    let runningStatus = 0;
    // One slot per channel/pitch. A second note-on for a pitch already sounding
    // closes the first, which is what every reader does with a stuck note.
    const open = new Map();

    while (cur.i < end) {
      const dt = readVarLen(bytes, cur);
      tick += dt;
      let status = bytes[cur.i];
      if (status < 0x80) {
        status = runningStatus;
      } else {
        cur.i++;
        // Meta and sysex CANCEL running status; only channel messages set it.
        runningStatus = status < 0xf0 ? status : 0;
      }
      const type = status & 0xf0;
      const channel = status & 0x0f;

      if (status === 0xff) {
        const metaType = bytes[cur.i++];
        const mlen = readVarLen(bytes, cur);
        if (metaType === 0x51 && mlen === 3) {
          const micros = (bytes[cur.i] << 16) | (bytes[cur.i + 1] << 8) | bytes[cur.i + 2];
          if (micros > 0 && bpm == null) bpm = 60000000 / micros;
        } else if ((metaType === 0x03 || metaType === 0x04) && !trackNames.has(track)) {
          // 0x03 track name, 0x04 instrument name — a file that labels its parts
          // is telling the picker which one is the tune.
          trackNames.set(track, new TextDecoder().decode(bytes.slice(cur.i, cur.i + mlen)));
        }
        cur.i += mlen;
        if (metaType === 0x2f) break;
      } else if (status === 0xf0 || status === 0xf7) {
        cur.i += readVarLen(bytes, cur);
      } else if (type === 0x90 || type === 0x80) {
        const midi = bytes[cur.i++];
        const vel = bytes[cur.i++];
        const key = `${channel}:${midi}`;
        const started = open.get(key);
        if (type === 0x90 && vel > 0) {
          // A second note-on at the SAME tick is a unison doubling — two parts
          // playing the same line written into one channel — not a stuck note.
          // Closing the first one there yields a zero-length note, which is not
          // a note at all and which coveredTime() cannot ever close again.
          if (started != null && tick > started) {
            notes.push({ start: started, end: tick, midi, track, channel });
          }
          open.set(key, tick);
        } else if (started != null) {
          if (tick > started) notes.push({ start: started, end: tick, midi, track, channel });
          open.delete(key);
        }
      } else if (type === 0xa0 || type === 0xb0 || type === 0xe0) {
        cur.i += 2;
      } else if (type === 0xc0 || type === 0xd0) {
        cur.i += 1;
      } else {
        cur.i += 1;                       // unknown byte — step past it
      }
    }
    // Anything still held at end of track sounds to the end of the track.
    for (const [key, started] of open) {
      if (tick <= started) continue;
      notes.push({ start: started, end: tick, midi: Number(key.split(':')[1]), track, channel: Number(key.split(':')[0]) });
    }
    pos = end;
  }

  notes.sort((a, b) => a.start - b.start || b.midi - a.midi);
  return { notes, tpq, bpm, trackNames };
}

// ---------- melody extraction ----------

// How much of each note is drowned out by a higher-pitched note sounding at the
// same time. A sweep over the boundary times, so a big file does not turn into
// an n-squared overlap test.
function coveredTime(notes) {
  const covered = new Array(notes.length).fill(0);
  const edges = [];
  notes.forEach((n, i) => {
    // A note with no length has both edges at the same tick, and the sort below
    // puts its CLOSE before its OPEN — so it would be added to `active` and
    // never removed, holding `top` up for the whole rest of the file and
    // burying every real note underneath it. It covers nothing; skip it.
    if (!(n.end > n.start)) return;
    edges.push({ t: n.start, i, open: true });
    edges.push({ t: n.end, i, open: false });
  });
  edges.sort((a, b) => a.t - b.t || (a.open ? 1 : 0) - (b.open ? 1 : 0));

  const active = new Set();
  let prev = edges.length ? edges[0].t : 0;
  for (const e of edges) {
    if (e.t > prev && active.size > 1) {
      let top = -Infinity;
      for (const i of active) top = Math.max(top, notes[i].midi);
      for (const i of active) if (notes[i].midi < top) covered[i] += e.t - prev;
    }
    prev = e.t;
    if (e.open) active.add(e.i); else active.delete(e.i);
  }
  return covered;
}

// An accompaniment note that sounds in a gap in the melody is exposed, so the
// coverage test above keeps it and the melody comes out with the bass line
// spliced into its rests. A melody stays in a register: compare each note with
// the median of its NEIGHBOURS rather than of the whole piece — a genuinely low
// passage carries its own median down with it, so only isolated dives get cut.
const REGISTER_WINDOW = 8;
const REGISTER_DROP = 12;      // an octave below its neighbours is not melody

function dropAccompaniment(line) {
  if (line.length < 4) return line;
  const kept = line.filter((n, i) => {
    const near = line
      .slice(Math.max(0, i - REGISTER_WINDOW), i + REGISTER_WINDOW + 1)
      .map(x => x.midi)
      .sort((a, b) => a - b);
    const median = near[Math.floor(near.length / 2)];
    return n.midi >= median - REGISTER_DROP;
  });
  return kept.length ? kept : line;
}

// How thick a part is: sounding time counted with overlaps, over sounding time
// counted once. A melody is ~1.0, a chord pad is 2 or more.
function polyphonyOf(group) {
  const held = group.reduce((a, n) => a + (n.end - n.start), 0);
  const spans = group.map(n => [n.start, n.end]).sort((a, b) => a[0] - b[0]);
  let union = 0;
  let [from, to] = spans[0];
  for (const [start, end] of spans.slice(1)) {
    if (start > to) { union += to - from; from = start; to = end; }
    else to = Math.max(to, end);
  }
  union += to - from;
  return union > 0 ? held / union : 1;
}

const MELODY_WORDS = /melod|vocal|voice|sing|lead|solo|tune|flute|violin|right hand/i;
const ACCOMP_WORDS = /bass|left hand|drum|perc|chord|pad|rhythm|accompan|harmon|backing|strings/i;

// Which part carries the tune. NOT simply the busiest one — an arpeggiated
// accompaniment has far more notes than the line it accompanies, and picking it
// hands back a score that is recognisably the wrong half of the song. A melody
// is thin (one note at a time), sits above the accompaniment, and is often
// labelled as itself.
export function scoreGroup(group, name) {
  const mean = group.reduce((a, n) => a + n.midi, 0) / group.length;
  const poly = polyphonyOf(group);
  let score = Math.log2(group.length)
    - 2 * Math.max(0, poly - 1.15)      // chords are not melody
    + (mean - 60) / 12;                 // the tune sits on top
  if (name && MELODY_WORDS.test(name)) score += 2;
  if (name && ACCOMP_WORDS.test(name)) score -= 2;
  return score;
}

// The staff is monophonic, so a file with chords or an accompaniment has to be
// reduced to one line. Take the part that scores highest above, drop the notes
// that spend most of their life underneath a higher one — that is what an
// accompaniment IS, and the alternative is a melody with the bass line spliced
// into its gaps — then keep the top voice of whatever still overlaps.
export function pickMelody(notes, trackNames = new Map()) {
  const groups = new Map();
  for (const n of notes) {
    if (n.channel === 9) continue;        // GM percussion
    const key = `${n.track}:${n.channel}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }
  let pool = [...groups.entries()]
    .map(([key, group]) => ({
      group,
      score: scoreGroup(group, trackNames.get(Number(key.split(':')[0]))),
    }))
    .sort((a, b) => b.score - a.score)[0]?.group;
  if (!pool || !pool.length) pool = notes.slice();
  pool = pool.slice().sort((a, b) => a.start - b.start || b.midi - a.midi);

  const covered = coveredTime(pool);
  let exposed = pool.filter((n, i) => covered[i] < (n.end - n.start) * 0.5);
  if (!exposed.length) exposed = pool;
  exposed = dropAccompaniment(exposed);

  const line = [];
  for (const n of exposed) {
    const prev = line[line.length - 1];
    if (prev) {
      if (n.start <= prev.start) continue;               // chord tone under the top note
      if (n.start < prev.end) prev.end = n.start;        // overlap: cut the held note short
    }
    line.push({ start: n.start, end: Math.max(n.end, n.start + 1), midi: n.midi });
  }
  return line;
}

// ---------- register ----------

// The staff writes three sthayis and no more: mandra Sa a twelfth below the
// tonic up to taara Ni, 36 semitones in all. A melody that pokes out of that is
// FOLDED at the edge, which drops a single note an octave and breaks the
// contour of the phrase it sits in — the ear hears that as a wrong note, not as
// a transposition.
//
// So move the whole line by whole octaves first, which costs nothing musically:
// every interval survives, the tune is simply written lower or higher. Only
// what still will not fit gets folded. Ties go to leaving the register alone.
export const WRITABLE_LOW = -12;
export const WRITABLE_HIGH = 23;

export function octaveShiftFor(midis, saMidi = 60) {
  const fits = shift => midis.reduce((count, midi) => {
    const rel = midi + shift * 12 - saMidi;
    return count + (rel >= WRITABLE_LOW && rel <= WRITABLE_HIGH ? 1 : 0);
  }, 0);
  let best = 0;
  let bestFit = fits(0);
  for (const shift of [-1, 1, -2, 2, -3, 3]) {
    const fit = fits(shift);
    if (fit > bestFit) { best = shift; bestFit = fit; }
  }
  return best;
}

// ---------- tempo / grid ----------

// How many DNG beats one quarter note becomes. A file written in sixteenths
// reads far better as one beat per sixteenth at four times the tempo than as a
// wall of praya, and a slow file in whole notes reads better the other way. The
// tempo compensates so the import still plays back at the speed it was written.
const SCALES = [4, 2, 1, 0.5, 0.25];

export function pickScale(line, tpq, sourceBpm) {
  if (!line.length) return 1;
  let best = 1;
  let bestScore = -Infinity;
  for (const scale of SCALES) {
    const bpm = (sourceBpm || BPM) * scale;
    if (bpm < MIN_BPM || bpm > MAX_BPM) continue;
    let score = 0;
    for (const n of line) {
      const units = ((n.end - n.start) / tpq) * scale * UNITS;
      if (units < MIN_UNITS * 0.75 || units > MAX_UNITS) { score -= 1; continue; }
      const g = glyphForUnits(units);
      // Reward a duration that lands on a writable value; a 3% window is well
      // inside what a human performance wanders by.
      score += Math.abs(Math.log(g.units / units)) < 0.03 ? 1 : 0.25;
    }
    // Break ties toward leaving the tempo alone.
    score += scale === 1 ? 0.5 : 0;
    if (score > bestScore) { bestScore = score; best = scale; }
  }
  return best;
}

// ---------- the conversion ----------

export function midiToScore(buffer, options = {}) {
  const saMidi = Number(options.saMidi ?? 60);
  const { notes, tpq, bpm: sourceBpm, trackNames } = parseMidi(buffer);
  const line = pickMelody(notes, trackNames);
  if (!line.length) throw new Error('No notes found in this MIDI file.');

  const scale = pickScale(line, tpq, sourceBpm);
  const shift = octaveShiftFor(line.map(n => n.midi), saMidi) * 12;
  const toUnits = ticks => (ticks / tpq) * scale * UNITS;
  const out = [];
  let cursor = 0;                          // where the written score has got to
  let folded = 0;                          // notes the staff's range could not hold

  line.forEach((n, k) => {
    const start = Math.round(toUnits(n.start));
    const gap = start - cursor;
    if (gap >= MIN_UNITS) {
      const rests = restsFor(gap);
      out.push(...rests);
      cursor += rests.reduce((a, r) => a + r.units, 0);
    }
    // Never let a note run into the next attack: the staff has no overlap, and
    // a sustain pedal in the source would otherwise swallow the melody.
    const room = line[k + 1]
      ? Math.max(MIN_UNITS, Math.min(Math.round(toUnits(line[k + 1].start)) - start, MAX_UNITS))
      : null;
    const held = Math.max(MIN_UNITS, Math.round(toUnits(n.end - n.start)));
    // A gap SHORTER than the note in front of it is ARTICULATION, not silence.
    // Staccato and a lifted finger both leave one, and writing each as a rest
    // doubles the glyph count for music that reads as a plain run of notes — so
    // a note that fills more than half the distance to the next attack is
    // written all the way up to it. Anything shorter keeps its own length and
    // the remainder becomes a real rest below.
    //
    // Strictly more than half: at exactly half the gap is as long as the note,
    // which is a rest by this rule's own wording, not articulation. It read
    // `>=` while the exporter still cut every note to 0.92 of its value — that
    // gate kept `held` off the boundary, so the difference never showed. With
    // the gate gone an evenly-pulsed staccato line (Winter's opening is one)
    // lands exactly on it, and `>=` welded every note to the next, turning a
    // pulse into a legato drone.
    const span = room == null ? held : (held * 2 > room ? room : Math.min(held, room));
    // `room` is also a CAP, not just a target: a glyph that overruns the next
    // attack drags every note after it off the grid. See glyphForUnits().
    out.push(noteFor(n.midi + shift, span, saMidi, room ?? Infinity));
    cursor = Math.max(cursor, start) + out[out.length - 1].units;

    // The staff writes 36 semitones. A melody wider than that cannot be written
    // whole however it is transposed, so what will not fit is folded to the
    // nearest octave that does — which breaks the contour of the phrase it sits
    // in. That is forced, but it must not be SILENT: count it so the caller can
    // say so.
    const rel = Math.round(n.midi + shift) - Math.round(saMidi);
    if (rel < WRITABLE_LOW || rel > WRITABLE_HIGH) folded++;
  });

  const bpm = Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round((sourceBpm || BPM) * scale)));
  // `units` was scratch for the packer above; the score model does not carry it.
  const clean = out.map(({ units, ...rest }) => rest);
  return { notes: clean, bpm, scale, shift: shift / 12, sourceBpm: sourceBpm || null, folded };
}
