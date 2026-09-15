// The MIDI monitor — src/renderer/midi-monitor.js.
//
// This is the tool that settles arguments about what an instrument transmits,
// so it has to be right about the bytes. A decoder that quietly mislabels one
// message does not throw; it produces a confident, wrong answer to the only
// question the monitor exists for — and somebody then goes looking for a
// setting on their piano that was never the problem.
//
// The decoder and the log are pure, so all of it is reachable here with no
// device and no browser.

import assert from 'node:assert/strict';
import {
  hex, describeMessage, newMonitor, monitorRecord, monitorClear, monitorReport,
  sawFamily, MAX_ROWS,
} from '../src/renderer/midi-monitor.js';

let checks = 0;
const is = (a, b, m) => { checks++; assert.equal(a, b, m); };
const ok = (c, m) => { checks++; assert.ok(c, m); };
const has = (s, sub, m) => { checks++; assert.ok(s.includes(sub), `${m} — missing ${JSON.stringify(sub)}`); };

// ---------- hex ----------

is(hex([0x90, 0x3C, 0x64]), '90 3C 64', 'bytes come out padded and upper-case');
is(hex([0x09]), '09', 'a single digit is padded');
is(hex(null), '', 'nothing in, nothing out');

// ---------- channel messages ----------

{
  const on = describeMessage([0x90, 60, 100]);
  is(on.family, 'noteon');
  has(on.text, 'C4', 'middle C is named the way a keyboard prints it');
  has(on.text, 'vel 100', 'and the velocity is stated, since it is the evidence for a sensor');
  has(on.text, 'ch 1', 'channel is 1-based, as every instrument labels it');

  // The form nearly every keyboard actually sends. Counting it as a note on
  // would make every dump claim twice as many notes as were played.
  const zero = describeMessage([0x90, 60, 0]);
  is(zero.family, 'noteoff', 'a velocity-zero note-on IS a note off');
  has(zero.text, 'as note-on', 'and says so, because the byte on the wire was 0x90');

  is(describeMessage([0x83, 48, 64]).family, 'noteoff');
  has(describeMessage([0x83, 48, 64]).text, 'ch 4', 'the low nibble is the channel');
}

{
  const cc = describeMessage([0xB0, 64, 127]);
  is(cc.family, 'cc');
  has(cc.text, 'CC 64 (sustain pedal) = 127', 'the pedal is named, since it is the one people look for');

  const odd = describeMessage([0xB0, 33, 7]);
  has(odd.text, 'CC 33 = 7', 'an unnamed controller still prints its number');
  ok(!odd.text.includes('('), 'and invents no name for it');
}

is(describeMessage([0xC5, 12]).family, 'program');
is(describeMessage([0xD0, 40]).family, 'pressure');
is(describeMessage([0xA0, 60, 40]).family, 'polypressure');

{
  // 14 bits, LSB first, centred on 8192.
  const centre = describeMessage([0xE0, 0x00, 0x40]);
  has(centre.text, 'pitch bend 0', 'centre is zero, not 8192');
  has(describeMessage([0xE0, 0x00, 0x00]).text, 'pitch bend -8192', 'and full down is negative');
}

// ---------- system messages ----------
//
// These are the ones the whole feature turns on.

is(describeMessage([0xF8]).family, 'clock', 'the beat clock');
is(describeMessage([0xFA]).family, 'start');
is(describeMessage([0xFB]).family, 'continue');
is(describeMessage([0xFC]).family, 'stop');
is(describeMessage([0xFE]).family, 'activesensing');
is(describeMessage([0xFF]).family, 'reset');
is(describeMessage([0xF1, 0x23]).family, 'mtc');

{
  // Song position is 14 bits in sixteenths, LSB first. 16 sixteenths is beat 4.
  const spp = describeMessage([0xF2, 16, 0]);
  is(spp.family, 'songposition');
  has(spp.text, '16 sixteenths', 'counted in sixteenths, which is what the spec says');
  has(spp.text, 'beat 4.00', 'and translated, because nobody thinks in sixteenths');
}

{
  const sx = describeMessage([0xF0, 0x43, 0x10, 0x4C, 0xF7]);
  is(sx.family, 'sysex');
  has(sx.text, 'Yamaha', 'the maker byte is named where it is known');
  has(sx.text, 'F0 43 10 4C F7', 'and the whole message is there in hex, since that is the point');
  has(describeMessage([0xF0, 0x11, 0xF7]).text, 'maker 0x11', 'an unknown maker prints its id');
}

// A stray data byte is not decodable on its own and must not be guessed at.
is(describeMessage([0x40, 0x50]).family, 'data');
is(describeMessage([]).family, 'empty');
is(describeMessage(null).family, 'empty');

// ---------- the log ----------

{
  const mon = newMonitor();
  monitorRecord(mon, 'Piano', [0x90, 60, 100], 1000);
  monitorRecord(mon, 'Piano', [0x90, 60, 0], 1500);
  monitorRecord(mon, 'Piano', [0xB0, 64, 127], 1600);

  is(mon.total, 3, 'everything is counted');
  is(mon.rows.length, 3, 'and everything loggable is logged');
  const piano = mon.ports.get('Piano');
  is(piano.counts.get('note on'), 1);
  is(piano.counts.get('note off'), 1, 'the velocity-zero note-on counted as a note off');
  is(piano.counts.get('control change'), 1);
}

// A flood family is COUNTED and never logged. 24 clocks to the quarter would
// otherwise push everything else out of the window within seconds — which is
// exactly how the one interesting message gets missed.
{
  const mon = newMonitor();
  monitorRecord(mon, 'Piano', [0x90, 60, 100], 0);
  for (let i = 0; i < 500; i++) monitorRecord(mon, 'Piano', [0xF8], i);
  for (let i = 0; i < 500; i++) monitorRecord(mon, 'Piano', [0xFE], i);

  is(mon.total, 1001, 'the flood is counted in full');
  is(mon.rows.length, 1, 'and none of it is logged');
  is(mon.rows[0].family, 'noteon', 'so the note played before it is still there to read');
  is(mon.ports.get('Piano').counts.get('beat clock'), 500);
  is(sawFamily(mon, 'beat clock'), true, 'which is what the verdict reads');
}

// The window is bounded, oldest first, so a long session cannot grow without
// limit.
{
  const mon = newMonitor();
  for (let i = 0; i < MAX_ROWS + 50; i++) monitorRecord(mon, 'Piano', [0xB0, 1, i & 0x7F], i);
  is(mon.rows.length, MAX_ROWS, 'the log is capped');
  has(mon.rows[mon.rows.length - 1].text, `= ${(MAX_ROWS + 49) & 0x7F}`, 'and it is the OLDEST that goes');
}

// Two ports are counted apart, because which port a message came in on is
// exactly the question when an instrument exposes several.
{
  const mon = newMonitor();
  monitorRecord(mon, 'Piano', [0x90, 60, 100], 0);
  monitorRecord(mon, 'Piano DAW', [0xF8], 1);
  is(mon.ports.size, 2);
  is(mon.ports.get('Piano DAW').counts.get('beat clock'), 1);
  is(mon.ports.get('Piano').counts.get('beat clock'), undefined, 'and not merged');
}

// ---------- the report ----------
//
// The verdict is the part somebody reads to decide what to do next, so each
// line of it has to be a fact about what did or did not arrive.

{
  const mon = newMonitor();
  monitorRecord(mon, 'CASIO USB-MIDI', [0x90, 60, 100], 0);
  monitorRecord(mon, 'CASIO USB-MIDI', [0x90, 60, 0], 500);

  const text = monitorReport(mon, {
    supported: true, enabled: true, sysex: false,
    inputs: [{ name: 'CASIO USB-MIDI', id: 'in-1', manufacturer: 'CASIO' }],
  });

  has(text, 'CASIO USB-MIDI', 'the port is named');
  has(text, 'sysex not requested', 'and the guard that is up is stated');
  // Not "not sent": with sysex not requested the browser never delivers one,
  // so silence there is OUR doing and must not be reported as a fact about
  // the instrument.
  has(text, 'sysex..................... not requested',
    'the verdict must not blame the keyboard for a message we declined to receive');
  has(text, 'beat clock (0xF8)', 'the verdict asks about the clock');
  has(text, 'not sent', 'and answers plainly when it never arrived');
  has(text, 'MIDI Clock / Sync / Transmit Clock',
    'a keyboard sending no clock has to be told where to look, since it is a switch on the instrument');
  ok(!text.includes('Tap along'), 'the report no longer offers audio/tap fallback');
  has(text, 'note on', 'the tally is there');
  ok(!text.includes('clock (0xF8)\n  START'), 'nothing is claimed that did not arrive');
}

{
  const mon = newMonitor();
  monitorRecord(mon, 'Piano', [0xFA], 0);
  for (let i = 0; i < 96; i++) monitorRecord(mon, 'Piano', [0xF8], i * 20);
  const text = monitorReport(mon, { supported: true, enabled: true, sysex: false, inputs: [] });
  has(text, 'YES', 'a keyboard that DOES send clock is told so');
  ok(!text.includes('MIDI Clock / Sync / Transmit Clock'),
    'and is not sent hunting for a setting it has already turned on');
}

// An empty monitor is a legitimate state and must read as one, not as an error
// or as a blank.
{
  const text = monitorReport(newMonitor(), { supported: true, enabled: true, sysex: false, inputs: [] });
  has(text, 'nothing has arrived yet', 'silence is reported as silence');
  has(text, 'Inputs (0)');
}

{
  const mon = newMonitor();
  monitorRecord(mon, 'Piano', [0x90, 60, 100], 0);
  monitorClear(mon);
  is(mon.total, 0);
  is(mon.rows.length, 0);
  is(mon.ports.size, 0);
  is(sawFamily(mon, 'note on'), false, 'clearing clears the verdict too');
}

console.log(`midi-monitor: ${checks} checks passed`);
