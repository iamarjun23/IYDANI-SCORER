// The binding layer is pure — no DOM, no localStorage required — so the rules
// that matter can be driven directly:
//   · a key writes exactly ONE svara (binding a taken key steals it)
//   · a file's map is normalised before it is trusted
//   · the defaults are the three KEY_ROWS strings, unchanged

import assert from 'node:assert/strict';
import { KEY_ROWS } from '../src/renderer/config.js';
import { state } from '../src/renderer/state.js';
import {
  BIND_OCTS, SLOTS, defaultBinds, normaliseBinds, binds, bindOf, bindKey,
  clearBind, resetBinds, applyBinds, lookupKey, isDefaultBinds,
} from '../src/renderer/keybinds.js';

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };

// ---- defaults match config -------------------------------------------------
resetBinds();
KEY_ROWS.forEach(row => eq(binds()[row.oct], [...row.keys], `default row ${row.oct}`));
ok(isDefaultBinds(), 'a fresh map is the default map');
eq(lookupKey('a'), { idx: 0, oct: 0 }, 'A is madhya Sa by default');
eq(lookupKey('q'), { idx: 0, oct: 1 }, 'Q is taara Sa');
eq(lookupKey('m'), { idx: 6, oct: -1 }, 'M is mandra Ni');
eq(lookupKey('5'), null, 'an unbound key writes nothing');
eq(lookupKey(''), null, 'the empty key writes nothing');

// ---- rebinding -------------------------------------------------------------
resetBinds();
bindKey(0, 0, '5');
eq(lookupKey('5'), { idx: 0, oct: 0 }, 'madhya Sa moved to 5');
eq(lookupKey('a'), null, 'its old key is now free');
ok(!isDefaultBinds(), 'the map is no longer the default');

// Binding a key that another slot holds STEALS it: one key, one svara.
resetBinds();
bindKey(0, 0, 'q');                       // q was taara Sa
eq(lookupKey('q'), { idx: 0, oct: 0 }, 'q now writes madhya Sa');
eq(bindOf(1, 0), '', 'taara Sa was left unassigned by the steal');
let holders = 0;
BIND_OCTS.forEach(o => binds()[o].forEach(k => { if (k === 'q') holders++; }));
eq(holders, 1, 'exactly one slot holds q');

// Rebinding a slot to the key it already has is a no-op, not a self-steal.
resetBinds();
bindKey(0, 3, 'f');
eq(bindOf(0, 3), 'f', 'madhya Ma still on F');

// Case and stray whitespace normalise; multi-character input is refused.
resetBinds();
bindKey(0, 0, ' Q ');
eq(lookupKey('q'), { idx: 0, oct: 0 }, 'input is trimmed and lowercased');
ok(!bindKey(0, 0, 'esc'), 'a multi-character key is refused');
ok(!bindKey(0, 99, 'y'), 'a slot outside the row is refused');

// Unassigning leaves a legal empty slot.
resetBinds();
clearBind(-1, 4);
eq(bindOf(-1, 4), '', 'the slot is empty');
eq(lookupKey('b'), null, 'and its key writes nothing');

// ---- normalising a map that came from a file -------------------------------
eq(normaliseBinds(null), defaultBinds(), 'no map at all falls back to defaults');
eq(normaliseBinds('nonsense'), defaultBinds(), 'a non-object falls back too');

const dupes = normaliseBinds({ '1': 'qqqqqqq'.split(''), '0': 'asdfghj'.split(''), '-1': 'zxcvbnm'.split('') });
eq(dupes[1], ['q', '', '', '', '', '', ''], 'a duplicated key survives once');
eq(dupes[0], 'asdfghj'.split(''), 'the untouched rows come through whole');

const short = normaliseBinds({ '1': ['q'], '0': [], '-1': null });
eq(short[1].length, SLOTS, 'a short row is padded to 7');
eq(short[1][0], 'q', 'what it did carry is kept');
eq(short[0], ['', '', '', '', '', '', ''], 'a missing row is all-unassigned');

const junk = normaliseBinds({ '1': [1, {}, 'AB', ' e ', null, 't', 'y'] });
eq(junk[1], ['', '', '', 'e', '', 't', 'y'], 'junk entries drop, good ones normalise');

// applyBinds installs the normalised map, not the raw one.
applyBinds({ '1': ['q', 'q'], '0': [], '-1': [] });
eq(state.keyBinds[1][1], '', 'applyBinds stores the cleaned map');
resetBinds();

console.log(`keybinds: ${checks} checks passed`);
