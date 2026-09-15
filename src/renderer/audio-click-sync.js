// Automatic follower for a keyboard metronome routed into the computer's
// line-in/audio interface. This is deliberately a direct input path: no MIDI
// notes are treated as beats and no room-microphone guessing is performed.
import { audioCtx } from './audio.js';

let stream = null;
let source = null;
let filter = null;
let processor = null;
let mute = null;
let listening = false;
let error = '';
let seen = false;
let lastAt = -Infinity;

export function audioClickState() { return { listening, error, seen }; }
export function audioClickSupported() {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

function clickIn(samples, rate) {
  let peak = 0, at = 0, sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    sum += samples[i] * samples[i];
    if (a > peak) { peak = a; at = i; }
  }
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  // Line-level signals can arrive much quieter than a microphone. The click
  // is still required to be a sharp peak several times above its block RMS,
  // which rejects the steady headphone/room noise without demanding a fixed
  // absolute level from every audio interface.
  return peak > 0.003 && rms > 0.0003 && peak > rms * 1.8 ? at * 1000 / rate : null;
}

export function stopAudioClickSync() {
  try { processor?.disconnect(); filter?.disconnect(); source?.disconnect(); mute?.disconnect(); } catch {}
  stream?.getTracks?.().forEach(t => t.stop());
  stream = source = filter = processor = mute = null;
  listening = false; seen = false; error = '';
}

export async function startAudioClickSync(onBeat, onState = null) {
  if (listening) return true;
  if (!audioClickSupported()) { error = 'audio input unavailable'; onState?.(audioClickState()); return false; }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    // After the permission grant, device labels become available. Prefer a
    // physical line/USB interface over the laptop microphone when one exists.
    const devices = await navigator.mediaDevices.enumerateDevices?.() || [];
    const preferred = devices.find(d => d.kind === 'audioinput' &&
      /line|usb|interface|stereo mix|capture|casio|keyboard/i.test(d.label));
    if (preferred?.deviceId) {
      stream.getTracks().forEach(t => t.stop());
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: preferred.deviceId }, echoCancellation: false,
          noiseSuppression: false, autoGainControl: false },
      });
    }
    const ctx = audioCtx();
    source = ctx.createMediaStreamSource(stream);
    filter = ctx.createBiquadFilter();
    filter.type = 'highpass'; filter.frequency.value = 80;
    processor = ctx.createScriptProcessor(1024, 1, 1);
    mute = ctx.createGain(); mute.gain.value = 0;
    source.connect(filter).connect(processor).connect(mute).connect(ctx.destination);
    processor.onaudioprocess = e => {
      const now = performance.now();
      const hit = clickIn(e.inputBuffer.getChannelData(0), e.inputBuffer.sampleRate);
      if (hit == null || now - lastAt < 240) return;
      lastAt = now; seen = true;
      onBeat?.(now - (e.inputBuffer.duration * 1000) + hit);
      onState?.(audioClickState());
    };
    listening = true; error = ''; onState?.(audioClickState());
    return true;
  } catch {
    stopAudioClickSync(); error = 'audio input blocked'; onState?.(audioClickState()); return false;
  }
}
