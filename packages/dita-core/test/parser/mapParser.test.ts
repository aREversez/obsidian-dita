import * as assert from 'assert';
import { parseDitamap, preprocessEntities } from '../../src/parser/ditaParser';

const TEST_MAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE map PUBLIC "-//OASIS//DTD DITA Map//EN" "map.dtd">
<map>
    <title>Test</title>
    <keydef keys="name">
        <topicmeta>
            <keywords>
                <keyword>Rectangle</keyword>
            </keywords>
        </topicmeta>
    </keydef>
    <topicref keys="product_name" href="topics/db_overview.dita">
        <topicmeta><linktext>DatabaseX Pro v3.0</linktext></topicmeta>
    </topicref>
    <topicref keys="company_name">
        <topicmeta><linktext>ACME Corporation</linktext></topicmeta>
    </topicref>
    <topicref href="topics/db_overview.dita"/>
    <topicref href="topics/db_config.dita"/>
    <topicref href="topics/db_ui_test.dita"/>
    <topicref keys="product_version">
        <topicmeta>
            <linktext>V1.0.0</linktext>
        </topicmeta>
    </topicref>
</map>`;

describe('mapParser', () => {
  it('should parse a minimal map with title', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<map>
  <title>Test Map</title>
</map>`;
    const doc = parseDitamap(xml);
    assert.strictEqual(doc.root.baseType, 'map/map');
    assert.strictEqual(doc.root.tagName, 'map');
  });

  it('should parse keydef with keyword text', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<map>
  <keydef keys="name">
    <topicmeta>
      <keywords><keyword>Rectangle</keyword></keywords>
    </topicmeta>
  </keydef>
</map>`;
    const doc = parseDitamap(xml);
    const keydef = doc.root.children.find(
      (c) => c.type === 'element' && c.baseType === 'map/keydef',
    );
    assert.ok(keydef, 'keydef element not found');
    assert.strictEqual(keydef!.attributes?.keys, 'name');

    const topicmeta = keydef!.children.find(
      (c) => c.type === 'element' && c.baseType === 'map/topicmeta',
    );
    assert.ok(topicmeta, 'topicmeta not found');
    const keywords = topicmeta!.children.find(
      (c) => c.type === 'element' && c.baseType === 'map/keywords',
    );
    assert.ok(keywords, 'keywords not found');
    const keyword = keywords!.children.find(
      (c) => c.type === 'element' && c.baseType === 'map/keyword',
    );
    assert.ok(keyword, 'keyword not found');
    const text = keyword!.children.find((c) => c.type === 'text');
    assert.strictEqual(text?.text, 'Rectangle');
  });

  it('should parse topicref with keys, href and linktext', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<map>
  <topicref keys="product_name" href="topics/db_overview.dita">
    <topicmeta><linktext>DatabaseX Pro v3.0</linktext></topicmeta>
  </topicref>
</map>`;
    const doc = parseDitamap(xml);
    const ref = doc.root.children.find(
      (c) => c.type === 'element' && c.baseType === 'map/topicref',
    );
    assert.ok(ref);
    assert.strictEqual(ref!.attributes?.keys, 'product_name');
    assert.strictEqual(ref!.attributes?.href, 'topics/db_overview.dita');

    const topicmeta = ref!.children.find(
      (c) => c.type === 'element' && c.baseType === 'map/topicmeta',
    );
    assert.ok(topicmeta);
    const linktext = topicmeta!.children.find(
      (c) => c.type === 'element' && c.baseType === 'map/linktext',
    );
    assert.ok(linktext);
    const text = linktext!.children.find((c) => c.type === 'text');
    assert.strictEqual(text?.text, 'DatabaseX Pro v3.0');
  });

  it('should parse topicref with only keys, no href', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<map>
  <topicref keys="company_name">
    <topicmeta><linktext>ACME Corporation</linktext></topicmeta>
  </topicref>
</map>`;
    const doc = parseDitamap(xml);
    const ref = doc.root.children.find(
      (c) => c.type === 'element' && c.baseType === 'map/topicref',
    );
    assert.ok(ref);
    assert.strictEqual(ref!.attributes?.keys, 'company_name');
    assert.strictEqual(ref!.attributes?.href, undefined);
  });

  it('should parse topicref with href but no topicmeta', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<map>
  <topicref href="topics/db_overview.dita"/>
</map>`;
    const doc = parseDitamap(xml);
    const ref = doc.root.children.find(
      (c) => c.type === 'element' && c.baseType === 'map/topicref',
    );
    assert.ok(ref);
    assert.strictEqual(ref!.attributes?.href, 'topics/db_overview.dita');
    assert.strictEqual(ref!.attributes?.keys, undefined);
  });

  // ── BookMap parsing tests ──

  it('should parse a bookmap root element as map/map', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bookmap>
  <booktitle><mainbooktitle>My Book</mainbooktitle></booktitle>
  <chapter href="intro.dita"/>
</bookmap>`;
    const doc = parseDitamap(xml);
    assert.strictEqual(doc.root.baseType, 'map/map');
    assert.strictEqual(doc.root.tagName, 'bookmap');
  });

  it('should parse booktitle and mainbooktitle as map-title', () => {
    const xml = `<bookmap>
  <booktitle><mainbooktitle>My Book Title</mainbooktitle></booktitle>
</bookmap>`;
    const doc = parseDitamap(xml);
    const booktitle = doc.root.children.find(
      (c) => c.type === 'element' && c.baseType === 'map/map-title',
    );
    assert.ok(booktitle, 'booktitle not found as map-title');
    assert.strictEqual(booktitle!.tagName, 'booktitle');
    const mainbooktitle = booktitle!.children.find(
      (c) => c.type === 'element' && c.baseType === 'map/map-title',
    );
    assert.ok(mainbooktitle, 'mainbooktitle not found as map-title');
    assert.strictEqual(mainbooktitle!.tagName, 'mainbooktitle');
  });

  it('should parse chapter as map/topicref', () => {
    const xml = `<bookmap>
  <chapter href="topics/intro.dita">
    <topicmeta><navtitle>Introduction</navtitle></topicmeta>
  </chapter>
</bookmap>`;
    const doc = parseDitamap(xml);
    const chapter = doc.root.children.find(
      (c) => c.type === 'element' && c.baseType === 'map/topicref',
    );
    assert.ok(chapter, 'chapter not found as topicref');
    assert.strictEqual(chapter!.tagName, 'chapter');
    assert.strictEqual(chapter!.attributes?.href, 'topics/intro.dita');
  });

  it('should parse frontmatter, booklists, and toc as map/bookmap-structural', () => {
    const xml = `<bookmap>
  <frontmatter>
    <booklists>
      <toc/>
    </booklists>
  </frontmatter>
</bookmap>`;
    const doc = parseDitamap(xml);
    const frontmatter = doc.root.children.find(
      (c) => c.type === 'element' && c.baseType === 'map/bookmap-structural' && c.tagName === 'frontmatter',
    );
    assert.ok(frontmatter, 'frontmatter not found as bookmap-structural');
    const booklists = frontmatter!.children.find(
      (c) => c.type === 'element' && c.baseType === 'map/bookmap-structural' && c.tagName === 'booklists',
    );
    assert.ok(booklists, 'booklists not found as bookmap-structural');
    const toc = booklists!.children.find(
      (c) => c.type === 'element' && c.baseType === 'map/bookmap-structural' && c.tagName === 'toc',
    );
    assert.ok(toc, 'toc not found as bookmap-structural');
  });

  it('should parse appendix and part as map/topicref', () => {
    const xml = `<bookmap>
  <part href="part1.dita">
    <chapter href="ch1.dita"/>
  </part>
  <appendix href="appA.dita"/>
</bookmap>`;
    const doc = parseDitamap(xml);
    const refs = doc.root.children.filter(
      (c) => c.type === 'element' && c.baseType === 'map/topicref',
    );
    assert.strictEqual(refs.length, 2);
    assert.strictEqual(refs[0].tagName, 'part');
    assert.strictEqual(refs[1].tagName, 'appendix');
  });

  it('should parse bookmeta as map/topicmeta', () => {
    const xml = `<bookmap>
  <bookmeta>
    <keywords><keyword>BookMeta</keyword></keywords>
  </bookmeta>
</bookmap>`;
    const doc = parseDitamap(xml);
    const bookmeta = doc.root.children.find(
      (c) => c.type === 'element' && c.baseType === 'map/topicmeta',
    );
    assert.ok(bookmeta, 'bookmeta not found as topicmeta');
    assert.strictEqual(bookmeta!.tagName, 'bookmeta');
  });

  it('should parse real test.ditamap content', () => {
    const doc = parseDitamap(preprocessEntities(TEST_MAP_XML));
    assert.strictEqual(doc.root.baseType, 'map/map');

    const titleEl = doc.root.children.find(
      (c) => c.type === 'element' && c.baseType === 'map/map-title',
    );
    assert.ok(titleEl, 'title element not found');

    const keydefs = doc.root.children.filter(
      (c) => c.type === 'element' && c.baseType === 'map/keydef',
    );
    assert.strictEqual(keydefs.length, 1);
    assert.strictEqual(keydefs[0].attributes?.keys, 'name');

    const refs = doc.root.children.filter(
      (c) => c.type === 'element' && (c.baseType === 'map/topicref'),
    );
    assert.strictEqual(refs.length, 6);

    const prodRef = refs.find((r) => r.attributes?.keys === 'product_name');
    assert.ok(prodRef);
    assert.strictEqual(prodRef!.attributes?.href, 'topics/db_overview.dita');
  });

  it('should map less common bookmap topicref specializations so their hrefs are not dropped', () => {
    const xml = `<bookmap>
      <frontmatter>
        <bookabstract href="abstract.dita"/>
        <dedication href="dedication.dita"/>
      </frontmatter>
      <backmatter>
        <amendments href="amendments.dita"/>
        <booklists>
          <abbrevlist/>
          <bibliolist/>
          <trademarklist/>
        </booklists>
        <colophon href="colophon.dita"/>
        <glossaryref href="glossary.dita"/>
      </backmatter>
    </bookmap>`;
    const doc = parseDitamap(preprocessEntities(xml));

    const byBaseType: Record<string, string[]> = {};
    (function walk(node: typeof doc.root) {
      if (node.type === 'element' && node.baseType) {
        (byBaseType[node.baseType] ||= []).push(node.tagName || '');
      }
      for (const child of node.children || []) walk(child);
    })(doc.root);

    // Every href-bearing specialization must be a topicref so tree/book views render it
    for (const tag of ['bookabstract', 'dedication', 'amendments', 'colophon', 'glossaryref']) {
      assert.ok(byBaseType['map/topicref']?.includes(tag), `${tag} should map to map/topicref`);
    }
    // Booklist members are structural containers
    for (const tag of ['abbrevlist', 'bibliolist', 'trademarklist']) {
      assert.ok(byBaseType['map/bookmap-structural']?.includes(tag), `${tag} should map to map/bookmap-structural`);
    }
  });
});
