import assert from 'node:assert/strict';
import { buildMidiFile } from '../src/renderer/midi-file.js';

const note = (svaraIndex, head = 'o', dur = 1) => ({
  n: { type: 'note', svaraIndex, head, oct: 0, dur },
});
const bytes = buildMidiFile([note(0), note(1), note(2, 'f')], {
  bpm: 72,
  saMidi: 60,
  title: 'MIDI test',
});

assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'MThd');
assert.equal(new TextDecoder().decode(bytes.slice(14, 18)), 'MTrk');
assert.deepEqual([...bytes.slice(-3)], [0xff, 0x2f, 0x00]);

const data = [...bytes];
assert.ok(data.some((value, i) => value === 0x90 && data[i + 1] === 60 && data[i + 2] === 88));
assert.ok(data.some((value, i) => value === 0x90 && data[i + 1] === 62 && data[i + 2] === 88));
assert.ok(data.some((value, i) => value === 0x90 && data[i + 1] === 63 && data[i + 2] === 88));

console.log('MIDI export tests passed');
