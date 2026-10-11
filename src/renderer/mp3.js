import { state } from './state.js';
import { buildPlaySeq } from './playback.js';
import { renderSequenceOffline } from './audio.js';
import { encodeAudioBufferToMp3 } from './mp3-encoder.js';
import { renderClicks } from './metronome.js';

let exporting = false;

function fileName(title) {
  const clean = String(title || 'untitled')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 100);
  return `${clean || 'untitled'}.mp3`;
}

function download(bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName(state.title);
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportMP3() {
  if (exporting) return;
  const button = document.getElementById('bMp3');
  const oldTitle = button?.title;
  exporting = true;
  if (button) {
    button.disabled = true;
    button.title = 'Rendering MP3…';
    button.setAttribute('aria-busy', 'true');
  }

  try {
    const sequence = buildPlaySeq();
    // Always with the metronome, in the chosen sound, whether or not it is
    // switched on in the editor.
    const audioBuffer = await renderSequenceOffline(sequence, state.bpm, renderClicks);
    const Encoder = window.lamejs?.Mp3Encoder;
    const bytes = await encodeAudioBufferToMp3(audioBuffer, Encoder, {
      kbps: 128,
      yieldControl: () => new Promise(resolve => setTimeout(resolve, 0)),
    });
    download(bytes);
  } catch (err) {
    console.error('[mp3] export failed:', err);
    window.alert(`Could not export MP3: ${err.message}`);
  } finally {
    exporting = false;
    if (button) {
      button.disabled = false;
      button.title = oldTitle || 'Export MP3';
      button.removeAttribute('aria-busy');
    }
  }
}
