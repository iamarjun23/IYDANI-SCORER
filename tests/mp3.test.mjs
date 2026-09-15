import assert from 'node:assert/strict';
import { Mp3Encoder } from '@breezystack/lamejs';
import { floatToInt16, encodeAudioBufferToMp3 } from '../src/renderer/mp3-encoder.js';

assert.deepEqual(
  [...floatToInt16(Float32Array.from([-2, -1, -0.5, 0, 0.5, 1, 2]))],
  [-32768, -32768, -16384, 0, 16384, 32767, 32767],
);

const sampleRate = 44100;
const length = Math.round(sampleRate * 0.15);
const channel = new Float32Array(length);
for (let i = 0; i < length; i++) channel[i] = Math.sin(2 * Math.PI * 440 * i / sampleRate) * 0.25;

const audioBuffer = {
  numberOfChannels: 2,
  sampleRate,
  length,
  getChannelData: () => channel,
};
const mp3 = await encodeAudioBufferToMp3(audioBuffer, Mp3Encoder);
assert.ok(mp3.length > 500, 'encoded MP3 should contain audio frames');
assert.equal(mp3[0], 0xff, 'MP3 should begin with a frame sync byte');
assert.equal(mp3[1] & 0xe0, 0xe0, 'MP3 should contain a valid frame sync header');

console.log('MP3 encoder tests passed');
