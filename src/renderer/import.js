// Import from external formats. Both MIDI and MusicXML → the DNG note model.
//
// Sa is whatever the piano's Sa picker says (state.saMidi, 60 by default), and
// every semitone is written exactly — see midi-import.js, which holds the whole
// conversion and is pure so it can be tested without a DOM.

import { state } from './state.js';
import { MIN_BPM, MAX_BPM, TIME_UNITS_PER_BEAT } from './config.js';
import { pushHist } from './history.js';
import { render, updateSheetMeta } from './notation.js';
import { midiToScore, noteFor, restsFor } from './midi-import.js';

function commit(notes, title, bpm) {
  pushHist();
  state.notes = notes;
  state.bars = [];
  state.breaks = [];
  state.lastBreak = null;
  state.preset = null;
  if (bpm) {
    state.bpm = Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(bpm)));
    const el = document.getElementById('bpmVal');
    if (el) el.value = state.bpm;
    updateSheetMeta();
  }
  if (title) {
    state.title = title;
    const el = document.getElementById('titleVal');
    if (el) el.textContent = title;
  }
  render();
}

// ---------- MIDI (Standard MIDI File, format 0 or 1) ----------

export function importMidi(buffer, filename) {
  let score;
  try {
    score = midiToScore(buffer, { saMidi: state.saMidi });
  } catch (err) {
    console.error('[import] MIDI failed:', err);
    alert(`Could not import this MIDI file: ${err.message}`);
    return;
  }
  const title = (filename || 'imported').replace(/(\.(mid|midi))+$/i, '');
  commit(score.notes, title, score.bpm);
  // The staff writes three sthayis. A tune wider than that has to be folded at
  // the edge, which moves those notes an octave off their own line — say so
  // rather than letting them look like the conversion's own wrong notes.
  if (score.folded) {
    alert(`Imported. ${score.folded} of ${score.notes.length} `
      + 'symbols fell outside the three sthayis the staff writes and were moved '
      + 'to the nearest octave that fits.');
  }
}

// ---------- MusicXML (partwise) ----------

const STEP_TO_SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function importMusicXml(text, filename) {
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  if (xml.querySelector('parsererror')) { alert('MusicXML: parse error.'); return; }

  const notes = [];
  const parts = xml.getElementsByTagName('part');
  if (!parts.length) { alert('MusicXML: no <part> found.'); return; }

  // Only the first part — the staff is monophonic.
  const part = parts[0];
  let divisions = 1;
  let bpm = null;

  const measures = part.getElementsByTagName('measure');
  for (const m of measures) {
    const div = m.querySelector('attributes > divisions');
    if (div) divisions = parseInt(div.textContent, 10) || divisions;
    const perMinute = m.querySelector('sound[tempo]')?.getAttribute('tempo')
      || m.querySelector('metronome per-minute')?.textContent;
    if (perMinute && bpm == null) bpm = parseFloat(perMinute) || null;

    for (const child of m.children) {
      if (child.tagName !== 'note') continue;
      if (child.querySelector('chord')) continue;      // keep the top voice only

      const durEl = child.querySelector('duration');
      const beats = durEl ? (parseInt(durEl.textContent, 10) || 0) / divisions : 1;
      const units = Math.round(beats * TIME_UNITS_PER_BEAT);
      if (units <= 0) continue;                        // grace note, no time of its own

      if (child.querySelector('rest')) {
        notes.push(...restsFor(units));
        continue;
      }

      const pitch = child.querySelector('pitch');
      if (!pitch) continue;
      const step = pitch.querySelector('step')?.textContent || 'C';
      const alter = parseInt(pitch.querySelector('alter')?.textContent || '0', 10);
      const octave = parseInt(pitch.querySelector('octave')?.textContent || '4', 10);
      const midi = STEP_TO_SEMI[step] + alter + 12 * (octave + 1);
      notes.push(noteFor(midi, units, state.saMidi));
    }
  }

  if (!notes.length) { alert('MusicXML: no notes found.'); return; }
  const title = (filename || 'imported').replace(/(\.(xml|musicxml|mxl))+$/i, '');
  // `units` is the converter's scratch field; the score model does not carry it.
  commit(notes.map(({ units, ...rest }) => rest), title, bpm);
}
