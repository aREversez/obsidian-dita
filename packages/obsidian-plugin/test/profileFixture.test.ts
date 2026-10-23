// The whole path on the repository's own fixture set: the real renderer's
// output, the real strict.ditaval, and the same decision the view makes for
// every data-profile-keys element. Catches a break between the three that the
// unit tests on each cannot.

import { strict as assert } from 'assert';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { isExcluded, parseDitaval, profileGroups, profileValuesOfKeys } from '@dita-viewer/core';
import { renderDitaFile } from '../src/renderFile';

// dist-test/test/<this file>.js -> the repository root is four levels up.
const ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURES = join(ROOT, 'test-dita-file');

interface Profiled {
  keys: string;
  /** The element's visible text, tags stripped, up to a short length. */
  text: string;
}

/** Every element carrying data-profile-keys, with the text that follows its opening tag. */
function profiledElements(html: string): Profiled[] {
  const out: Profiled[] = [];
  const marker = 'data-profile-keys="';
  for (let at = html.indexOf(marker); at >= 0; at = html.indexOf(marker, at + 1)) {
    const start = at + marker.length;
    const keys = html.slice(start, html.indexOf('"', start)).replace(/&amp;/g, '&');
    const text = html
      .slice(html.indexOf('>', start) + 1, html.indexOf('>', start) + 600)
      .replace(/<[^>]*>/g, '')
      .trim();
    out.push({ keys, text });
  }
  return out;
}

describe('strict.ditaval on the fixture topics', () => {
  const strict = parseDitaval(readFileSync(join(FIXTURES, 'common', 'strict.ditaval'), 'utf-8'));
  const filter = { ditaval: strict };

  const render = (name: string): Profiled[] => {
    const absPath = join(FIXTURES, 'topics', name);
    const result = renderDitaFile({
      xml: readFileSync(absPath, 'utf-8'),
      absPath,
      vaultRoot: FIXTURES,
      toResourceUrl: (rel) => `app://vault/${rel}`,
    });
    assert.equal(result.error, undefined);
    return profiledElements(result.html);
  };

  /** Does the filter leave out the profiled element whose own text starts with `marker`? */
  const verdict = (elements: Profiled[], marker: string): boolean => {
    const el = elements.find((e) => e.text.startsWith(marker));
    assert.ok(el, `an element starting with "${marker}" is profiled`);
    return isExcluded(profileValuesOfKeys(el.keys), filter);
  };

  it('the fixture files and the file under test are there', () => {
    assert.ok(existsSync(join(FIXTURES, 'common', 'strict.ditaval')));
    assert.ok(strict.rules.length >= 5);
    assert.equal(strict.error, undefined);
  });

  it('leaves out internal, windows, legacy and beta paragraphs and keeps the rest', () => {
    const els = render('release-notes.dita');
    assert.equal(verdict(els, '管理员内容'), false, 'audience=admin stays');
    assert.equal(verdict(els, '开发者内容'), false, 'audience=developer has no rule, so it stays');
    assert.equal(verdict(els, '内部内容'), true, 'audience=internal goes');
    assert.equal(verdict(els, 'Linux 内容'), false, 'platform=linux stays');
    assert.equal(verdict(els, 'Windows 内容'), true, 'platform=windows goes');
    assert.equal(verdict(els, '旧产品内容'), true, 'product=legacy goes');
    assert.equal(verdict(els, 'Beta 内容'), true, 'otherprops=beta goes');
  });

  it('judges table rows by the same rules', () => {
    const els = render('release-notes.dita');
    // A row's text is its cells run together, so the first cell identifies it.
    assert.equal(verdict(els, '内部构建'), true, 'audience=internal props=internal-only row goes');
    assert.equal(verdict(els, '路径'), true, 'platform=windows row goes');
    assert.equal(verdict(els, '兼容模式'), true, 'product=legacy otherprops=beta row goes');
  });

  it('keeps a list item that has audience=admin and removes the internal one', () => {
    const els = render('preface.dita');
    assert.equal(verdict(els, '平台管理员'), false);
    assert.equal(verdict(els, '开发者：'), false);
    assert.equal(verdict(els, '内部审阅者'), true);
  });

  it('offers every attribute and value the page carries, for the panel', () => {
    const groups = profileGroups(render('release-notes.dita').map((e) => profileValuesOfKeys(e.keys)));
    const byAtt = Object.fromEntries(groups.map((g) => [g.att, g.values]));
    assert.deepEqual(byAtt.audience, ['admin', 'developer', 'internal']);
    assert.deepEqual(byAtt.platform, ['linux', 'windows']);
    assert.deepEqual(byAtt.product, ['legacy']);
    assert.deepEqual(byAtt.otherprops, ['beta']);
    assert.deepEqual(byAtt.props, ['internal-only']);
  });

  it('the stylesheet hides what the view marks as filtered out', () => {
    const css = readFileSync(join(ROOT, 'packages', 'dita-core', 'styles', 'dita-content.css'), 'utf-8');
    assert.match(css, /\.profile-filtered-out\s*\{\s*display:\s*none\s*!important/);
  });
});
