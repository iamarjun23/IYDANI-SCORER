// What the app REMEMBERS about a connected keyboard, and what it refuses to
// claim about one.
//
// Both halves exist because Web MIDI reports no capabilities whatsoever — the
// whole port object is id/name/manufacturer/version/type/state/connection, so
// key count, velocity support and channel can only be worked out from what the
// device actually sends. Two things follow, and both are pinned here:
//
//   1. that evidence has to SURVIVE a relaunch, or the auto-centre shift is
//      latched against a guessed 49-key range on every first note;
//   2. nothing may be written down before it is proved, because a keyboard
//      with no velocity sensor stamps one fixed value on everything and
//      recording it makes the score claim a dynamic that was never played.

import assert from 'node:assert/strict';
import {
  newVelocityProbe, velocitySeen, velocityToRecord, VELOCITY_VERDICT_AFTER,
} from '../src/renderer/midi-device.js';

let checks = 0;
const is = (a, b, m) => { checks++; assert.deepEqual(a, b, m); };

// ---------- the velocity verdict ----------

// A flat-velocity keyboard: the measured CASIO sends exactly 100 every time.
{
  const p = newVelocityProbe();
  for (let i = 0; i < VELOCITY_VERDICT_AFTER - 1; i++) {
    is(velocitySeen(p, 100), null, `still unknown after ${i + 1} identical notes`);
  }
  is(velocitySeen(p, 100), false, 'one value repeated to the threshold proves NO sensor');
  is(velocitySeen(p, 100), false, 'and the verdict stands');
}

// A real sensor proves itself as soon as two values differ — no waiting.
{
  const p = newVelocityProbe();
  is(velocitySeen(p, 64), null, 'one value proves nothing yet');
  is(velocitySeen(p, 97), true, 'two DIFFERENT values prove a sensor at once');
}

// The asymmetry matters: a sensor found late still overrides nothing, but a
// device that goes flat after proving itself is not un-proved by repetition.
{
  const p = newVelocityProbe();
  velocitySeen(p, 20); velocitySeen(p, 90);
  for (let i = 0; i < 40; i++) velocitySeen(p, 90);
  is(p.verdict, true, 'a proved sensor is never demoted by a run of equal strikes');
}

// ---------- what actually gets written onto the note ----------

{
  const p = newVelocityProbe();
  const written = [];
  for (let i = 0; i < VELOCITY_VERDICT_AFTER; i++) written.push(velocityToRecord(p, 100));
  is(written.every(v => v === null), true,
    'a flat keyboard records NO dynamic on any note — not even a default');
  is(velocityToRecord(p, 100), null, 'and none afterwards');
}

{
  const p = newVelocityProbe();
  is(velocityToRecord(p, 64), null, 'the first note is unproved, so nothing is claimed');
  is(velocityToRecord(p, 30), 30, 'once proved, the real value is recorded');
  is(velocityToRecord(p, 127), 127, 'and every one after it');
}

// A device met before starts already decided, so the FIRST note it plays this
// session is recorded correctly rather than being thrown away while the probe
// re-proves what is already known.
{
  const known = newVelocityProbe(true);
  is(velocityToRecord(known, 42), 42, 'a remembered sensor records from the first note');
  const flat = newVelocityProbe(false);
  is(velocityToRecord(flat, 100), null, 'a remembered flat keyboard never records');
}

// ---------- what survives a relaunch ----------
//
// This half goes through localStorage, which is hand-editable and shared with
// whatever else the origin stores, so nothing coming back out of it is trusted.

const mem = new Map();
globalThis.window = { localStorage: {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
} };

const { state } = await import('../src/renderer/state.js');
const { loadSettings, rememberDevice, deviceMemory, forgetDeviceRange } =
  await import('../src/renderer/settings.js');

loadSettings();
is(deviceMemory('CASIO USB-MIDI'), {}, 'an unknown device is remembered as nothing');

rememberDevice('CASIO USB-MIDI', { low: 63, high: 90 });
is(deviceMemory('CASIO USB-MIDI'), { low: 63, high: 90 }, 'a measured range is kept');

// A session that only played the top half must NOT narrow what is known.
rememberDevice('CASIO USB-MIDI', { low: 72, high: 84 });
is(deviceMemory('CASIO USB-MIDI'), { low: 63, high: 90 },
  'a narrower session widens nothing and shrinks nothing');

rememberDevice('CASIO USB-MIDI', { low: 36, high: 96 });
is(deviceMemory('CASIO USB-MIDI'), { low: 36, high: 96 }, 'a wider session widens it');

rememberDevice('CASIO USB-MIDI', { velocity: false });
is(deviceMemory('CASIO USB-MIDI').velocity, false, 'the velocity verdict is kept');
is(deviceMemory('CASIO USB-MIDI').low, 36, 'and does not disturb the range');

// Devices are independent.
// ---------- the sink latch ----------
//
// A keyboard met for the first time is assumed to be an instrument and is let
// be the sound, rather than having the app's sample layered over the note the
// player can already hear. `sinkSet` records that the choice has been MADE for
// this device — not what it was — so plugging the same piano back in can never
// overturn a player who has since chosen the samples on purpose.
is(deviceMemory('CASIO USB-MIDI').sinkSet, undefined,
  'a device nothing has decided for yet carries no flag');
rememberDevice('CASIO USB-MIDI', { sinkSet: true });
is(deviceMemory('CASIO USB-MIDI').sinkSet, true, 'the decision is recorded');
is(deviceMemory('CASIO USB-MIDI').low, 36, 'and does not disturb the range');
// One-way: nothing un-decides a device, or the default would fire again.
rememberDevice('CASIO USB-MIDI', { sinkSet: false });
is(deviceMemory('CASIO USB-MIDI').sinkSet, true, 'the latch is never cleared');

// ---------- the way back out ----------
//
// The range is a one-way ratchet by design, and for a long time there was
// nothing on the other end of it: one note from below the instrument — a
// second port being listened to, a device left transposed, an octave button
// pressed by accident — drew keys the keyboard does not have, wrote them to
// the store, and brought them back at every launch. The dock's key-count
// picker could not shift them either, because the learned range widens back
// past whatever size is chosen there. forgetDeviceRange() is the picker's
// escape hatch and the ONLY thing here that narrows anything.
is(deviceMemory('CASIO USB-MIDI').low, 36, 'the wide range is there to be forgotten');
forgetDeviceRange('CASIO USB-MIDI');
is(deviceMemory('CASIO USB-MIDI'), { velocity: false, sinkSet: true },
  'the range goes and the proved facts about the device stay');
forgetDeviceRange('CASIO USB-MIDI');
is(deviceMemory('CASIO USB-MIDI'), { velocity: false, sinkSet: true },
  'forgetting twice is not an error');
forgetDeviceRange('never seen');
is(deviceMemory('never seen'), {}, 'forgetting an unknown device writes nothing');
forgetDeviceRange('');
// Re-measuring starts clean rather than widening what was there before.
rememberDevice('CASIO USB-MIDI', { low: 48, high: 84 });
is(deviceMemory('CASIO USB-MIDI').low, 48, 'the next note measured starts a new range');
is(deviceMemory('CASIO USB-MIDI').high, 84, 'and is not widened by the forgotten one');

rememberDevice('Some Other Keyboard', { low: 21, high: 108, velocity: true });
is(deviceMemory('CASIO USB-MIDI').high, 84, 'one device does not overwrite another');
is(deviceMemory('Some Other Keyboard').velocity, true, 'the second device is its own entry');

// It really does round-trip the store, which is the whole point.
state.midiDevices = {};
loadSettings();
is(deviceMemory('CASIO USB-MIDI'), { low: 48, high: 84, velocity: false, sinkSet: true },
  'everything comes back after a reload — the forgotten range included');

// ---------- garbage in the store is refused ----------

const rubbish = {
  'ok device':      { low: 40, high: 50 },
  'backwards':      { low: 90, high: 10 },          // low above high
  'out of range':   { low: -5, high: 999 },         // not MIDI bytes
  'not integers':   { low: 1.5, high: 60.2 },
  'bad velocity':   { low: 40, high: 50, velocity: 'yes' },
  'empty':          {},
  'not an object':  'nonsense',
  'null entry':     null,
};
mem.set('dng.settings.v1', JSON.stringify({ midiDevices: rubbish }));
loadSettings();
is(deviceMemory('ok device'), { low: 40, high: 50 }, 'the good entry survives');
is(deviceMemory('backwards'), {}, 'a reversed range is dropped');
is(deviceMemory('out of range'), {}, 'values outside 0..127 are dropped');
is(deviceMemory('not integers'), {}, 'fractional note numbers are dropped');
is(deviceMemory('bad velocity'), { low: 40, high: 50 },
  'a non-boolean velocity is dropped but the range it came with is kept');
is(deviceMemory('empty'), {}, 'an entry describing nothing is dropped');
is(deviceMemory('not an object'), {}, 'a string entry is dropped');
is(deviceMemory('null entry'), {}, 'a null entry is dropped');

// A store that is not even an object must not throw.
mem.set('dng.settings.v1', JSON.stringify({ midiDevices: [1, 2, 3] }));
loadSettings();
is(state.midiDevices, {}, 'an array where an object belongs falls back to empty');

mem.set('dng.settings.v1', '{ this is not json');
loadSettings();
is(state.midiDevices, {}, 'a corrupt store falls back to the defaults');
is(state.holdWrites, 'time', 'and the other settings still get their defaults');

console.log(`midi-memory: ${checks} checks passed`);
