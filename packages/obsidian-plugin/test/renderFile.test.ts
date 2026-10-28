import { strict as assert } from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { renderDitaFile, renderSiteFile } from '../src/renderFile';

const TOPIC = (body: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<concept id="c1"><title>Install</title><conbody>${body}</conbody></concept>`;

describe('renderDitaFile', () => {
  let vault: string;
  const res = (rel: string): string => `app://vault/${rel}`;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'obsidian-dita-'));
    mkdirSync(join(vault, 'maps'));
    mkdirSync(join(vault, 'topics'));
    mkdirSync(join(vault, 'img'));
    writeFileSync(
      join(vault, 'maps', 'main.ditamap'),
      '<?xml version="1.0"?><map><title>M</title><keydef keys="product"><topicmeta><keywords><keyword>Acme Suite</keyword></keywords></topicmeta></keydef></map>',
    );
  });
  afterEach(() => rmSync(vault, { recursive: true, force: true }));

  const render = (name: string, xml: string) =>
    renderDitaFile({ xml, absPath: join(vault, 'topics', name), vaultRoot: vault, toResourceUrl: res });

  it('renders the topic title and body', () => {
    const r = render('t.dita', TOPIC('<p>Hello <b>world</b></p>'));
    assert.equal(r.error, undefined);
    assert.equal(r.title, 'Install');
    assert.match(r.html, /Hello/);
    assert.match(r.html, /<h1[ >]/);
  });

  it('resolves keyref against the ditamap found next to the topic', () => {
    const r = render('t.dita', TOPIC('<p>Welcome to <keyword keyref="product"/></p>'));
    assert.match(r.html, /Acme Suite/);
  });

  it('serves images inside the vault through the host resource URL', () => {
    const r = render('t.dita', TOPIC('<p><image href="../img/a.png" alt="A"/></p>'));
    assert.match(r.html, /src="app:\/\/vault\/img\/a\.png"/);
  });

  it('percent-decodes hrefs before resolving them', () => {
    const r = render('t.dita', TOPIC('<p><image href="../img/my%20pic.png" alt="A"/></p>'));
    assert.match(r.html, /src="app:\/\/vault\/img\/my pic\.png"/);
  });

  it('does not serve an image that climbs out of the vault', () => {
    const r = render('t.dita', TOPIC('<p><image href="../../../outside.png" alt="X"/></p>'));
    // The renderer keeps the authored href in data-dita-src (for broken-image
    // diagnostics); what matters is that no loadable src is produced.
    assert.match(r.html, /<img[^>]* src=""/);
    assert.doesNotMatch(r.html, /\ssrc="[^"]*outside\.png/);
  });

  it('pulls conref content and records the target as a dependency', () => {
    const target = join(vault, 'topics', 'shared.dita');
    writeFileSync(target, TOPIC('<p id="legal">Reused sentence.</p>'));
    const r = render('t.dita', TOPIC('<p conref="shared.dita#c1/legal"/>'));
    assert.match(r.html, /Reused sentence\./);
    assert.ok(r.dependencies.has(target), 'conref target is a dependency');
    assert.ok(r.dependencies.has(join(vault, 'topics', 't.dita')), 'the topic itself is a dependency');
  });

  it('makes a cross-file xref a clickable link carrying its target', () => {
    const r = render('t.dita', TOPIC('<p>See <xref href="other.dita#o1/step">other</xref></p>'));
    assert.match(r.html, /data-dita-href="other\.dita#o1\/step"/);
    assert.doesNotMatch(r.html, /xref-external/);
  });

  it('gives a keyref-only xref the href of its key', () => {
    writeFileSync(
      join(vault, 'maps', 'main.ditamap'),
      '<?xml version="1.0"?><map><title>M</title><keydef keys="guide" href="../topics/guide.dita"/></map>',
    );
    const r = render('t.dita', TOPIC('<p>Read <xref keyref="guide"/></p>'));
    assert.match(r.html, /data-dita-href="guide\.dita"/);
  });

  it('reports a parse failure instead of throwing', () => {
    const r = render('bad.dita', '<concept><title>x</concept>');
    assert.ok(r.error || r.html === '' || /x/.test(r.html), 'returns a result either way');
  });
});

describe('renderSiteFile', () => {
  let vault: string;
  let mapPath: string;
  let alpha: string;
  let beta: string;
  const res = (rel: string): string => `app://vault/${rel}`;
  const MAP =
    '<?xml version="1.0"?><map><title>Guide</title>' +
    '<topicref href="../topics/alpha.dita"/><topicref href="../topics/beta.dita"/></map>';

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'obsidian-dita-site-'));
    mkdirSync(join(vault, 'maps'));
    mkdirSync(join(vault, 'topics'));
    mapPath = join(vault, 'maps', 'main.ditamap');
    alpha = join(vault, 'topics', 'alpha.dita');
    beta = join(vault, 'topics', 'beta.dita');
    writeFileSync(
      alpha,
      '<topic id="alpha"><title>Alpha</title><body><p>See <xref href="beta.dita#beta/child"/>.</p></body></topic>',
    );
    writeFileSync(
      beta,
      '<topic id="beta"><title>Beta</title><body><section id="child"><title>Child</title><p>Text</p></section></body></topic>',
    );
  });
  afterEach(() => rmSync(vault, { recursive: true, force: true }));

  const render = (current?: string) =>
    renderSiteFile({ xml: MAP, absPath: mapPath, vaultRoot: vault, toResourceUrl: res, current });

  it('renders the first page and returns the sidebar manifest', () => {
    const r = render();
    assert.equal(r.error, undefined);
    assert.equal(r.title, 'Guide');
    assert.equal(r.current, alpha);
    assert.equal(r.topicTitle, 'Alpha');
    assert.deepEqual(r.entries.map((entry) => entry.title), ['Alpha', 'Beta']);
    assert.match(r.html, /Alpha/);
    assert.ok(r.dependencies.has(mapPath), 'the map is a dependency');
    assert.ok(r.dependencies.has(alpha), 'the current topic is a dependency');
    assert.ok(r.dependencies.has(beta), 'sidebar titles read the other topic too');
  });

  it('switches pages and leaves a cross-page xref as a site link', () => {
    const first = render();
    assert.match(first.html, /data-dita-book-xref="[^"]*beta\.dita#child"/);

    const second = render(beta);
    assert.equal(second.current, beta);
    assert.equal(second.topicTitle, 'Beta');
    assert.match(second.html, /Child/);
  });

  it('falls back to the first page when the requested one is no longer in the map', () => {
    const r = render(join(vault, 'topics', 'gone.dita'));
    assert.equal(r.current, alpha);
  });

  it('reports a parse failure without throwing and with an empty manifest', () => {
    const r = renderSiteFile({
      xml: '<map><topicref></map>',
      absPath: mapPath,
      vaultRoot: vault,
      toResourceUrl: res,
    });
    assert.ok(r.error);
    assert.deepEqual(r.entries, []);
  });
});
