// The language table is keyed by the English string, so the failure it can
// have is silent: a heading tagged data-i18n with no row simply stays English
// in every language, and a row one column short shows English in Tamil only.
// Neither throws. This reads the tags out of the markup and checks them.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MENUS, LANGS } from '../src/renderer/config.js';
import { state } from '../src/renderer/state.js';
import { STR, l10n } from '../src/renderer/i18n.js';

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };

// ---- every row is complete -------------------------------------------------
const langs = Object.keys(LANGS).filter(k => k !== 'en');
for (const [key, row] of Object.entries(STR)) {
  eq(row.length, langs.length, `"${key}" has one string per language`);
  ok(row.every(s => typeof s === 'string' && s.trim()), `"${key}" has no empty translation`);
}

// ---- every tagged string has a row -----------------------------------------
const read = f => readFileSync(new URL(`../src/renderer/${f}`, import.meta.url), 'utf8');
const tagged = new Set();
for (const m of read('index.html').matchAll(/data-i18n="([^"$]+)"/g)) tagged.add(m[1]);
// palettes.js tags its glyph names from these literal lists.
for (const m of read('palettes.js').matchAll(/\['[\w]+', (?:-?\d+, )?'([A-Z][A-Za-z ]+)'\]/g)) tagged.add(m[1]);
tagged.add('Break');
ok(tagged.size > 30, `found the tagged strings (${tagged.size})`);
for (const key of tagged) ok(STR[key], `"${key}" is tagged in the markup and has a row`);

// ---- every actionable menu item has a row ----------------------------------
for (const [name, items] of Object.entries(MENUS)) {
  ok(STR[name], `menu "${name}" has a row`);
  for (const [label, act] of items) {
    if (label === '—' || act === 'noop' || act === 'about') continue;
    ok(STR[label], `menu item "${label}" has a row`);
  }
}

// ---- l10n() ------------------------------------------------------------------
state.lang = 'en';
eq(l10n('Notes'), 'Notes', 'English is the key itself');
state.lang = 'kn';
eq(l10n('Notes'), 'ಸ್ವರಗಳು', 'Kannada reads its column');
eq(l10n('No such string'), 'No such string', 'an untranslated string falls back to English');
state.lang = 'ta';
eq(l10n('Notes'), 'ஸ்வரங்கள்', 'the last column is reachable');
state.lang = 'xx';
eq(l10n('Notes'), 'Notes', 'an unknown language falls back to English');
state.lang = 'en';

console.log(`i18n: ${checks} checks passed`);
