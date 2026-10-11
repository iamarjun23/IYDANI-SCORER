// Keeps every place that states the app version in step with package.json.
//
//   npm version patch|minor|major   bumps package.json, then npm runs this
//                                   (the "version" script) to finish the job
//   node tools/version.mjs --check  fails if anything has drifted (in verify)
//   node tools/version.mjs --pre    the empty-Unreleased guard, run as
//                                   "preversion" so package.json is not bumped
//                                   for a release that is then refused
//
// A release is: preload.js reports the version (the About box reads it there,
// because a sandboxed preload cannot require package.json), CHANGELOG.md's
// "## Unreleased" section becomes "## <version> — <date>", and STATUS.md's
// header names it. A bump with nothing written under Unreleased is refused:
// a version nobody can say anything about is not a release.
//
//   node tools/version.mjs --commit the git pre-commit hook (.githooks/): bumps
//                                   the patch number itself, so EVERY commit is
//                                   its own version (0.21.1, 0.21.2, …). An
//                                   empty Unreleased is allowed here — the
//                                   entry says so rather than blocking a commit.

import { readFileSync, writeFileSync } from 'node:fs';

const commit = process.argv.includes('--commit');
let version = JSON.parse(readFileSync('package.json', 'utf8')).version;
if (commit) {
  const [a, b, c] = version.split('.').map(Number);
  version = `${a}.${b}.${c + 1}`;
  for (const f of ['package.json', 'package-lock.json']) {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    j.version = version;
    if (j.packages?.['']) j.packages[''].version = version;
    writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
  }
}
const PRELOAD = 'src/preload.js', LOG = 'CHANGELOG.md', STATUS = 'STATUS.md';
const APP_RE = /app: '[^']*'/;
const STATUS_RE = /application version [\w.-]+/;

const read = f => readFileSync(f, 'utf8');
const fail = msg => { console.error(`  version: ${msg}`); process.exit(1); };

if (process.argv.includes('--check')) {
  if (!read(PRELOAD).includes(`app: '${version}'`)) fail(`${PRELOAD} does not say ${version}`);
  if (!read(LOG).includes(`\n## ${version} — `)) fail(`${LOG} has no "## ${version} — <date>" entry`);
  if (!read(STATUS).includes(`application version ${version}`)) fail(`${STATUS} header does not say ${version}`);
  console.log(`  version ${version}: package.json, preload, CHANGELOG and STATUS agree`);
  process.exit(0);
}

const log = read(LOG);
const m = log.match(/\n## Unreleased\n([\s\S]*?)(?=\n## )/);
if (!m) fail(`${LOG} has no "## Unreleased" section`);
const empty = !/^- /m.test(m[1]);
if (empty && !commit) fail(`nothing written under "## Unreleased" in ${LOG} — note the changes first`);
if (process.argv.includes('--pre')) process.exit(0); // guard only; npm bumps next
if (log.includes(`\n## ${version} — `)) fail(`${LOG} already has ${version}`);

const date = new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD;
const note = empty ? '\n- No changelog entry; see the commit message.\n' : '';
writeFileSync(LOG, log.replace('\n## Unreleased\n', `\n## Unreleased\n\n## ${version} — ${date}\n${note}`));
writeFileSync(PRELOAD, read(PRELOAD).replace(APP_RE, `app: '${version}'`));
writeFileSync(STATUS, read(STATUS).replace(STATUS_RE, `application version ${version}`));
console.log(`  released ${version} (${date}): preload, CHANGELOG and STATUS updated`);
