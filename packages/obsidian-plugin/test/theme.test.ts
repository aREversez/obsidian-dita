import { strict as assert } from 'assert';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { THEMES } from './themeFixtures';
import { contrast, declarationsOf, evalColor, RGB } from '../src/theme/colorMath';

// mocha runs from the package directory (npm workspace script).
const adapterCss = readFileSync(resolve(process.cwd(), 'src/theme/obsidian-adapter.css'), 'utf-8');
const coreCss = readFileSync(require.resolve('@dita-viewer/core/styles/dita-content.css'), 'utf-8');
const hostDecls = declarationsOf(adapterCss, ':host');

const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '');

describe('theme contract', () => {
  it('core stylesheet is host-neutral: no --vscode-* references', () => {
    assert.deepEqual(stripComments(coreCss).match(/--vscode-[\w-]+/g) ?? [], []);
  });

  it('adapter never mentions VS Code', () => {
    assert.deepEqual(stripComments(adapterCss).match(/--vscode-[\w-]+/g) ?? [], []);
  });

  it('adapter defines every --dita-* host token the core stylesheet reads', () => {
    const read = new Set(stripComments(coreCss).match(/var\((--dita-[\w-]+)/g)?.map((m) => m.slice(4)) ?? []);
    read.delete('--dita-scale'); // per-image size hint set inline by the renderer, not a host token
    const missing = [...read].filter((t) => !(t in hostDecls));
    assert.deepEqual(missing, [], `adapter does not define: ${missing.join(', ')}`);
  });

  it('every host token the adapter defines is one the core stylesheet understands or documents', () => {
    const known = new Set(
      stripComments(coreCss).match(/--dita-[\w-]+/g) ?? [],
    );
    // Tokens only the adapter reads (user override hooks, layout) are fine;
    // what must not happen is a typo'd twin of a real token.
    const hooks = /^--dita-(max-width|(note|warning|danger|important|tip)-(bg|border))$/;
    const stray = Object.keys(hostDecls).filter((n) => n.startsWith('--dita-') && !known.has(n) && !hooks.test(n));
    assert.deepEqual(stray, []);
  });
});

describe('derived colours hold up across theme archetypes', () => {
  const MIN_TEXT = 4.5; // WCAG AA, normal text

  for (const t of THEMES) {
    describe(t.name, () => {
      const env = { ...t.vars, ...hostDecls };
      const color = (name: string): RGB => evalColor(`var(${name})`, env);
      const bg = color('--dita-bg');
      const fg = color('--dita-fg');
      const pageContrast = contrast(fg, bg);
      // A theme's own text can be below AA (Solarized muted is); we only ask
      // that our tints do not take away more than 15% of what the theme gave.
      const floor = Math.min(MIN_TEXT, pageContrast * 0.85);

      it('fixture is sane: the theme itself has readable body text', () => {
        assert.ok(pageContrast >= 4.5, `${t.name}: fg/bg ${pageContrast.toFixed(2)}`);
      });

      for (const [label, token] of [
        ['note', '--color-note-bg'],
        ['warning', '--color-warning-bg'],
        ['danger', '--color-danger-bg'],
        ['important', '--color-important-bg'],
        ['tip', '--color-tip-bg'],
        ['profiling wash', '--color-profiling-bg'],
        ['profiling label', '--color-profiling-label-bg'],
        ['index chip', '--color-indexterm-chip-bg'],
      ] as const) {
        it(`body text stays legible on the ${label} background`, () => {
          const ratio = contrast(fg, color(token));
          assert.ok(ratio >= floor, `${label}: ${ratio.toFixed(2)} < ${floor.toFixed(2)}`);
        });
      }

      it('profiling label text is legible on its background', () => {
        const ratio = contrast(color('--color-profiling-label-text'), color('--color-profiling-label-bg'));
        assert.ok(ratio >= floor, ratio.toFixed(2));
      });

      it('index chip text is legible on the chip', () => {
        const ratio = contrast(color('--color-indexterm-chip-text'), color('--color-indexterm-chip-bg'));
        assert.ok(ratio >= floor, ratio.toFixed(2));
      });

      it('muted text on the note background keeps its contrast (AA, or 85% of the page value if the theme is below AA)', () => {
        const onPage = contrast(color('--dita-fg-muted'), bg);
        const onNote = contrast(color('--dita-fg-muted'), color('--color-note-bg'));
        const mutedFloor = Math.min(MIN_TEXT, onPage * 0.85);
        assert.ok(onNote >= mutedFloor, `${onNote.toFixed(2)} < ${mutedFloor.toFixed(2)} (page ${onPage.toFixed(2)})`);
      });

      it('callout border is distinguishable from the page', () => {
        for (const token of ['--color-note-border', '--color-warning-border', '--color-danger-border', '--color-tip-border']) {
          const ratio = contrast(color(token), bg);
          assert.ok(ratio >= 1.4, `${token}: ${ratio.toFixed(2)}`);
        }
      });
    });
  }

  it('user override hooks win over the derived defaults', () => {
    const t = THEMES[0];
    const env = { ...t.vars, ...hostDecls, '--dita-note-bg': '#ffeedd' };
    assert.deepEqual(evalColor('var(--color-note-bg)', env), [255, 238, 221]);
  });
});

describe('colour resolver', () => {
  it('mixes in sRGB by percentage and defaults the second share', () => {
    assert.deepEqual(evalColor('color-mix(in srgb, #000000 25%, #ffffff)'), [191.25, 191.25, 191.25]);
    assert.deepEqual(evalColor('color-mix(in srgb, #000, #fff)'), [127.5, 127.5, 127.5]);
  });

  it('follows var() chains and fallbacks, and rejects an undefined variable', () => {
    assert.deepEqual(evalColor('var(--a)', { '--a': 'var(--b)', '--b': '#102030' }), [16, 32, 48]);
    assert.deepEqual(evalColor('var(--missing, #ffffff)'), [255, 255, 255]);
    assert.throws(() => evalColor('var(--missing)'), /Undefined variable/);
  });

  it('computes WCAG contrast', () => {
    assert.equal(Math.round(contrast([0, 0, 0], [255, 255, 255])), 21);
  });
});
