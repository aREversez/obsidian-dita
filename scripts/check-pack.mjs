// Before publishing @dita-viewer/core: pack it, check what is in the tarball,
// install the tarball into an empty project and use it the way a consumer
// would (CommonJS require, and TypeScript type resolution under node16 rules).
//
//   npm run check:pack
//
// Not part of `verify`: it installs from the npm registry (the package depends
// on sax), so it needs the network. Run it before every publish.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = join(root, 'packages', 'dita-core');
const work = mkdtempSync(join(tmpdir(), 'dita-core-pack-'));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures.push(message);
};

try {
  // npm pack runs prepublishOnly's sibling lifecycle for `pack`, not publish; build explicitly.
  run('npm', ['run', 'build', '-w', '@dita-viewer/core'], root);
  const info = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', work], pkgDir))[0];
  const files = info.files.map((f) => f.path);
  const has = (p) => files.includes(p);
  check(has('LICENSE'), 'tarball has LICENSE');
  check(has('README.md') && has('package.json'), 'tarball has README.md and package.json');
  check(has('dist/index.js') && has('dist/index.d.ts'), 'tarball has dist/index.js and dist/index.d.ts');
  check(has('styles/dita-content.css') && has('styles/TOKENS.md'), 'tarball has the stylesheet and the token contract');
  check(!files.some((f) => f.endsWith('.map')), 'tarball has no source maps');
  check(!files.some((f) => f.startsWith('src/') || f.startsWith('test/') || f.startsWith('dist-test/')), 'tarball has no src, test or dist-test');

  const consumer = join(work, 'consumer');
  run('mkdir', ['-p', consumer], work);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', version: '1.0.0', private: true }));
  run('npm', ['install', join(work, info.filename), 'typescript@5', '@types/node@20', '--no-audit', '--no-fund'], consumer);

  writeFileSync(
    join(consumer, 'use.cjs'),
    `const core = require('@dita-viewer/core');
const doc = core.parseDita('<topic id="t"><title>T</title></topic>');
const r = core.renderTopicXml({ xml: '<topic id="t"><title>Hello</title><body><p>x</p></body></topic>', docDir: process.cwd(), keyMap: new Map(), asWebviewUri: (p) => p, headingLevel: 1 });
if (!doc.root || !/Hello/.test(r.html)) throw new Error('render failed');
console.log(Object.keys(core).length);`,
  );
  let exportCount = 0;
  try {
    exportCount = Number(run('node', ['use.cjs'], consumer).trim());
    check(exportCount > 30, `a CommonJS consumer can require it and render (${exportCount} exports)`);
  } catch (e) {
    check(false, `a CommonJS consumer can require it and render: ${e.stderr || e.message}`);
  }
  check(readdirSync(join(consumer, 'node_modules', '@dita-viewer', 'core', 'styles')).includes('dita-content.css'), 'the stylesheet is installed');

  writeFileSync(
    join(consumer, 'use.ts'),
    `import { parseDita, renderTopicXml, type DitaDocument, type DitaNode } from '@dita-viewer/core';
const doc: DitaDocument = parseDita('<topic id="t"/>');
const node: DitaNode = doc.root;
const html: string = renderTopicXml({ xml: '', docDir: '.', keyMap: new Map(), asWebviewUri: (p) => p, headingLevel: 1 }).html;
export { node, html };
`,
  );
  writeFileSync(
    join(consumer, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { module: 'node16', moduleResolution: 'node16', target: 'es2022', strict: true, noEmit: true, skipLibCheck: false, types: ['node'] }, files: ['use.ts'] }),
  );
  try {
    run(join(consumer, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], consumer);
    check(true, 'a TypeScript consumer resolves the types (node16 resolution)');
  } catch (e) {
    check(false, `a TypeScript consumer resolves the types: ${e.stdout || e.message}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed; do not publish.`);
  process.exit(1);
}
console.log('\npack check passed.');
