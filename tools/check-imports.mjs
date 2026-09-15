// Catches the "used but never imported" mistake — the one that makes a module
// throw ReferenceError only when the offending line finally runs, which in a
// renderer with no bundler and no linter means a feature that silently does
// nothing until someone clicks the right thing.
//
//   node tools/check-imports.mjs
//
// For every module in src/renderer it collects the names it imports, then looks
// for identifiers that are exported by a sibling module but not imported here.
// Exits non-zero if anything is missing.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const DIR = path.join(process.cwd(), 'src', 'renderer');
const files = readdirSync(DIR).filter(f => f.endsWith('.js'));

// name -> module that exports it
const exportedBy = new Map();
const source = new Map();

for (const f of files) {
  const src = readFileSync(path.join(DIR, f), 'utf8');
  source.set(f, src);
  const re = /^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of src.matchAll(re)) exportedBy.set(m[1], f);
}

let problems = 0;

for (const f of files) {
  const src = source.get(f);

  // names this file pulls in, plus anything it declares itself
  const local = new Set();
  for (const m of src.matchAll(/^import\s*\{([^}]*)\}\s*from/gms)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) local.add(name);
    }
  }
  for (const m of src.matchAll(/^import\s+([A-Za-z_$][\w$]*)\s+from/gm)) local.add(m[1]);
  const decl = /(?:^|\s)(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g;
  for (const m of src.matchAll(decl)) local.add(m[1]);
  // Destructuring, which also covers `const { importMidi } = await import(...)`
  // — a dynamic import is still an import.
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(':').pop().trim().replace(/=.*$/, '').trim();
      if (name) local.add(name);
    }
  }

  // strip comments and strings so their contents cannot look like code
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
    .replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');

  const missing = new Set();
  for (const [name, from] of exportedBy) {
    if (from === f || local.has(name)) continue;
    // whole-word, and not preceded by a dot (so obj.NAME does not count)
    const used = new RegExp(`(^|[^.\\w$])${name}\\b`).test(code);
    if (used) missing.add(`${name}  (exported by ${from})`);
  }

  if (missing.size) {
    problems += missing.size;
    console.log(`\n  ${f}`);
    for (const m of missing) console.log(`    MISSING IMPORT: ${m}`);
  }
}

if (problems) {
  console.log(`\n  ${problems} missing import(s)\n`);
  process.exit(1);
}
console.log(`  ${files.length} modules checked, no missing imports`);
