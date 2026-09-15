// Build the two Lambda zips.
//
// esbuild bundles each entry point and everything it imports into ONE file, so
// the zip carries no node_modules tree — which is what keeps a cold start at
// tens of milliseconds rather than hundreds. The AWS SDK is marked external
// because the Node 20 Lambda runtime already ships v3: bundling our own copy
// would add ~10 MB to every deploy to get the same code that is already there.
//
//   node tools/package.mjs   ->  dist/api.zip, dist/post-confirmation.zip

import { mkdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as esbuild from 'esbuild';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const dist = path.join(root, 'dist');

const targets = [
  { name: 'api', entry: 'src/api.js' },
  { name: 'post-confirmation', entry: 'src/triggers/post-confirmation.js' },
];

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const target of targets) {
  const outdir = path.join(dist, target.name);

  await esbuild.build({
    entryPoints: [path.join(root, target.entry)],
    outfile: path.join(outdir, `${target.name}.mjs`),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    // pg reaches for optional native/extra packages it does not need in this
    // configuration; without these esbuild fails on modules that are never
    // actually loaded at runtime.
    external: ['@aws-sdk/*', 'pg-native', 'cardinal'],
    minify: true,
    sourcemap: false,
    // Bundling to ESM in a CommonJS-shaped runtime leaves `require` undefined
    // for any dependency that still reaches for it. This shims it back.
    banner: {
      js: [
        "import { createRequire as __createRequire } from 'module';",
        'const require = __createRequire(import.meta.url);',
      ].join('\n'),
    },
  });

  // Lambda decides module format by extension, and .mjs is what makes it treat
  // this as ESM. The handler string in Terraform (`api.handler`) resolves
  // against the file name, so these two must stay in step.
  const zipPath = path.join(dist, `${target.name}.zip`);
  await zipDirectory(outdir, zipPath);
  console.log(`built ${path.relative(root, zipPath)}`);
}

// Node has no zip in its standard library, and this build has one dev
// dependency for a reason — so shell out to whatever the platform provides
// rather than adding an archiver package.
async function zipDirectory(dir, zipPath) {
  if (process.platform === 'win32') {
    await run('powershell', [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${path.join(dir, '*')}' -DestinationPath '${zipPath}' -Force`,
    ]);
  } else {
    await run('zip', ['-qr', zipPath, '.'], { cwd: dir });
  }
}
