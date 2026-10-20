import * as assert from 'assert';
import { parseDita, preprocessEntities } from '../../src/parser/ditaParser';
import { renderDocument, RenderContext } from '../../src/render/renderer';

const baseCtx: RenderContext = {
  headingLevel: 1,
  asWebviewUri: (p: string) => `vscode-resource:${p}`,
  documentDir: '/test',
};

function parseAndRender(xml: string, ctx: RenderContext = baseCtx) {
  const doc = parseDita(preprocessEntities(xml));
  return { root: doc.root, html: renderDocument(doc.root, ctx) };
}

// The map id is assigned from a module-level counter shared across the
// whole test process, so tests must read whatever id the render actually
// used (off the usemap binding) rather than assuming a fixed value.
function mapIds(html: string): string[] {
  const ids = [...html.matchAll(/usemap="#([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length > 0, `expected at least one usemap binding, got: ${html}`);
  return ids;
}

// ── The OASIS spec's own example (langRef/base/imagemap.html), verbatim ──
// shape/coords/link triples straight from the spec body.
const SPEC_IMAGEMAP = `<topic id="t"><body>
  <imagemap>
    <image href="imagemapworld.jpg">
      <alt>Map of the world showing 5 areas</alt>
    </image>
    <area><shape>rect</shape><coords>2,0,53,59</coords>
      <xref href="d1-s1.dita">Section 1 alternative text</xref>
    </area>
    <area><shape>rect</shape><coords>54,1,117,60</coords>
      <xref href="d1-s2.dita"><!-- Pull title from d1-s2.dita --></xref>
    </area>
    <area><shape>rect</shape><coords>54,62,114,116</coords>
      <xref href="#inline" type="topic">Alternative text for this rectangle</xref>
    </area>
    <area><shape>circle</shape><coords>120,154,29</coords>
      <xref format="html" href="test.html">Link to a test html file</xref>
    </area>
    <area><shape>poly</shape>
      <coords>246,39,200,35,173,52,177,86,215,90,245,84,254,65</coords>
      <xref format="pdf" href="test.pdf">Link to a test PDF file</xref>
    </area>
  </imagemap>
</body></topic>`;

describe('imagemap rendering (utilities domain)', () => {
  it('builds a native image map: img[usemap] + <map> + one <area> per hotspot', () => {
    const { html } = parseAndRender(SPEC_IMAGEMAP);
    assert.ok(
      /<figure\b[^>]*class="[^"]*\bimagemap\b/.test(html),
      `imagemap should render as figure.imagemap, got: ${html}`,
    );
    const [mapId] = mapIds(html);
    assert.ok(
      new RegExp(`<img[^>]*usemap="#${mapId}"[^>]*src="vscode-resource:imagemapworld\\.jpg"`).test(html) ||
        new RegExp(`<img[^>]*src="vscode-resource:imagemapworld\\.jpg"[^>]*usemap="#${mapId}"`).test(html),
      `the image should carry the usemap binding, got: ${html}`,
    );
    assert.ok(
      html.includes(`<map name="${mapId}" id="${mapId}">`),
      `got: ${html}`,
    );
    assert.strictEqual(
      (html.match(/<area\b/g) || []).length,
      5,
      `all five hotspots should render as <area> elements, got: ${html}`,
    );
    assert.ok(html.includes('</map>'), 'the map must be closed');
  });

  it('keeps every region datum off the page as visible text', () => {
    const { html } = parseAndRender(SPEC_IMAGEMAP);
    // Before the fix each <area> rendered as a figgroup div, so the page
    // showed lines like "rect 2,0,53,59 Section 1 alternative text".
    for (const leaked of ['>rect<', '>circle<', '>poly<', '>2,0,53,59<', '>120,154,29<']) {
      assert.ok(!html.includes(leaked), `"${leaked}" must not appear as page text`);
    }
    assert.ok(!html.includes('class="figgroup"'), 'no figgroup wrapper for areas');
    assert.ok(!html.includes('<span class="keyword"'), 'shape must not render as a keyword span');
    assert.ok(!html.includes('<span class="ph"'), 'coords must not render as a ph span');
  });

  it('carries shape, coords, href and alt text on each <area> per the spec example', () => {
    const { html } = parseAndRender(SPEC_IMAGEMAP);
    assert.ok(
      html.includes('<area shape="rect" coords="2,0,53,59" href="d1-s1.dita" alt="Section 1 alternative text" title="Section 1 alternative text">'),
      `got: ${html}`,
    );
    assert.ok(
      html.includes('<area shape="circle" coords="120,154,29" href="test.html" alt="Link to a test html file" title="Link to a test html file">'),
      `got: ${html}`,
    );
    assert.ok(
      html.includes('<area shape="poly" coords="246,39,200,35,173,52,177,86,215,90,245,84,254,65" href="test.pdf" alt="Link to a test PDF file" title="Link to a test PDF file">'),
      `got: ${html}`,
    );
  });

  it('resolves the same-page xref to a real in-page anchor', () => {
    const { html } = parseAndRender(SPEC_IMAGEMAP);
    assert.ok(
      html.includes('<area shape="rect" coords="54,62,114,116" href="#inline" alt="Alternative text for this rectangle"'),
      `a "#..." xref href must become an anchor hotspot, got: ${html}`,
    );
  });

  it('falls back to the raw href for alternative text when the xref is empty', () => {
    // The spec's second area pulls its link text from d1-s2.dita (authored
    // as a comment, which the parser drops) — with no resolvable title the
    // href itself is the only honest hint left.
    const { html } = parseAndRender(SPEC_IMAGEMAP);
    assert.ok(
      html.includes('<area shape="rect" coords="54,1,117,60" href="d1-s2.dita" alt="d1-s2.dita" title="d1-s2.dita">'),
      `got: ${html}`,
    );
  });

  it('uses the resolved title as alt text when one is available', () => {
    const ctx: RenderContext = {
      ...baseCtx,
      resolveTitle: (key: string) => (key === 'd1-s2.dita' ? 'Section 2' : undefined),
    };
    const { html } = parseAndRender(SPEC_IMAGEMAP, ctx);
    assert.ok(
      html.includes('coords="54,1,117,60" href="d1-s2.dita" alt="Section 2" title="Section 2"'),
      `got: ${html}`,
    );
  });

  it('normalizes shape keyword case and tolerates spaced coords', () => {
    const xml = `<topic id="t"><body>
      <imagemap>
        <image href="m.png"/>
        <area><shape>RECT</shape><coords>10, 20, 30, 40</coords>
          <xref href="a.dita">A</xref></area>
        <area><shape>Poly</shape><coords>1,2, 3,4, 5,6</coords>
          <xref href="b.dita">B</xref></area>
      </imagemap>
    </body></topic>`;
    const { html } = parseAndRender(xml);
    assert.ok(html.includes('<area shape="rect" coords="10, 20, 30, 40"'), `got: ${html}`);
    assert.ok(html.includes('<area shape="poly" coords="1,2, 3,4, 5,6"'), `got: ${html}`);
  });

  it('gives each imagemap its own map id and matching usemap binding', () => {
    const xml = `<topic id="t"><body>
      <imagemap>
        <image href="one.png"/>
        <area><shape>rect</shape><coords>0,0,1,1</coords><xref href="a.dita">A</xref></area>
      </imagemap>
      <imagemap>
        <image href="two.png"/>
        <area><shape>circle</shape><coords>5,5,5</coords><xref href="b.dita">B</xref></area>
      </imagemap>
    </body></topic>`;
    const { html } = parseAndRender(xml);
    const ids = mapIds(html);
    assert.strictEqual(ids.length, 2, 'one usemap per imagemap');
    assert.notStrictEqual(ids[0], ids[1], 'map ids must not collide');
    for (const id of ids) {
      assert.ok(html.includes(`<map name="${id}" id="${id}">`), `got: ${html}`);
    }
    assert.ok(html.includes('src="vscode-resource:one.png"'), 'first image intact');
    assert.ok(html.includes('src="vscode-resource:two.png"'), 'second image intact');
  });

  it('reuses the image renderer but suppresses the preview auto-shrink marker', () => {
    const { html } = parseAndRender(SPEC_IMAGEMAP);
    // <alt> child becomes the img's alt attribute (image-renderer reuse).
    assert.ok(/<img[^>]*alt="Map of the world showing 5 areas"/.test(html), `got: ${html}`);
    assert.ok(
      !html.includes('data-dita-default-scale'),
      'a shrunken imagemap image would misalign every hotspot region',
    );
  });

  it('marks book-internal xref targets with data-dita-book-xref for site/book mode jumps', () => {
    const ctx: RenderContext = {
      ...baseCtx,
      isInCurrentBook: (href: string) =>
        href.startsWith('d1-s') ? `/abs/${href}` : undefined,
    };
    const { html } = parseAndRender(SPEC_IMAGEMAP, ctx);
    assert.ok(
      html.includes('<area shape="rect" coords="2,0,53,59" href="#" alt="Section 1 alternative text" title="Section 1 alternative text" data-dita-book-xref="/abs/d1-s1.dita">'),
      `got: ${html}`,
    );
    // Non-book targets keep their raw href.
    assert.ok(html.includes('href="test.pdf"'), 'external targets stay raw hrefs');
  });

  it('renders an imagemap title as figcaption', () => {
    const xml = `<topic id="t"><body>
      <imagemap>
        <title>World map</title>
        <image href="m.png"/>
        <area><shape>rect</shape><coords>0,0,1,1</coords><xref href="a.dita">A</xref></area>
      </imagemap>
    </body></topic>`;
    const { html } = parseAndRender(xml);
    assert.ok(html.includes('<figcaption>World map</figcaption>'), `got: ${html}`);
  });

  it('renders the imagemap id onto the figure', () => {
    const xml = `<topic id="t"><body>
      <imagemap id="world-map">
        <image href="m.png"/>
        <area><shape>rect</shape><coords>0,0,1,1</coords><xref href="a.dita">A</xref></area>
      </imagemap>
    </body></topic>`;
    const { html } = parseAndRender(xml);
    // injectAttributes stamps its data-* attributes before the authored
    // ones, so match id/class anywhere within the opening tag.
    assert.ok(/<figure\b[^>]*\bid="world-map"[^>]*class="[^"]*\bimagemap\b/.test(html), `got: ${html}`);
  });

  it('tolerates an area without an xref (dead hotspot) and an imagemap without areas', () => {
    const xml = `<topic id="t"><body>
      <imagemap>
        <image href="m.png"/>
        <area><shape>rect</shape><coords>0,0,1,1</coords></area>
      </imagemap>
      <imagemap>
        <image href="n.png"/>
      </imagemap>
    </body></topic>`;
    const { html } = parseAndRender(xml);
    assert.ok(html.includes('<area shape="rect" coords="0,0,1,1">'), `got: ${html}`);
    assert.ok(html.includes('src="vscode-resource:n.png"'), 'image-only imagemap still renders');
    assert.strictEqual((html.match(/<area\b/g) || []).length, 1);
  });

  it('renders nothing for area/shape/coords visited outside an imagemap', () => {
    const xml = `<topic id="t"><body>
      <p><shape>rect</shape><coords>1,2,3,4</coords></p>
      <area><shape>rect</shape><coords>1,2,3,4</coords><xref href="a.dita">A</xref></area>
    </body></topic>`;
    const { html } = parseAndRender(xml);
    assert.ok(!html.includes('>rect<') && !html.includes('>1,2,3,4<'), `got: ${html}`);
    assert.ok(!html.includes('<area'), 'standalone area has no image to attach to');
  });
});
