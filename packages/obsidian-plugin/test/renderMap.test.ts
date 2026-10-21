import { strict as assert } from 'assert';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { renderDitamapFile } from '../src/renderFile';
import { outlineLabel, roleFormatFor } from '../src/roleLabels';

describe('renderDitamapFile', () => {
  const root = mkdtempSync(join(tmpdir(), 'dita-vault-'));
  const abs = join(root, 'book.ditamap');
  const xml = '<bookmap><booktitle><mainbooktitle>Manual</mainbooktitle></booktitle><chapter href="a.dita" navtitle="Intro"/><appendix href="z.dita" navtitle="Data"/></bookmap>';

  it('renders the outline and tracks the map itself as a dependency', () => {
    const r = renderDitamapFile({ xml, absPath: abs, vaultRoot: root });
    assert.equal(r.error, undefined);
    assert.match(r.html, /Intro/);
    assert.match(r.html, /data-href="a\.dita"/);
    assert.ok(r.dependencies.has(abs));
  });

  it('labels divisions in Chinese when the UI is Chinese, English otherwise', () => {
    assert.match(renderDitamapFile({ xml, absPath: abs, vaultRoot: root, uiLanguage: 'zh-cn' }).html, /第 1 章/);
    assert.match(renderDitamapFile({ xml, absPath: abs, vaultRoot: root, uiLanguage: 'zh-cn' }).html, /附录 A/);
    assert.match(renderDitamapFile({ xml, absPath: abs, vaultRoot: root, uiLanguage: 'en' }).html, /Chapter 1/);
    assert.equal(roleFormatFor('en'), undefined);
    assert.equal(outlineLabel('zh-tw'), '文档大纲');
  });

  it('reports malformed XML as an error, keeping dependencies', () => {
    const r = renderDitamapFile({ xml: '<map><topicref></map>', absPath: abs, vaultRoot: root });
    assert.ok(r.error);
    assert.equal(r.html, '');
  });

  it('picks up keys defined in a parent map for titles', () => {
    writeFileSync(join(root, 'keys.ditamap'), '<map><keydef keys="prod"><topicmeta><keywords><keyword>Acme</keyword></keywords></topicmeta></keydef></map>');
    const r = renderDitamapFile({ xml: '<map><mapref href="keys.ditamap"/><topicref href="a.dita"><topicmeta><navtitle><ph keyref="prod"/> guide</navtitle></topicmeta></topicref></map>', absPath: abs, vaultRoot: root });
    assert.match(r.html, /Acme guide/);
  });
});
