const BLOCK_SIZE = 1152;

export function floatToInt16(input) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const value = Math.max(-1, Math.min(1, input[i]));
    output[i] = value < 0 ? Math.round(value * 32768) : Math.round(value * 32767);
  }
  return output;
}

export async function encodeAudioBufferToMp3(audioBuffer, Encoder, options = {}) {
  if (typeof Encoder !== 'function') throw new Error('The MP3 encoder is unavailable.');
  const channels = Math.min(2, audioBuffer.numberOfChannels || 1);
  const sampleRate = audioBuffer.sampleRate;
  const kbps = options.kbps || 128;
  const encoder = new Encoder(channels, sampleRate, kbps);
  const left = audioBuffer.getChannelData(0);
  const right = channels === 2 ? audioBuffer.getChannelData(1) : null;
  const chunks = [];
  let totalBytes = 0;

  const addChunk = chunk => {
    if (!chunk || !chunk.length) return;
    const copy = new Uint8Array(chunk);
    chunks.push(copy);
    totalBytes += copy.length;
  };

  for (let offset = 0, block = 0; offset < audioBuffer.length; offset += BLOCK_SIZE, block++) {
    const end = Math.min(offset + BLOCK_SIZE, audioBuffer.length);
    const leftPcm = floatToInt16(left.subarray(offset, end));
    const encoded = channels === 2
      ? encoder.encodeBuffer(leftPcm, floatToInt16(right.subarray(offset, end)))
      : encoder.encodeBuffer(leftPcm);
    addChunk(encoded);
    if (block > 0 && block % 128 === 0) {
      await (options.yieldControl ? options.yieldControl() : Promise.resolve());
    }
  }
  addChunk(encoder.flush());

  const bytes = new Uint8Array(totalBytes);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}
