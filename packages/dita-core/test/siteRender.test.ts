import { strict as assert } from 'assert';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { renderSiteXml } from '../src/siteRender';

describe('renderSiteXml', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dita-site-'));
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

  const map = (body: string): string => `<map><title>Guide</title>${body}</map>`;

  it('renders the first topic by default and lists every topic in map order', () => {
    const r = renderSiteXml({
      xml: map('<topicref href="topics/alpha.dita"/><topicref href="topics/beta.dita"/>'),
      docDir: dir,
    });
    assert.equal(r.title, 'Guide');
    assert.equal(r.current, alpha);
    assert.equal(r.topicTitle, 'Alpha');
    assert.deepEqual(r.members, [alpha, beta]);
    assert.deepEqual(
      r.entries.map((entry) => ({ title: entry.title, depth: entry.depth, absPath: entry.absPath })),
      [
        { title: 'Alpha', depth: 0, absPath: alpha },
        { title: 'Beta', depth: 0, absPath: beta },
      ],
    );
    assert.match(r.html, /^<article class="dita-site-page"/);
    assert.match(r.html, new RegExp(`data-dita-book-file="${alpha.replace(/\\/g, '\\\\')}"`));
    assert.equal((r.html.match(/class="dita-site-page"/g) ?? []).length, 1);
    assert.match(r.html, /<h1[^>]*>Alpha</);
  });

  it('renders the requested page and falls back to the first topic for an unknown path', () => {
    const xml = map('<topicref href="topics/alpha.dita"/><topicref href="topics/beta.dita"/>');
    const betaPage = renderSiteXml({ xml, docDir: dir, current: beta });
    assert.equal(betaPage.current, beta);
    assert.equal(betaPage.topicTitle, 'Beta');
    assert.match(betaPage.html, new RegExp(`data-dita-book-file="${beta.replace(/\\/g, '\\\\')}"`));

    const fallback = renderSiteXml({ xml, docDir: dir, current: resolve(dir, 'gone.dita') });
    assert.equal(fallback.current, alpha);
  });

  it('prefers an explicit map navtitle over the topic file title', () => {
    const r = renderSiteXml({
      xml: map('<topicref href="topics/alpha.dita" navtitle="Start here"/>'),
      docDir: dir,
    });
    assert.equal(r.entries[0].title, 'Start here');
    assert.deepEqual(r.members, [alpha]);
  });

  it('keeps topicheads as group headings and compacts their children one level down', () => {
    const r = renderSiteXml({
      xml: map(
        '<topichead navtitle="Part I">' +
          '<topicref href="topics/alpha.dita"/><topicref href="topics/beta.dita"/>' +
          '</topichead>',
      ),
      docDir: dir,
    });
    assert.deepEqual(
      r.entries.map((entry) => ({
        title: entry.title,
        depth: entry.depth,
        isGroup: entry.isGroup ?? false,
        absPath: entry.absPath,
      })),
      [
        { title: 'Part I', depth: 0, isGroup: true, absPath: undefined },
        { title: 'Alpha', depth: 1, isGroup: false, absPath: alpha },
        { title: 'Beta', depth: 1, isGroup: false, absPath: beta },
      ],
    );
    assert.deepEqual(r.members, [alpha, beta]);
  });

  it('skips resource-only entries and duplicate topics, including fragment references', () => {
    const r = renderSiteXml({
      xml: map(
        '<keydef href="topics/alpha.dita" keys="a"/>' +
          '<topicref href="topics/alpha.dita"/>' +
          '<topicref href="topics/alpha.dita#alpha/section"/>' +
          '<topicref href="topics/beta.dita"/>',
      ),
      docDir: dir,
    });
    assert.deepEqual(r.members, [alpha, beta]);
    assert.deepEqual(r.entries.map((entry) => entry.title), ['Alpha', 'Beta']);
  });

  it('turns a cross-file xref to another member into a site link', () => {
    const r = renderSiteXml({
      xml: map('<topicref href="topics/alpha.dita"/><topicref href="topics/beta.dita"/>'),
      docDir: dir,
    });
    assert.match(r.html, /data-dita-book-xref="[^"]*beta\.dita#child"/);
    assert.doesNotMatch(r.html, /xref-external/);
  });

  it('shows a missing current topic and records it as a dependency', () => {
    const missing = resolve(dir, 'topics', 'missing.dita');
    const deps = new Set<string>();
    const r = renderSiteXml({
      xml: map('<topicref href="topics/missing.dita"/><topicref href="topics/beta.dita"/>'),
      docDir: dir,
      collectDependencies: deps,
    });
    assert.equal(r.current, missing);
    assert.match(r.html, /Missing topic: <code>topics\/missing\.dita<\/code>/);
    assert.ok(deps.has(missing));
    assert.ok(deps.has(beta));
  });

  it('splices in a submap, rebasing its hrefs and recording both maps', () => {
    writeFileSync(join(dir, 'maps', 'part.ditamap'), '<map><topicref href="../topics/beta.dita"/></map>');
    const deps = new Set<string>();
    const r = renderSiteXml({
      xml: map('<mapref href="maps/part.ditamap"/>'),
      docDir: dir,
      collectDependencies: deps,
    });
    assert.equal(r.current, beta);
    assert.equal(r.topicTitle, 'Beta');
    assert.ok(deps.has(resolve(dir, 'maps', 'part.ditamap')));
    assert.ok(deps.has(beta));
  });

  it('shows the host-supplied empty message when the map has no topics', () => {
    const r = renderSiteXml({
      xml: map('<keydef href="topics/alpha.dita" keys="a"/>'),
      docDir: dir,
      labels: { noTopics: '这张映射没有主题。' },
    });
    assert.equal(r.current, undefined);
    assert.deepEqual(r.entries, []);
    assert.deepEqual(r.members, []);
    assert.match(r.html, /这张映射没有主题。/);
  });

  it('resolves images against the current topic folder through toResourceUrl', () => {
    const seen: string[] = [];
    renderSiteXml({
      xml: map('<topicref href="topics/alpha.dita"/>'),
      docDir: dir,
      toResourceUrl: (abs) => {
        seen.push(abs);
        return `app://${abs}`;
      },
    });
    assert.deepEqual(seen, [resolve(dir, 'topics', 'img', 'pic.png')]);
  });

  it('shows the current page role label from a bookmap', () => {
    const r = renderSiteXml({
      xml:
        '<bookmap><chapter href="topics/alpha.dita">' +
        '<topicref href="topics/beta.dita"/></chapter></bookmap>',
      docDir: dir,
      roleFormat: ({ ordinal, role }) => (ordinal ? `第 ${ordinal} 章` : role),
    });
    assert.match(r.html, /dita-site-role">第 1 章</);
    assert.deepEqual(r.entries.map((entry) => entry.depth), [0, 1]);
  });

  it('throws on malformed XML so the host can show the message', () => {
    assert.throws(() => renderSiteXml({ xml: '<map><topicref></map>', docDir: dir }));
  });

  it('reuses a cached topic title until the file changes', () => {
    const cached = join(dir, 'topics', 'cached.dita');
    writeFileSync(cached, '<topic id="c"><title>First</title></topic>');
    const titleCache = new Map<string, { stamp: string; title: string | null }>();
    let reads = 0;
    const readFile = (p: string): string => {
      reads++;
      return readFileSync(p, 'utf-8');
    };
    const xml = map('<topicref href="topics/cached.dita"/>');
    const titles = (): string[] => renderSiteXml({ xml, docDir: dir, titleCache, readFile, current: cached }).entries.map((e) => e.title);

    assert.deepEqual(titles(), ['First']);
    const afterFirst = reads;
    assert.deepEqual(titles(), ['First']);
    // The second render reads only the page itself; the sidebar title came from the cache.
    assert.equal(reads - afterFirst, 1);

    writeFileSync(cached, '<topic id="c"><title>Second, longer</title></topic>');
    assert.deepEqual(titles(), ['Second, longer']);
  });
});
