import esbuild from 'esbuild';
import { builtinModules } from 'node:module';
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
const out = resolve(here, 'dist');
mkdirSync(out, { recursive: true });

const options = {
  entryPoints: [resolve(here, 'src/main.ts')],
  bundle: true,
  format: 'cjs',
  target: 'es2022',
  platform: 'node', // desktop-only: fs/path come from Electron's Node
  outfile: resolve(out, 'main.js'),
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
  // The workspace package is bundled from source, so no separate build step.
  alias: { '@dita-viewer/core': resolve(here, '../dita-core/src/index.ts') },
  loader: { '.css': 'text' },
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  logLevel: 'info',
};

// Obsidian loads main.js, manifest.json and styles.css from the plugin folder.
const copyStatic = () => {
  for (const f of ['manifest.json', 'styles.css']) copyFileSync(resolve(here, f), resolve(out, f));
};

if (watch) {
  const ctx = await esbuild.context(options);
  copyStatic();
  await ctx.watch();
} else {
  await esbuild.build(options);
  copyStatic();
}
