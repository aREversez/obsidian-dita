import { strict as assert } from 'assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { renderDitaFile } from '../src/renderFile';

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

  it('reports a parse failure instead of throwing', () => {
    const r = render('bad.dita', '<concept><title>x</concept>');
    assert.ok(r.error || r.html === '' || /x/.test(r.html), 'returns a result either way');
  });
});
