import { strict as assert } from 'assert';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { renderBookXml } from '../src/bookRender';
import { buildKeyMapForDocument } from '../src/keyMapForDocument';

describe('renderBookXml', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dita-book-'));
  mkdirSync(join(dir, 'topics'));
  mkdirSync(join(dir, 'maps'));

  const alpha = join(dir, 'topics', 'alpha.dita');
  const beta = join(dir, 'topics', 'beta.dita');
  writeFileSync(
    alpha,
    '<topic id="alpha"><title>Alpha</title><body>' +
      '<p>See <xref href="beta.dita#beta/child"/> and <image href="img/pic.png"/>.</p>' +
      '</body></topic>',
  );
  writeFileSync(
    beta,
    '<topic id="beta"><title>Beta</title><body><section id="child"><title>Child</title><p>Text</p></section></body></topic>',
  );

  it('renders every topic in map order under one article, with the map title', () => {
    const r = renderBookXml({
      xml: '<map><title>Guide</title><topicref href="topics/alpha.dita"/><topicref href="topics/beta.dita"/></map>',
      docDir: dir,
    });
    assert.equal(r.title, 'Guide');
    assert.match(r.html, /^<article class="dita-book">/);
    assert.match(r.html, /<h1 class="dita-book-title">Guide<\/h1>/);
    assert.ok(r.html.indexOf('Alpha') < r.html.indexOf('Beta'));
    assert.match(r.html, new RegExp(`data-dita-book-file="${alpha.replace(/\\/g, '\\\\')}"`));
    assert.match(r.html, new RegExp(`data-dita-book-file="${beta.replace(/\\/g, '\\\\')}"`));
    assert.deepEqual(r.members, [alpha, beta]);
  });

  it('turns a cross-file xref to another book member into a book link', () => {
    const r = renderBookXml({
      xml: '<map><topicref href="topics/alpha.dita"/><topicref href="topics/beta.dita"/></map>',
      docDir: dir,
    });
    assert.match(r.html, /data-dita-book-xref="[^"]*beta\.dita#child"/);
    assert.doesNotMatch(r.html, /xref-external/);
  });

  it('uses the map nesting for heading levels and shows role labels', () => {
    const r = renderBookXml({
      xml: '<bookmap><chapter href="topics/alpha.dita"><topicref href="topics/beta.dita"/></chapter></bookmap>',
      docDir: dir,
      roleFormat: ({ ordinal, role }) => (ordinal ? `第 ${ordinal} 章` : role),
    });
    assert.match(r.html, /dita-book-role">第 1 章</);
    assert.match(r.html, /<h2[^>]*>Beta</);
  });

  it('splices in a submap, rebasing its hrefs and recording both maps', () => {
    writeFileSync(join(dir, 'maps', 'part.ditamap'), '<map><topicref href="../topics/beta.dita"/></map>');
    const deps = new Set<string>();
    const r = renderBookXml({
      xml: '<map><mapref href="maps/part.ditamap"/></map>',
      docDir: dir,
      collectDependencies: deps,
    });
    assert.match(r.html, /Beta/);
    assert.deepEqual(r.members, [beta]);
    assert.ok(deps.has(resolve(dir, 'maps', 'part.ditamap')));
    assert.ok(deps.has(beta));
  });

  it('skips resource-only entries but still renders topichead dividers', () => {
    const r = renderBookXml({
      xml:
        '<map><keydef href="topics/alpha.dita" keys="a"/>' +
        '<topichead navtitle="Part I"><topicref href="topics/beta.dita"/></topichead></map>',
      docDir: dir,
    });
    assert.match(r.html, /dita-book-division-title">Part I</);
    assert.doesNotMatch(r.html, /Alpha/);
    assert.equal(r.members.includes(alpha), false);
  });

  it('does not render a topic twice when a child topicref points into it', () => {
    const r = renderBookXml({
      xml:
        '<map><topicref href="topics/alpha.dita">' +
        '<topicref href="topics/alpha.dita#alpha/section"/></topicref></map>',
      docDir: dir,
    });
    assert.equal((r.html.match(/class="topic"/g) ?? []).length, 1);
  });

  it('shows a missing topic, keeps going, and records it as a dependency', () => {
    const missing = resolve(dir, 'topics', 'missing.dita');
    const deps = new Set<string>();
    const r = renderBookXml({
      xml: '<map><topicref href="topics/missing.dita"/><topicref href="topics/beta.dita"/></map>',
      docDir: dir,
      collectDependencies: deps,
    });
    assert.match(r.html, /Missing topic: <code>topics\/missing\.dita<\/code>/);
    assert.match(r.html, /Beta/);
    assert.ok(deps.has(missing));
  });

  it('resolves images against each topic folder through toResourceUrl', () => {
    const seen: string[] = [];
    renderBookXml({
      xml: '<map><topicref href="topics/alpha.dita"/></map>',
      docDir: dir,
      toResourceUrl: (abs) => {
        seen.push(abs);
        return `app://${abs}`;
      },
    });
    assert.deepEqual(seen, [resolve(dir, 'topics', 'img', 'pic.png')]);
  });

  it('throws on malformed XML so the host can show the message', () => {
    assert.throws(() => renderBookXml({ xml: '<map><topicref></map>', docDir: dir }));
  });

  it('keeps key targets working: conkeyref and keyref resolve through the real key space', () => {
    const root = mkdtempSync(join(tmpdir(), 'dita-book-keys-'));
    writeFileSync(join(root, 'book.ditamap'), '<map><keydef keys="beta" href="beta.dita"/><topicref href="alpha.dita"/><topicref href="beta.dita"/></map>');
    writeFileSync(join(root, 'alpha.dita'), '<topic id="alpha"><title>Alpha</title><body><p><ph conkeyref="beta/x"/></p></body></topic>');
    writeFileSync(join(root, 'beta.dita'), '<topic id="beta"><title>Beta</title><body><p id="x">Reused words</p></body></topic>');
    const keyMap = buildKeyMapForDocument(join(root, 'book.ditamap'), { root });
    const r = renderBookXml({ xml: '<map><keydef keys="beta" href="beta.dita"/><topicref href="alpha.dita"/><topicref href="beta.dita"/></map>', docDir: root, keyMap });
    const alphaSection = r.html.slice(r.html.indexOf('Alpha'), r.html.indexOf('Beta</h1>'));
    assert.match(alphaSection, /Reused words/);
  });

  it('names a missing topic in the label the host supplies', () => {
    const root = mkdtempSync(join(tmpdir(), 'dita-book-missing-'));
    const xml = '<map><topicref href="gone.dita"/></map>';
    assert.match(renderBookXml({ xml, docDir: root }).html, /Missing topic: <code>gone\.dita/);
    assert.match(renderBookXml({ xml, docDir: root, labels: { missingTopic: '找不到主题' } }).html, /找不到主题: <code>gone\.dita/);
  });
});
