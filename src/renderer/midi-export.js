import { state } from './state.js';
import { buildPlaySeq } from './playback.js';
import { buildMidiFile } from './midi-file.js';
import { beatsPerBox } from './timesig.js';

function safeName(title) {
  const clean = String(title || 'untitled')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 100);
  return clean || 'untitled';
}

export function exportMIDI() {
  try {
    const bytes = buildMidiFile(buildPlaySeq(), {
      bpm: state.bpm,
      saMidi: state.saMidi,
      title: state.title,
      beatsPerBar: beatsPerBox(),
    });
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/midi' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${safeName(state.title)}.mid`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    console.error('[midi] export failed:', err);
    window.alert(`Could not export MIDI: ${err.message}`);
  }
}
