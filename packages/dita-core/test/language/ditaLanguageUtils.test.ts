import * as assert from 'assert';
import {
  collectIds,
  collectMapSymbols,
  collectRefEntries,
  collectTopicSymbols,
  collectUnknownElements,
  findConrefTargetOffset,
  findEnclosingKeydefKeys,
  findIdAttrAt,
  findKeyDefinitionOffset,
  findKeysAttrAt,
  findRefAttrAt,
  findUnclosedTag,
  getAttributesForTag,
  getAutoCloseTag,
  getCloseTagCompletion,
  getCompletionContext,
  getMapRefName,
  isExternalRef,
  offsetToLineCol,
  splitRefFragment,
  stripSameDocumentFragmentPrefix,
} from '../../src/language/ditaLanguageUtils';
import { parseDita, parseDitamap } from '../../src/parser/ditaParser';
import { DitaNode } from '../../src/parser/domTypes';
import { collectMapEntries, createBookRoleLabeler } from '../../src/render/mapTypeMap';

describe('ditaLanguageUtils', () => {
  describe('collectRefEntries', () => {
    it('collects href, conref, conkeyref and keyref attributes', () => {
      const text =
        '<xref href="a.dita"/><p conref="b.dita#t/e"/><ph conkeyref="k/el"/><keyword keyref="prod"/>';
      const entries = collectRefEntries(text);
      assert.deepStrictEqual(
        entries.map((e) => [e.attr, e.value, e.tagName]),
        [
          ['href', 'a.dita', 'xref'],
          ['conref', 'b.dita#t/e', 'p'],
          ['conkeyref', 'k/el', 'ph'],
          ['keyref', 'prod', 'keyword'],
        ],
      );
    });

    it('reports exact value offsets', () => {
      const text = '<xref href="topic.dita">x</xref>';
      const [entry] = collectRefEntries(text);
      assert.strictEqual(text.substring(entry.valueStart, entry.valueEnd), 'topic.dita');
    });

    it('captures scope and format from the same tag', () => {
      const text = '<xref href="https://x.com" scope="external" format="html"/>';
      const [entry] = collectRefEntries(text);
      assert.strictEqual(entry.scope, 'external');
      assert.strictEqual(entry.format, 'html');
    });

    it('ignores attributes outside of tags and non-ref attributes', () => {
      const text = '<p id="x">href="fake.dita"</p>';
      assert.strictEqual(collectRefEntries(text).length, 0);
    });

    it('handles multi-line tags', () => {
      const text = '<topicref\n  href="topics/a.dita"\n  keys="a"/>';
      const entries = collectRefEntries(text);
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].value, 'topics/a.dita');
    });
  });

  describe('findRefAttrAt', () => {
    it('finds the entry containing the offset', () => {
      const text = '<xref href="topic.dita">x</xref>';
      const inside = text.indexOf('topic.dita') + 3;
      assert.strictEqual(findRefAttrAt(text, inside)?.attr, 'href');
    });

    it('returns undefined outside any ref value', () => {
      const text = '<xref href="topic.dita">x</xref>';
      assert.strictEqual(findRefAttrAt(text, 2), undefined);
    });
  });

  describe('isExternalRef', () => {
    it('flags URL schemes, absolute paths, empty values and external scope', () => {
      assert.strictEqual(isExternalRef('https://a.com'), true);
      assert.strictEqual(isExternalRef('mailto:x@y.com'), true);
      assert.strictEqual(isExternalRef('C:\\x\\y.dita'), true);
      assert.strictEqual(isExternalRef('/etc/x.dita'), true);
      assert.strictEqual(isExternalRef(''), true);
      assert.strictEqual(isExternalRef('a.dita', 'external'), true);
      assert.strictEqual(isExternalRef('a.dita', 'peer'), true);
    });

    it('accepts relative project paths', () => {
      assert.strictEqual(isExternalRef('topics/a.dita'), false);
      assert.strictEqual(isExternalRef('a.dita#id', 'local'), false);
    });
  });

  describe('findKeyDefinitionOffset', () => {
    const mapText = '<map>\n<keydef keys="alpha beta"/>\n<topicref keys="gamma" href="g.dita"/>\n</map>';

    it('finds a key inside a space-separated keys list', () => {
      const off = findKeyDefinitionOffset(mapText, 'beta');
      assert.ok(off >= 0);
      assert.ok(mapText.substring(off).startsWith('keys="alpha beta"'));
    });

    it('finds keys on topicref elements too', () => {
      assert.ok(findKeyDefinitionOffset(mapText, 'gamma') >= 0);
    });

    it('does not match partial key names', () => {
      assert.strictEqual(findKeyDefinitionOffset(mapText, 'alph'), -1);
      assert.strictEqual(findKeyDefinitionOffset(mapText, 'delta'), -1);
    });
  });

  describe('stripSameDocumentFragmentPrefix', () => {
    it('strips a leading "./" marker', () => {
      assert.strictEqual(stripSameDocumentFragmentPrefix('./note_xxx'), 'note_xxx');
      assert.strictEqual(stripSameDocumentFragmentPrefix('./t2/p1'), 't2/p1');
    });

    it('leaves fragments without the marker unchanged', () => {
      assert.strictEqual(stripSameDocumentFragmentPrefix('note_xxx'), 'note_xxx');
      assert.strictEqual(stripSameDocumentFragmentPrefix('t2/p1'), 't2/p1');
      assert.strictEqual(stripSameDocumentFragmentPrefix(''), '');
    });
  });

  describe('splitRefFragment', () => {
    it('splits the standard two-part form into topic scope and element id', () => {
      assert.deepStrictEqual(splitRefFragment('db_overview/shared_note'), {
        topicId: 'db_overview',
        elementId: 'shared_note',
      });
    });

    it('treats a one-part fragment as the id itself, with no topic scope', () => {
      assert.deepStrictEqual(splitRefFragment('shared_note'), {
        topicId: undefined,
        elementId: 'shared_note',
      });
    });

    it('normalizes the "./" same-document shorthand before splitting', () => {
      assert.deepStrictEqual(splitRefFragment('./shared_note'), {
        topicId: undefined,
        elementId: 'shared_note',
      });
      assert.deepStrictEqual(splitRefFragment('./t2/p1'), { topicId: 't2', elementId: 'p1' });
    });

    it('returns an empty element id for an empty fragment', () => {
      assert.deepStrictEqual(splitRefFragment(''), { topicId: undefined, elementId: '' });
    });

    it('yields the element id, not the topic id, for the form conrefs are actually written in', () => {
      // The regression this helper exists to prevent: find-references used to
      // take segment [0] of a "topicId/elementId" fragment and compare it
      // against an id="..." value, so the two could never be equal and every
      // cross-file conref was dropped from the results.
      const { elementId } = splitRefFragment('db_overview/shared_note');
      assert.strictEqual(elementId, 'shared_note');
      assert.notStrictEqual(elementId, 'db_overview');
    });
  });

  describe('findConrefTargetOffset', () => {
    const text = '<topic id="t1"><body><p id="p1">x</p></body></topic><topic id="t2"><p id="p1">y</p></topic>';

    it('resolves "topicId" to the topic id offset', () => {
      const off = findConrefTargetOffset(text, 't2');
      assert.ok(text.substring(off).startsWith('id="t2"'));
    });

    it('resolves "topicId/elementId" to the element after the topic', () => {
      const off = findConrefTargetOffset(text, 't2/p1');
      assert.ok(off > text.indexOf('id="t2"'));
    });

    it('returns -1 for missing ids', () => {
      assert.strictEqual(findConrefTargetOffset(text, 'missing'), -1);
      assert.strictEqual(findConrefTargetOffset(text, 't1/missing'), -1);
    });

    it('resolves the "./elementId" same-document shorthand instead of treating "." as a literal (unmatchable) topic id', () => {
      const selfRefText = '<topic id="t1"><body><note id="note_xxx">x</note></body></topic>';
      const off = findConrefTargetOffset(selfRefText, './note_xxx');
      assert.ok(off >= 0, 'should find note_xxx despite the "./" prefix');
      assert.ok(selfRefText.substring(off).startsWith('id="note_xxx"'));
    });

    it('resolves the "./topicId/elementId" same-document shorthand for a topic-scoped fragment, not just the bare-id case', () => {
      // Before stripping the "./" prefix up front, splitting on the FIRST
      // "/" in "./t2/p1" put "." in topicId (already handled) but folded
      // the rest -- "t2/p1" -- into a single, unmatchable elementId instead
      // of recognizing "t2" as the topic scope.
      const off = findConrefTargetOffset(text, './t2/p1');
      assert.ok(off > text.indexOf('id="t2"'), 'should resolve p1 scoped to topic t2, not search for a literal "t2/p1" id');
    });
  });

  describe('collectIds / offsetToLineCol', () => {
    it('collects all declared ids', () => {
      assert.deepStrictEqual(collectIds('<topic id="a"><p id="b"/></topic>'), ['a', 'b']);
    });

    it('converts offsets to 0-based line/col', () => {
      const text = 'ab\ncd\nef';
      assert.deepStrictEqual(offsetToLineCol(text, 0), { line: 0, col: 0 });
      assert.deepStrictEqual(offsetToLineCol(text, 4), { line: 1, col: 1 });
      assert.deepStrictEqual(offsetToLineCol(text, 6), { line: 2, col: 0 });
    });
  });

  describe('findIdAttrAt', () => {
    const text = '<topic id="intro"><p id="p1">x</p></topic>';

    it('returns the id when the offset is inside the value', () => {
      const off = text.indexOf('"intro"') + 3; // middle of "intro"
      assert.deepStrictEqual(findIdAttrAt(text, off)?.id, 'intro');
    });

    it('matches at both the start and end boundary of the value', () => {
      const start = text.indexOf('intro');
      const end = start + 'intro'.length;
      assert.strictEqual(findIdAttrAt(text, start)?.id, 'intro');
      assert.strictEqual(findIdAttrAt(text, end)?.id, 'intro');
    });

    it('returns undefined outside any id value', () => {
      assert.strictEqual(findIdAttrAt(text, 0), undefined);
      assert.strictEqual(findIdAttrAt(text, text.indexOf('<p')), undefined);
    });

    it('finds the second id, not just the first', () => {
      const off = text.indexOf('"p1"') + 2;
      assert.strictEqual(findIdAttrAt(text, off)?.id, 'p1');
    });
  });

  describe('findKeysAttrAt', () => {
    const text = '<keydef keys="alpha beta gamma" href="a.dita"/>';

    it('returns just the single token the offset lands on, not the whole list', () => {
      const betaStart = text.indexOf('beta');
      assert.strictEqual(findKeysAttrAt(text, betaStart)?.key, 'beta');
      assert.strictEqual(findKeysAttrAt(text, betaStart + 2)?.key, 'beta');
    });

    it('resolves the first and last token correctly (boundary check)', () => {
      assert.strictEqual(findKeysAttrAt(text, text.indexOf('alpha'))?.key, 'alpha');
      const gammaStart = text.indexOf('gamma');
      assert.strictEqual(findKeysAttrAt(text, gammaStart + 'gamma'.length)?.key, 'gamma');
    });

    it('returns undefined when the offset lands on the whitespace between tokens', () => {
      const text2 = '<keydef keys="alpha  beta" href="a.dita"/>'; // two spaces: a genuine interior gap position exists
      const gapOffset = text2.indexOf('alpha') + 'alpha'.length + 1; // strictly inside the 2-space gap
      assert.strictEqual(findKeysAttrAt(text2, gapOffset), undefined);
    });

    it('returns undefined for an unrelated keys-less attribute value', () => {
      assert.strictEqual(findKeysAttrAt(text, text.indexOf('a.dita')), undefined);
    });

    it('returns undefined when there is no keys attribute at all', () => {
      assert.strictEqual(findKeysAttrAt('<topicref href="a.dita"/>', 5), undefined);
    });
  });

  describe('findEnclosingKeydefKeys', () => {
    it('finds the key(s) when the cursor is on the href, not the keys attribute itself', () => {
      const text = '<keydef keys="product_name" href="a.dita"/>';
      const hrefOffset = text.indexOf('a.dita');
      assert.deepStrictEqual(findEnclosingKeydefKeys(text, hrefOffset)?.keys, ['product_name']);
    });

    it('finds the key(s) when the cursor is on a nested <keyword> display text -- the case a user unfamiliar with the extension is likely to click', () => {
      const text = '<keydef keys="product_name"><topicmeta><keywords><keyword>Acme Widget</keyword></keywords></topicmeta></keydef>';
      const keywordTextOffset = text.indexOf('Acme Widget') + 2;
      assert.deepStrictEqual(findEnclosingKeydefKeys(text, keywordTextOffset)?.keys, ['product_name']);
    });

    it('returns every alias when a keydef declares multiple keys', () => {
      const text = '<keydef keys="a b c" href="x.dita"/>';
      const hrefOffset = text.indexOf('x.dita');
      assert.deepStrictEqual(findEnclosingKeydefKeys(text, hrefOffset)?.keys, ['a', 'b', 'c']);
    });

    it('returns undefined outside any keydef element', () => {
      const text = '<map><keydef keys="a" href="x.dita"/></map>';
      assert.strictEqual(findEnclosingKeydefKeys(text, 0), undefined); // on <map>, before the keydef
      const afterEnd = text.indexOf('</map>') + 3;
      assert.strictEqual(findEnclosingKeydefKeys(text, afterEnd), undefined);
    });

    it('does not treat a DIFFERENT, later keydef as the enclosing one', () => {
      const text = '<map><keydef keys="first" href="a.dita"/><keydef keys="second" href="b.dita"/></map>';
      const secondHrefOffset = text.indexOf('b.dita');
      assert.deepStrictEqual(findEnclosingKeydefKeys(text, secondHrefOffset)?.keys, ['second']);
    });

    it('handles a non-self-closing keydef with a closing tag', () => {
      const text = '<keydef keys="k1"><topicmeta><keywords><keyword>Label</keyword></keywords></topicmeta></keydef><p>outside</p>';
      const insideOffset = text.indexOf('Label');
      const outsideOffset = text.indexOf('outside');
      assert.deepStrictEqual(findEnclosingKeydefKeys(text, insideOffset)?.keys, ['k1']);
      assert.strictEqual(findEnclosingKeydefKeys(text, outsideOffset), undefined);
    });
  });

  describe('getCompletionContext', () => {
    it('detects tag-name position after <', () => {
      const ctx = getCompletionContext('<p>text <no', 11);
      assert.strictEqual(ctx.kind, 'tag');
      assert.strictEqual(ctx.prefix, 'no');
    });

    it('detects attribute-name position inside a tag', () => {
      const text = '<xref hr';
      const ctx = getCompletionContext(text, text.length);
      assert.strictEqual(ctx.kind, 'attrName');
      assert.strictEqual(ctx.tagName, 'xref');
      assert.strictEqual(ctx.prefix, 'hr');
    });

    it('detects attribute-value position with prefix and valueStart', () => {
      const text = '<xref href="topics/a';
      const ctx = getCompletionContext(text, text.length);
      assert.strictEqual(ctx.kind, 'attrValue');
      assert.strictEqual(ctx.attrName, 'href');
      assert.strictEqual(ctx.prefix, 'topics/a');
      assert.strictEqual(ctx.valueStart, text.indexOf('topics/a'));
    });

    it('returns none inside text content, comments and closed tags', () => {
      assert.strictEqual(getCompletionContext('<p>hello', 8).kind, 'none');
      const comment = '<!-- note ';
      assert.strictEqual(getCompletionContext(comment, comment.length).kind, 'none');
      const pi = '<?xml version="1.0" ';
      assert.strictEqual(getCompletionContext(pi, pi.length).kind, 'none');
    });

    it('flags closing-tag typing with the closing marker', () => {
      const text = '<p>x</se';
      const ctx = getCompletionContext(text, text.length);
      assert.strictEqual(ctx.kind, 'tag');
      assert.strictEqual(ctx.closing, true);
      assert.strictEqual(ctx.prefix, 'se');
    });
  });

  describe('tag auto-closing', () => {
    it('returns the tag name right after an opening tag is completed', () => {
      const text = '<body><note type="tip">';
      assert.strictEqual(getAutoCloseTag(text, text.length), 'note');
    });

    it('ignores closing, self-closing, comment and PI ">"', () => {
      for (const text of ['</note>', '<image href="a.png"/>', '<!-- c -->', '<?xml version="1.0"?>']) {
        assert.strictEqual(getAutoCloseTag(text, text.length), undefined, text);
      }
    });

    it('ignores ">" typed inside an attribute value', () => {
      const text = '<xref href="a>';
      assert.strictEqual(getAutoCloseTag(text, text.length), undefined);
    });

    it('findUnclosedTag returns the innermost open element', () => {
      assert.strictEqual(findUnclosedTag('<topic><body><p>text'), 'p');
      assert.strictEqual(findUnclosedTag('<topic><body><p>text</p>'), 'body');
      assert.strictEqual(findUnclosedTag('<topic><body/><p>x</p>'), 'topic');
      assert.strictEqual(findUnclosedTag('<p>a</p>'), undefined);
    });

    it('findUnclosedTag skips comments, CDATA and doctype', () => {
      const text = '<!DOCTYPE topic PUBLIC "x" "y"><topic><!-- <fake> --><body>';
      assert.strictEqual(findUnclosedTag(text), 'body');
    });

    it('getCloseTagCompletion completes "</" with the innermost open tag', () => {
      const text = '<topic><body><p>text</';
      assert.strictEqual(getCloseTagCompletion(text, text.length), 'p');
      assert.strictEqual(getCloseTagCompletion('<p>no slash here', 5), undefined);
    });
  });

  describe('getAttributesForTag', () => {
    it('lists tag-specific attributes before universal ones', () => {
      const attrs = getAttributesForTag('xref');
      assert.strictEqual(attrs[0], 'href');
      assert.ok(attrs.includes('id'));
      assert.ok(attrs.includes('keyref'));
    });

    it('falls back to universal attributes for unknown tags', () => {
      const attrs = getAttributesForTag('unknowntag');
      assert.ok(attrs.includes('id'));
      assert.ok(attrs.includes('conref'));
    });
  });

  describe('collectTopicSymbols', () => {
    it('builds a nested outline including the root topic', () => {
      const xml = `<?xml version="1.0"?>
<concept id="c1">
  <title>Root Title</title>
  <conbody>
    <section id="s1"><title>Section One</title><p>x</p></section>
  </conbody>
</concept>`;
      const doc = parseDita(xml);
      const symbols = collectTopicSymbols(doc.root);
      assert.strictEqual(symbols.length, 1);
      assert.strictEqual(symbols[0].name, 'Root Title');
      assert.strictEqual(symbols[0].kind, 'topic');
      assert.strictEqual(symbols[0].children.length, 1);
      assert.strictEqual(symbols[0].children[0].name, 'Section One');
      assert.strictEqual(symbols[0].children[0].kind, 'section');
    });

    it('handles nested topics', () => {
      const xml = `<topic id="t1"><title>Outer</title>
  <topic id="t2"><title>Inner</title><body/></topic>
</topic>`;
      const doc = parseDita(xml);
      const symbols = collectTopicSymbols(doc.root);
      assert.strictEqual(symbols[0].children[0].name, 'Inner');
      assert.strictEqual(symbols[0].children[0].kind, 'topic');
    });
  });

  describe('collectMapSymbols / getMapRefName', () => {
    it('builds the map outline with refs, keydefs, topicheads and bookmap containers', () => {
      const xml = `<?xml version="1.0"?>
<bookmap>
  <booktitle><mainbooktitle>Book</mainbooktitle></booktitle>
  <keydef keys="prod"><topicmeta><keywords><keyword>P</keyword></keywords></topicmeta></keydef>
  <frontmatter>
    <preface href="pre.dita"/>
  </frontmatter>
  <chapter href="ch1.dita" navtitle="Chapter One">
    <topicref href="s1.dita"/>
  </chapter>
  <reltable><relrow/></reltable>
</bookmap>`;
      const doc = parseDitamap(xml);
      const symbols = collectMapSymbols(doc.root);
      const names = symbols.map((s) => [s.kind, s.name]);
      assert.deepStrictEqual(names, [
        ['keydef', 'prod'],
        ['structural', 'frontmatter'],
        ['ref', 'Chapter One'],
      ]);
      assert.strictEqual(symbols[1].children[0].name, 'pre.dita');
      assert.strictEqual(symbols[2].children[0].name, 's1.dita');
    });

    it('prefers navtitle element over href in getMapRefName', () => {
      const xml = `<map><topicref href="a.dita"><topicmeta><navtitle>Nice Name</navtitle></topicmeta></topicref></map>`;
      const doc = parseDitamap(xml);
      const ref = (doc.root.children || []).find((c) => c.baseType === 'map/topicref')!;
      assert.strictEqual(getMapRefName(ref), 'Nice Name');
    });

    it('numbers book divisions in the map outline detail', () => {
      const xml = `<bookmap>
  <chapter href="c1.dita"/>
  <chapter href="c2.dita"/>
  <appendix href="a.dita"/>
</bookmap>`;
      const doc = parseDitamap(xml);
      const symbols = collectMapSymbols(doc.root);
      assert.deepStrictEqual(
        symbols.map((s) => s.detail),
        ['Chapter 1', 'Chapter 2', 'Appendix A'],
      );
    });
  });

  describe('createBookRoleLabeler', () => {
    it('numbers chapters, parts (roman) and appendixes (letters) independently', () => {
      const label = createBookRoleLabeler();
      assert.strictEqual(label('preface', 0), 'Preface');
      assert.strictEqual(label('part', 0), 'Part I');
      assert.strictEqual(label('chapter', 0), 'Chapter 1');
      assert.strictEqual(label('chapter', 0), 'Chapter 2');
      assert.strictEqual(label('part', 0), 'Part II');
      assert.strictEqual(label('chapter', 0), 'Chapter 3');
      assert.strictEqual(label('appendix', 0), 'Appendix A');
      assert.strictEqual(label('appendix', 0), 'Appendix B');
      assert.strictEqual(label('topicref', 0), undefined);
      assert.strictEqual(label(undefined, 0), undefined);
    });

    it('rolls appendix letters past Z', () => {
      const label = createBookRoleLabeler();
      let last = '';
      for (let i = 0; i < 27; i++) last = label('appendix', 0)!;
      assert.strictEqual(last, 'Appendix AA');
    });

    it('restarts chapter numbering per nesting depth', () => {
      const label = createBookRoleLabeler();
      // Top-level chapters: 1, 2, 3
      assert.strictEqual(label('chapter', 0), 'Chapter 1');
      // Nested under Chapter 1: 1, 2, 3
      assert.strictEqual(label('chapter', 1), 'Chapter 1');
      assert.strictEqual(label('chapter', 1), 'Chapter 2');
      assert.strictEqual(label('chapter', 1), 'Chapter 3');
      // Back to top level: 2 (deeper counters reset)
      assert.strictEqual(label('chapter', 0), 'Chapter 2');
      // Nested under Chapter 2: 1, 2, 3, 4
      assert.strictEqual(label('chapter', 1), 'Chapter 1');
      assert.strictEqual(label('chapter', 1), 'Chapter 2');
      assert.strictEqual(label('chapter', 1), 'Chapter 3');
      assert.strictEqual(label('chapter', 1), 'Chapter 4');
      // Back to top level: 3
      assert.strictEqual(label('chapter', 0), 'Chapter 3');
      // Nested under Chapter 3: 1, 2, 3, 4, 5
      assert.strictEqual(label('chapter', 1), 'Chapter 1');
      assert.strictEqual(label('chapter', 1), 'Chapter 2');
      assert.strictEqual(label('chapter', 1), 'Chapter 3');
      assert.strictEqual(label('chapter', 1), 'Chapter 4');
      assert.strictEqual(label('chapter', 1), 'Chapter 5');
    });

    it('resets deeper counters when any division is encountered', () => {
      const label = createBookRoleLabeler();
      // Chapter at depth 1 under a (nonexistent) parent
      assert.strictEqual(label('chapter', 1), 'Chapter 1');
      assert.strictEqual(label('chapter', 1), 'Chapter 2');
      // A part at depth 0 resets depth-1 chapter counter
      assert.strictEqual(label('part', 0), 'Part I');
      // Chapter at depth 1 should restart
      assert.strictEqual(label('chapter', 1), 'Chapter 1');
    });

    it('numbers parts and appendixes per depth independently', () => {
      const label = createBookRoleLabeler();
      assert.strictEqual(label('part', 0), 'Part I');
      assert.strictEqual(label('part', 0), 'Part II');
      assert.strictEqual(label('part', 1), 'Part I');
      assert.strictEqual(label('part', 1), 'Part II');
      assert.strictEqual(label('appendix', 0), 'Appendix A');
      assert.strictEqual(label('appendix', 1), 'Appendix A');
    });

    it('threads numbered roles through collectMapEntries', () => {
      const xml = `<bookmap>
  <preface href="p.dita"/>
  <chapter href="c1.dita"><topicref href="s1.dita"/></chapter>
  <chapter href="c2.dita"/>
  <appendix href="a.dita"/>
</bookmap>`;
      const doc = parseDitamap(xml);
      const entries = collectMapEntries(doc.root);
      assert.deepStrictEqual(
        entries.map((e) => e.role),
        ['Preface', 'Chapter 1', undefined, 'Chapter 2', 'Appendix A'],
      );
    });

    it('applies an injected formatter for localized labels', () => {
      const zh = (info: { tagName: string; role: string; ordinal?: string }): string => {
        if (info.tagName === 'chapter') return `第 ${info.ordinal} 章`;
        if (info.tagName === 'part') return `第 ${info.ordinal} 部分`;
        if (info.tagName === 'appendix') return `附录 ${info.ordinal}`;
        return `[${info.role}]`;
      };
      const label = createBookRoleLabeler(zh);
      assert.strictEqual(label('preface', 0), '[Preface]');
      assert.strictEqual(label('chapter', 0), '第 1 章');
      assert.strictEqual(label('chapter', 0), '第 2 章');
      assert.strictEqual(label('part', 0), '第 I 部分');
      assert.strictEqual(label('appendix', 0), '附录 A');
    });

    it('threads the formatter through collectMapSymbols and collectMapEntries', () => {
      const xml = `<bookmap>
  <chapter href="c1.dita"/>
  <appendix href="a.dita"/>
</bookmap>`;
      const zh = (info: { tagName: string; role: string; ordinal?: string }): string =>
        info.tagName === 'chapter' ? `第 ${info.ordinal} 章` : `${info.role}!`;
      const doc = parseDitamap(xml);
      const symbols = collectMapSymbols(doc.root, zh);
      assert.deepStrictEqual(
        symbols.map((s) => s.detail),
        ['第 1 章', 'Appendix!'],
      );
      const entries = collectMapEntries(parseDitamap(xml).root, undefined, zh);
      assert.deepStrictEqual(
        entries.map((e) => e.role),
        ['第 1 章', 'Appendix!'],
      );
    });
  });

  describe('collectUnknownElements', () => {
    it('flags an element with no known tag name and no @class specialization', () => {
      const xml = `<topic id="t1"><title>T</title><body><mistyped-tag>x</mistyped-tag></body></topic>`;
      const doc = parseDita(xml);
      const unknown = collectUnknownElements(doc.root);
      assert.strictEqual(unknown.length, 1);
      assert.strictEqual(unknown[0].tagName, 'mistyped-tag');
    });

    it('does not flag standard DITA elements', () => {
      const xml = `<concept id="c1"><title>T</title><conbody>
        <p>text</p>
        <note type="warning">careful</note>
        <ul><li>one</li><li>two</li></ul>
      </conbody></concept>`;
      const doc = parseDita(xml);
      assert.deepStrictEqual(collectUnknownElements(doc.root), []);
    });

    it('does not flag a specialized element whose @class resolves it to a known base type', () => {
      // A specialization vocabulary can use an arbitrary tag name as long as
      // @class states what it specializes -- parseBaseType() in
      // ditaParser.ts falls back to this when the tag name itself is not in
      // the standard map, and this has to agree with that or every real
      // specialized document would light up as "unknown".
      const xml = `<topic id="t1"><title>T</title><body>
        <my-custom-para class="- topic/p ">hello</my-custom-para>
      </body></topic>`;
      const doc = parseDita(xml);
      assert.deepStrictEqual(collectUnknownElements(doc.root), []);
    });

    it('does not descend into <mathml> content, which is deliberately non-DITA markup', () => {
      // mathml resolves to topic/foreign (see standardTagMap.ts), whose
      // renderer serializes its children as raw markup without consulting
      // each one's own baseType -- see BASE_TYPE_RENDERERS['topic/foreign']
      // in baseTypeMap.ts. Every tag under it (mi, mo, mrow, ...) correctly
      // has no DITA baseType; that is not a typo to report.
      const xml = `<topic id="t1"><title>T</title><body>
        <p><mathml><mrow><mi>x</mi><mo>+</mo><mi>y</mi></mrow></mathml></p>
      </body></topic>`;
      const doc = parseDita(xml);
      assert.deepStrictEqual(collectUnknownElements(doc.root), []);
    });

    it('still flags a genuine typo alongside unrelated <mathml> content in the same document', () => {
      // The <mathml> skip must be scoped to that one subtree, not something
      // that quietly suppresses every other diagnostic once any foreign
      // content appears anywhere in the document.
      const xml = `<topic id="t1"><title>T</title><body>
        <p><mathml><mi>x</mi></mathml></p>
        <bogus-tag>oops</bogus-tag>
      </body></topic>`;
      const doc = parseDita(xml);
      const unknown = collectUnknownElements(doc.root);
      assert.strictEqual(unknown.length, 1);
      assert.strictEqual(unknown[0].tagName, 'bogus-tag');
    });

    it('does not flag real DITA prolog elements that simply have no entry of their own in standardTagMap.ts', () => {
      // Regression test: standardTagMap.ts has no direct entry for author,
      // critdate, metadata, audience or keywords -- only specialized
      // elements that happen to resolve to the same base types (see
      // exportanchors -> topic/keywords, change-historylist ->
      // topic/metadata) do. This used to mean a completely ordinary
      // <prolog> lit this diagnostic up on every one of these, even though
      // topic/prolog's own renderer (baseTypeMap.ts) already suppresses
      // its entire subtree unconditionally except for top-level indexterm
      // chips -- an unmapped tag name in here causes no silent content
      // loss, the reason this diagnostic exists in the first place.
      const xml = `<topic id="t1"><title>T</title>
        <prolog>
          <author>Jane</author>
          <critdate value="2024-01-01"/>
          <metadata>
            <audience type="user"/>
            <keywords><keyword>foo</keyword><indexterm>bar</indexterm></keywords>
          </metadata>
        </prolog>
        <body><p>x</p></body>
      </topic>`;
      const doc = parseDita(xml);
      assert.deepStrictEqual(collectUnknownElements(doc.root), []);
    });

    it('still flags a genuine typo outside <prolog>, even in a document whose prolog has unmapped elements', () => {
      const xml = `<topic id="t1"><title>T</title>
        <prolog><author>Jane</author></prolog>
        <body><bogus-tag>oops</bogus-tag></body>
      </topic>`;
      const doc = parseDita(xml);
      const unknown = collectUnknownElements(doc.root);
      assert.strictEqual(unknown.length, 1);
      assert.strictEqual(unknown[0].tagName, 'bogus-tag');
    });

    it('does not flag <indexterm> inside a map topicref\'s <topicmeta><keywords>', () => {
      // Regression test, map-side counterpart of the prolog one above:
      // mapTagMap.ts has no entry for indexterm (only the topic-side
      // tag map does), even though DITA maps reuse <keywords> verbatim
      // inside <topicmeta> and it is valid to nest an indexterm there.
      // map/topicmeta's renderer (mapTypeMap.ts) also returns '' for its
      // entire subtree unconditionally, extracting only navtitle/keyword
      // text via a separate getNodeText() call -- same shape as
      // topic/prolog, one level up, for maps.
      const xml = `<map><title>T</title>
        <topicref href="a.dita">
          <topicmeta><keywords><keyword>k1</keyword><indexterm>idx1</indexterm></keywords></topicmeta>
        </topicref>
      </map>`;
      const doc = parseDitamap(xml);
      assert.deepStrictEqual(collectUnknownElements(doc.root), []);
    });

    it('does not flag <ph> inside a map <title>, where a keyref-only <ph/> already resolves correctly', () => {
      // Regression test. mapTagMap.ts has no entry for ph at all -- unlike
      // indexterm above, this is not a topic-only element (ph is common
      // and valid directly inside a map's own <title>), but map/map-title
      // is rendered by extractText() (mapTypeMap.ts), a dedicated
      // baseType-agnostic recursive text walk with its own <ph
      // keyref="..."/> substitution built in. An unmapped tag under a
      // map's <title> was never actually losing content: extractText()
      // does not consult baseType at all.
      const xml = '<map><title><ph keyref="product_name"/> User Guide</title></map>';
      const doc = parseDitamap(xml);
      assert.deepStrictEqual(collectUnknownElements(doc.root), []);
    });

    it('does not flag <ph> inside a bookmap <booktitle>/<mainbooktitle>, which specializes the same base type', () => {
      const xml = '<bookmap><booktitle><mainbooktitle><ph keyref="x"/> Guide</mainbooktitle></booktitle></bookmap>';
      const doc = parseDitamap(xml);
      assert.deepStrictEqual(collectUnknownElements(doc.root), []);
    });

    it('still flags a genuine typo elsewhere in the map, in a document whose <title> also has an unmapped <ph>', () => {
      const xml = `<map><title><ph keyref="x"/> Guide</title>
        <topicref href="a.dita"><bogus-outside/></topicref>
      </map>`;
      const doc = parseDitamap(xml);
      const unknown = collectUnknownElements(doc.root);
      assert.strictEqual(unknown.length, 1);
      assert.strictEqual(unknown[0].tagName, 'bogus-outside');
    });

    it('flags nested unknown elements individually rather than only the outermost one', () => {
      const xml = `<topic id="t1"><title>T</title><body>
        <outer-bad><inner-bad>x</inner-bad></outer-bad>
      </body></topic>`;
      const doc = parseDita(xml);
      const unknown = collectUnknownElements(doc.root);
      assert.deepStrictEqual(
        unknown.map((u) => u.tagName).sort(),
        ['inner-bad', 'outer-bad'],
      );
    });

    it('does not flag a node with no tag name of its own, such as the synthetic wrapper the parser starts from', () => {
      // parseDita()/parseDitamap() already unwrap this before returning
      // .root -- the returned root is always a real element with a tag
      // name -- but collectUnknownElements() takes a DitaNode directly and
      // has no way to enforce that at the type level, so its own guard
      // against a tagName-less node is worth pinning on its own rather
      // than relying on every future caller happening to pass an already-
      // unwrapped root.
      const wrapper: DitaNode = {
        type: 'element',
        children: [],
        sourceRange: { startLine: 0, startCol: 0, endLine: 0, endCol: 0 },
      };
      assert.deepStrictEqual(collectUnknownElements(wrapper), []);
    });

    it('works the same way for .ditamap documents', () => {
      const xml = `<map><title>T</title><not-a-real-map-element/></map>`;
      const doc = parseDitamap(xml);
      const unknown = collectUnknownElements(doc.root);
      assert.strictEqual(unknown.length, 1);
      assert.strictEqual(unknown[0].tagName, 'not-a-real-map-element');
    });

    it('does not flag an unmapped element nested directly inside <indexterm>', () => {
      // Regression test. topic/indexterm's own renderer does not use the
      // generic child dispatch at all -- collectIndextermChips() (baseTypeMap.ts)
      // walks node.children itself, reading only direct text nodes plus
      // nested topic/indexterm, topic/index-see and topic/index-see-also by
      // baseType. Any other child element is simply never consulted, known
      // or unknown alike, so an unmapped tag name here causes no *additional*
      // content loss beyond what the renderer already does for every non-term
      // child -- not the "silently dropped, looks like a typo" case this
      // diagnostic exists to catch.
      const xml = `<topic id="t1"><title>T</title><body>
        <p><indexterm>term<weird-emphasis>nested</weird-emphasis></indexterm></p>
      </body></topic>`;
      const doc = parseDita(xml);
      assert.deepStrictEqual(collectUnknownElements(doc.root), []);
    });

    it('does not flag an unmapped element nested inside <index-see-also>, which is itself only ever consumed inside <indexterm>', () => {
      const xml = `<topic id="t1"><title>T</title><body>
        <p><indexterm>term<index-see-also><indexterm><weird-tag>y</weird-tag></indexterm></index-see-also></indexterm></p>
      </body></topic>`;
      const doc = parseDita(xml);
      assert.deepStrictEqual(collectUnknownElements(doc.root), []);
    });

    it('still flags a genuine typo outside <indexterm>, in a document whose indexterm also has unmapped content', () => {
      const xml = `<topic id="t1"><title>T</title><body>
        <p><indexterm>term<weird-emphasis>nested</weird-emphasis></indexterm></p>
        <bogus-tag>oops</bogus-tag>
      </body></topic>`;
      const doc = parseDita(xml);
      const unknown = collectUnknownElements(doc.root);
      assert.strictEqual(unknown.length, 1);
      assert.strictEqual(unknown[0].tagName, 'bogus-tag');
    });

    it('does not flag an unmapped element inside <relcolspec>, whose title is read via a baseType-agnostic extractText() fallback', () => {
      // Regression test, same shape as the map <title> hotfix above:
      // map/relheader's renderer (mapTypeMap.ts) falls back to extractText()
      // for a relcolspec's column title whenever @navtitle is absent, and
      // extractText() does not consult baseType at all -- an unmapped tag
      // here was never actually losing content.
      const xml = `<map><title>T</title>
        <reltable><relheader><relcolspec><weird-tag>Col A</weird-tag></relcolspec></relheader></reltable>
      </map>`;
      const doc = parseDitamap(xml);
      assert.deepStrictEqual(collectUnknownElements(doc.root), []);
    });

    it('still flags a genuine typo elsewhere in the map, in a document whose relcolspec also has unmapped content', () => {
      const xml = `<map><title>T</title>
        <reltable><relheader><relcolspec><weird-tag>Col A</weird-tag></relcolspec></relheader></reltable>
        <topicref href="a.dita"><bogus-outside/></topicref>
      </map>`;
      const doc = parseDitamap(xml);
      const unknown = collectUnknownElements(doc.root);
      assert.strictEqual(unknown.length, 1);
      assert.strictEqual(unknown[0].tagName, 'bogus-outside');
    });
  });
});
