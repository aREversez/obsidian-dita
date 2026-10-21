import { strict as assert } from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { renderMapXml } from '../src/mapRender';

describe('renderMapXml', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dita-map-'));
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'child.ditamap'), '<map><topicref href="deep.dita" navtitle="Deep"/></map>');

  it('renders navtitles as a tree with navigable links', () => {
    const html = renderMapXml({
      xml: '<map><title>Guide</title><topicref href="a.dita" navtitle="Alpha"><topicref href="b.dita" navtitle="Beta"/></topicref></map>',
      docDir: dir,
    });
    assert.match(html, /role="tree"/);
    assert.match(html, /map-tree-label[^>]*>Alpha</);
    assert.match(html, /data-href="b\.dita"/);
    assert.ok(html.indexOf('Alpha') < html.indexOf('Beta'));
  });

  it('falls back to the file name when nothing names the entry', () => {
    assert.match(renderMapXml({ xml: '<map><topicref href="topics/intro.dita"/></map>', docDir: dir }), />intro</);
  });

  it('splices in a submap, rebasing its hrefs, and reports the file as a dependency', () => {
    const deps = new Set<string>();
    const html = renderMapXml({ xml: '<map><mapref href="sub/child.ditamap"/></map>', docDir: dir, collectDependencies: deps });
    assert.match(html, /data-href="sub\/deep\.dita"/);
    assert.ok(deps.has(resolve(dir, 'sub/child.ditamap')));
  });

  it('resolves key references in titles', () => {
    const html = renderMapXml({
      xml: '<map><topicref href="a.dita"><topicmeta><navtitle>The <ph keyref="p"/> guide</navtitle></topicmeta></topicref></map>',
      docDir: dir,
      keyMap: new Map([['p', 'Acme']]),
    });
    assert.match(html, /The Acme guide/);
  });

  it('numbers bookmap divisions through the injected formatter', () => {
    const html = renderMapXml({
      xml: '<bookmap><chapter href="a.dita" navtitle="A"/><chapter href="b.dita" navtitle="B"/></bookmap>',
      docDir: dir,
      roleFormat: ({ ordinal, role }) => (ordinal ? `第 ${ordinal} 章` : role),
    });
    assert.match(html, /第 1 章/);
    assert.match(html, /第 2 章/);
  });

  it('throws on malformed XML so the host can show the message', () => {
    assert.throws(() => renderMapXml({ xml: '<map><topicref></map>', docDir: dir }));
  });
});
