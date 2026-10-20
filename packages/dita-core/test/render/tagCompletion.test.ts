import * as assert from 'assert';
import { parseDita, parseDitamap, preprocessEntities } from '../../src/parser/ditaParser';
import { renderDocument, RenderContext } from '../../src/render/renderer';
import { renderMapDocument } from '../../src/render/mapTypeMap';

const topicCtx: RenderContext = {
  headingLevel: 1,
  asWebviewUri: (p: string) => `vscode-resource:${p}`,
  documentDir: '/test',
};

/** Parse + render a topic fragment, returning (root, html). */
function parseTopic(xml: string): { root: ReturnType<typeof parseDita>['root']; html: string } {
  const doc = parseDita(preprocessEntities(xml));
  return { root: doc.root, html: renderDocument(doc.root, topicCtx) };
}

function parseMap(xml: string): string {
  const doc = parseDitamap(preprocessEntities(xml));
  return renderMapDocument(doc.root, { docDir: '/test' });
}

// ── Helpers to walk the DOM for a named descendant element ──
function findEl(node: ReturnType<typeof parseDita>['root'], tagName: string) {
  const stack = [node];
  while (stack.length) {
    const n = stack.shift()!;
    if (n.type === 'element' && n.tagName === tagName) return n;
    for (const c of n.children || []) if (c.type === 'element') stack.push(c);
  }
  return undefined;
}

describe('tag completion (DTD-derived baseType mappings)', () => {
  // ── Highlight domain: element-specific baseType + distinct renderer ──
  it('line-through resolves to topic/line-through and renders a semantic <s>', () => {
    const xml = `<topic id="t"><body><p><line-through>struck</line-through></p></body></topic>`;
    const { root, html } = parseTopic(xml);
    const lt = findEl(root, 'line-through');
    assert.ok(lt, 'line-through element should be parsed');
    assert.strictEqual(lt!.baseType, 'topic/line-through');
    // Semantic <s> tag (zero CSS), matching b→<strong>/i→<em> convention;
    // renderer injects title/data-* attrs after the tag name.
    assert.ok(/<s\b[^>]*>struck<\/s>/.test(html), `expected <s>struck</s>, got: ${html}`);
    assert.ok(!html.includes('text-decoration'), 'no inline style for line-through');
  });

  it('overline resolves to topic/overline and renders a class-only span', () => {
    const xml = `<topic id="t"><body><p><overline>over</overline></p></body></topic>`;
    const { root, html } = parseTopic(xml);
    const ov = findEl(root, 'overline');
    assert.strictEqual(ov!.baseType, 'topic/overline');
    // Class-only span (no inline style) so themes can override the decoration
    // via the .overline rule in styles.css. It is a hi-d specialisation of ph, so
    // it also carries the html5 `ph` token (styles.css excludes it from the
    // span.ph dimming with :not(.overline), so the ph token stays cosmetic here).
    assert.ok(/<span\b[^>]*class="ph overline"[^>]*>over<\/span>/.test(html), `got: ${html}`);
    assert.ok(!html.includes('text-decoration'), 'overline must not use an inline style');
  });

  // ── Equation domain: first-pair baseType (existing renderers) ──
  it('equation-block resolves to topic/div and equation-figure to topic/fig', () => {
    const xml = `<topic id="t"><body>
      <equation-block><p>e=mc^2</p></equation-block>
      <equation-figure><title>Fig</title><image href="x.png"/></equation-figure>
    </body></topic>`;
    const { root, html } = parseTopic(xml);
    assert.strictEqual(findEl(root, 'equation-block')!.baseType, 'topic/div');
    assert.strictEqual(findEl(root, 'equation-figure')!.baseType, 'topic/fig');
    assert.ok(html.includes('class="body-div div"'), 'equation-block should render via topic/div');
    assert.ok(html.includes('<figure'), 'equation-figure should render via topic/fig');
  });

  // ── Troubleshooting module ──
  it('troubleshooting structure resolves to topic ancestors (topic/body/section)', () => {
    const xml = `<troubleshooting id="ts">
      <title>Problem</title>
      <troublebody>
        <condition><p>Symptom</p></condition>
        <cause><p>Root cause</p></cause>
        <remedy><p>Fix it</p></remedy>
      </troublebody>
    </troubleshooting>`;
    const { root, html } = parseTopic(xml);
    assert.strictEqual(root.baseType, 'topic/topic');
    assert.strictEqual(findEl(root, 'troublebody')!.baseType, 'topic/body');
    assert.strictEqual(findEl(root, 'condition')!.baseType, 'topic/section');
    assert.strictEqual(findEl(root, 'cause')!.baseType, 'topic/section');
    assert.strictEqual(findEl(root, 'remedy')!.baseType, 'topic/section');
    assert.ok(/<main\b[^>]*class="body"/.test(html), 'troublebody should render as body');
    assert.ok(html.includes('Root cause'));
  });

  // ── Glossentry module ──
  it('glossentry sub-elements resolve to topic ancestors (body/title/note)', () => {
    const xml = `<glossentry id="g">
      <glossterm>API</glossterm>
      <glossBody>
        <glossPartOfSpeech>noun</glossPartOfSpeech>
        <glossAlt>
          <glossAbbreviation>API</glossAbbreviation>
          <glossScopeNote>See also SDK</glossScopeNote>
        </glossAlt>
      </glossBody>
    </glossentry>`;
    const { root, html } = parseTopic(xml);
    assert.strictEqual(findEl(root, 'glossBody')!.baseType, 'topic/body');
    assert.strictEqual(findEl(root, 'glossAbbreviation')!.baseType, 'topic/title');
    assert.strictEqual(findEl(root, 'glossAlt')!.baseType, 'topic/section');
    assert.strictEqual(findEl(root, 'glossScopeNote')!.baseType, 'topic/note');
    assert.ok(/<main\b[^>]*class="body"/.test(html), 'glossBody should render as body');
    assert.ok(html.includes('class="note'), 'glossScopeNote should render as a note');
  });

  it('glossentry cross-type elements (glossAlternateFor, glossSymbol) resolve to xref/image', () => {
    const xml = `<glossentry id="g2">
      <glossterm>Term</glossterm>
      <glossBody>
        <glossAlt>
          <glossAlternateFor href="other.dita">alt</glossAlternateFor>
          <glossSymbol href="sym.png">symbol</glossSymbol>
        </glossAlt>
      </glossBody>
    </glossentry>`;
    const { root } = parseTopic(xml);
    assert.strictEqual(findEl(root, 'glossAlternateFor')!.baseType, 'topic/xref');
    assert.strictEqual(findEl(root, 'glossSymbol')!.baseType, 'topic/image');
  });

  // ── Task requirements domain (taskreq-d) ──
  it('taskreq domain elements resolve to their topic list/section ancestors', () => {
    const xml = `<task id="tk">
      <title>T</title>
      <taskbody>
        <prelreqs><p>Before</p></prelreqs>
        <closereqs><p>After</p></closereqs>
        <reqconds>
          <reqcond><p>Cond A</p></reqcond>
          <noconds><p>None</p></noconds>
        </reqconds>
        <safety>
          <safecond><p>Wear gloves</p></safecond>
        </safety>
      </taskbody>
    </task>`;
    const { root, html } = parseTopic(xml);
    assert.strictEqual(findEl(root, 'prelreqs')!.baseType, 'topic/section');
    assert.strictEqual(findEl(root, 'closereqs')!.baseType, 'topic/section');
    assert.strictEqual(findEl(root, 'reqconds')!.baseType, 'topic/ul');
    assert.strictEqual(findEl(root, 'reqcond')!.baseType, 'topic/li');
    assert.strictEqual(findEl(root, 'noconds')!.baseType, 'topic/li');
    assert.strictEqual(findEl(root, 'safety')!.baseType, 'topic/ol');
    assert.strictEqual(findEl(root, 'safecond')!.baseType, 'topic/li');
    // safety (ol) > safecond (li); renderer injects title/data-* attrs into tags
    assert.ok(/<ol\b[^>]*>[\s\S]*?<li\b[^>]*>[\s\S]*?Wear gloves/.test(html), `got: ${html}`);
  });

  // ── Map-side: ditavalref / mapGroup / glossref / bookmap wrappers ──
  it('ditavalref and topicset resolve to map/topicref and render as nav items', () => {
    const xml = `<map>
      <ditavalref href="filter.ditaval"/>
      <topicset href="topics/set.dita"/>
      <topicsetref href="topics/setref.dita"/>
    </map>`;
    const html = parseMap(xml);
    assert.ok(html.includes('data-href="filter.ditaval"'), 'ditavalref should be a nav item');
    assert.ok(html.includes('data-href="topics/set.dita"'), 'topicset should be a nav item');
    assert.ok(html.includes('data-href="topics/setref.dita"'), 'topicsetref should be a nav item');
    assert.ok(
      (html.match(/map-tree-item--nav/g) || []).length >= 3,
      'all three should render as navigable map-tree items',
    );
  });

  it('glossref resolves to map/topicref', () => {
    const xml = `<map><glossref href="glossary.dita"/></map>`;
    const doc = parseDitamap(preprocessEntities(xml));
    const gr = doc.root.children.find((c) => c.type === 'element' && c.tagName === 'glossref')!;
    assert.strictEqual(gr.baseType, 'map/topicref');
    const html = renderMapDocument(doc.root, { docDir: '/test' });
    assert.ok(html.includes('data-href="glossary.dita"'));
  });

  it('bookmap appendices and booklist resolve to map/topicref', () => {
    const xml = `<bookmap>
      <appendices href="app.dita"/>
      <booklist href="figlist.dita"/>
    </bookmap>`;
    const doc = parseDitamap(preprocessEntities(xml));
    const ap = doc.root.children.find((c) => c.type === 'element' && c.tagName === 'appendices')!;
    const bl = doc.root.children.find((c) => c.type === 'element' && c.tagName === 'booklist')!;
    assert.strictEqual(ap.baseType, 'map/topicref');
    assert.strictEqual(bl.baseType, 'map/topicref');
    const html = renderMapDocument(doc.root, { docDir: '/test' });
    assert.ok(html.includes('data-href="app.dita"'));
    assert.ok(html.includes('data-href="figlist.dita"'));
  });

  // ── Second deferred batch: remaining 75 topic-side entries ──────────────

  // ── Utilities domain: image maps (dedicated baseTypes + renderers) ──
  it('imagemap/area/shape/coords resolve to dedicated baseTypes and render a real image map', () => {
    const xml = `<topic id="t"><body>
      <imagemap>
        <image href="diagram.png"/>
        <area>
          <shape>rect</shape>
          <coords>0,0,10,10</coords>
          <xref href="detail.dita">Detail</xref>
        </area>
      </imagemap>
      <p><term sort-as="apple">Apple</term></p>
    </body></topic>`;
    const { root, html } = parseTopic(xml);
    // imagemap/area deliberately deviate from their topic ancestors
    // (topic/fig / topic/figgroup): the generic fig/figgroup renderers
    // dumped the area's region data onto the page and produced nothing
    // clickable. Dedicated baseTypes carry the dedicated <img usemap> +
    // <map><area></map> renderers (see baseTypeMap.ts).
    assert.strictEqual(findEl(root, 'imagemap')!.baseType, 'topic/imagemap');
    assert.strictEqual(findEl(root, 'area')!.baseType, 'topic/area');
    assert.strictEqual(findEl(root, 'shape')!.baseType, 'topic/shape');
    assert.strictEqual(findEl(root, 'coords')!.baseType, 'topic/coords');
    // The image map structure is real: usemap binding + map + area attrs.
    // The map id comes from a shared counter, so read it back off the
    // usemap attribute instead of assuming a fixed value.
    const mapId = /usemap="#([^"]+)"/.exec(html)![1];
    assert.ok(html.includes(`<map name="${mapId}" id="${mapId}">`), `got: ${html}`);
    assert.ok(
      /<area shape="rect" coords="0,0,10,10" href="detail\.dita" alt="Detail" title="Detail">/.test(html),
      `got: ${html}`,
    );
    // And none of the region metadata leaks as visible page text.
    assert.ok(!html.includes('class="figgroup"'), 'area must not render as a figgroup wrapper');
    assert.ok(!html.includes('>rect<'), 'shape text must not appear as page text');
    assert.ok(!html.includes('>0,0,10,10<'), 'coords text must not appear as page text');
  });

  // ── Programming domain: grouping alternatives (visible body content) ──
  it('groupchoice/groupcomp/groupseq/repsep resolve to figgroup/ph', () => {
    const xml = `<topic id="t"><body>
      <syntaxdiagram>
        <groupseq><kwd>a</kwd><repsep/><kwd>b</kwd></groupseq>
        <groupchoice><kwd>x</kwd><kwd>y</kwd></groupchoice>
        <groupcomp><kwd>m</kwd><kwd>n</kwd></groupcomp>
      </syntaxdiagram>
    </body></topic>`;
    const { root, html } = parseTopic(xml);
    assert.strictEqual(findEl(root, 'groupseq')!.baseType, 'topic/figgroup');
    assert.strictEqual(findEl(root, 'groupchoice')!.baseType, 'topic/figgroup');
    assert.strictEqual(findEl(root, 'groupcomp')!.baseType, 'topic/figgroup');
    assert.strictEqual(findEl(root, 'repsep')!.baseType, 'topic/ph');
    assert.ok((html.match(/class="figgroup"/g) || []).length === 3);
  });

  // ── MathML / SVG foreign-content domains ──
  it('mathml/mathmlref and svg-container/svgref resolve to foreign/xref', () => {
    const xml = `<topic id="t"><body>
      <p><mathml>x</mathml> <mathmlref href="eq.dita">see eq</mathmlref></p>
      <p><svg-container>s</svg-container> <svgref href="fig.dita">see fig</svgref></p>
    </body></topic>`;
    const { root } = parseTopic(xml);
    assert.strictEqual(findEl(root, 'mathml')!.baseType, 'topic/foreign');
    assert.strictEqual(findEl(root, 'mathmlref')!.baseType, 'topic/xref');
    assert.strictEqual(findEl(root, 'svg-container')!.baseType, 'topic/foreign');
    assert.strictEqual(findEl(root, 'svgref')!.baseType, 'topic/xref');
  });

  // ── UI, markup, xml domains, and hazard messagepanel ──
  it('ui/markup/xml domain keyword-like elements and hazard messagepanel resolve correctly', () => {
    const xml = `<topic id="t"><body>
      <p><uicontrol>Save<shortcut>S</shortcut></uicontrol></p>
      <p><markupname>&lt;p&gt;</markupname></p>
      <p><xmlelement>p</xmlelement> <xmlatt>class</xmlatt> <xmlnsname>xmlns:x</xmlnsname>
         <xmlpi>xml-stylesheet</xmlpi> <parameterentity>% foo</parameterentity>
         <textentity>&amp;copy;</textentity> <numcharref>&amp;#160;</numcharref></p>
      <hazardstatement><messagepanel><typeofhazard>Shock</typeofhazard></messagepanel></hazardstatement>
    </body></topic>`;
    const { root } = parseTopic(xml);
    assert.strictEqual(findEl(root, 'shortcut')!.baseType, 'topic/keyword');
    assert.strictEqual(findEl(root, 'markupname')!.baseType, 'topic/keyword');
    for (const tag of ['xmlelement', 'xmlatt', 'xmlnsname', 'xmlpi', 'parameterentity', 'textentity', 'numcharref']) {
      assert.strictEqual(findEl(root, tag)!.baseType, 'topic/keyword', `${tag} should map to topic/keyword`);
    }
    assert.strictEqual(findEl(root, 'messagepanel')!.baseType, 'topic/ul');
  });

  // ── Prolog/bookmeta-locked metadata (release-management + bookmap) ──
  // These resolve correctly at the parser level, but in real documents they
  // always sit under <prolog> (topic/prolog → '') or <bookmeta>
  // (map/topicmeta → '' in mapTypeMap.ts), both of which already swallow
  // their entire subtree. So unlike the utilities/programming/mathml/svg
  // domains above, adding these baseTypes does NOT change what actually
  // renders for a real .dita/.bookmap file today — it only makes the
  // baseType data itself correct for any other consumer that walks the
  // parsed tree at the topic-parser level (parseDita).
  it('release-management change-* fields resolve to topic/metadata|data (prolog-locked, still suppressed)', () => {
    const xml = `<topic id="t">
      <prolog>
        <change-historylist>
          <change-item>
            <change-person>Jane</change-person>
            <change-revisionid>r7</change-revisionid>
          </change-item>
        </change-historylist>
      </prolog>
      <body><p>Visible</p></body>
    </topic>`;
    const { root, html } = parseTopic(xml);
    assert.strictEqual(findEl(root, 'change-historylist')!.baseType, 'topic/metadata');
    assert.strictEqual(findEl(root, 'change-item')!.baseType, 'topic/data');
    assert.strictEqual(findEl(root, 'change-person')!.baseType, 'topic/data');
    // Still suppressed by the ancestor <prolog>, same as before this batch.
    assert.ok(!html.includes('Jane'), 'change-person text must not leak into the body');
    assert.ok(html.includes('Visible'));
  });

  it('bookmap metadata fields resolve to topic/data|ph|title (bookmeta-locked, still suppressed)', () => {
    const xml = `<bookmap>
      <booktitle><mainbooktitle>My Book</mainbooktitle></booktitle>
      <bookmeta>
        <bookid><isbn>123</isbn><booknumber>7</booknumber></bookid>
        <publisherinformation>Acme Press</publisherinformation>
      </bookmeta>
    </bookmap>`;
    const doc = parseDitamap(preprocessEntities(xml));
    // bookmeta's children resolve via the @class-attribute fallback only when
    // present; here we confirm the map-side render still suppresses the
    // whole <bookmeta> subtree via the existing map/topicmeta → '' renderer,
    // regardless of these new topic-side baseType entries.
    const html = renderMapDocument(doc.root, { docDir: '/test' });
    assert.ok(!html.includes('Acme Press'), 'bookmeta content must not leak into the map tree render');
  });

  it('delay-resolution exportanchors and ditavalref-d prefix/suffix fields resolve (prolog-locked)', () => {
    const xml = `<topic id="t">
      <prolog>
        <exportanchors>
          <dvrResourcePrefix>pre-</dvrResourcePrefix>
          <dvrResourceSuffix>-suf</dvrResourceSuffix>
          <dvrKeyscopePrefix>kpre-</dvrKeyscopePrefix>
          <dvrKeyscopeSuffix>-ksuf</dvrKeyscopeSuffix>
        </exportanchors>
      </prolog>
      <body><p>Visible</p></body>
    </topic>`;
    const { root, html } = parseTopic(xml);
    assert.strictEqual(findEl(root, 'exportanchors')!.baseType, 'topic/keywords');
    assert.strictEqual(findEl(root, 'dvrResourcePrefix')!.baseType, 'topic/data');
    assert.strictEqual(findEl(root, 'dvrResourceSuffix')!.baseType, 'topic/data');
    assert.strictEqual(findEl(root, 'dvrKeyscopePrefix')!.baseType, 'topic/data');
    assert.strictEqual(findEl(root, 'dvrKeyscopeSuffix')!.baseType, 'topic/data');
    assert.ok(!html.includes('pre-'), 'exportanchors content must not leak into the body');
    assert.ok(html.includes('Visible'));
  });
});
