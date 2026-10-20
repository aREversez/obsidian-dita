import sax from 'sax';
import { DitaNode, DitaDocument, SourceRange } from './domTypes';
import { STANDARD_TAG_TO_BASETYPE } from './standardTagMap';
import { MAP_STANDARD_TAG_TO_BASETYPE } from './mapTagMap';
import { lookupNamedEntity } from './namedEntities';

const TOPIC_PATTERN = /^(topic|map)\//;

// Modules whose elements the standard tag tables cover. A class token from one of
// these ("hi-d/b", "task/step") names a standard element, so its local name can
// be looked up in the tag table; a token from any other module is a custom
// specialization and must not be matched by name (my-d/b is not hi-d/b).
const STANDARD_MODULES = new Set([
  'topic', 'task', 'concept', 'reference', 'glossentry', 'glossgroup', 'troubleshooting',
  'hi-d', 'pr-d', 'sw-d', 'ui-d', 'ut-d', 'abbrev-d', 'xml-d', 'markup-d', 'delay-d',
  'equation-d', 'hazard-d', 'taskreq-d', 'svg-d', 'mathml-d',
  'map', 'mapgroup-d', 'bookmap', 'glossref-d', 'ditavalref-d',
]);

function makeParseBaseType(tagMap: Record<string, string>) {
  const known = new Set(Object.values(tagMap));

  return function parseBaseType(tagName: string, classAttr: string | undefined): string | undefined {
    const fromTag = tagMap[tagName];
    if (fromTag) {
      return fromTag;
    }

    if (classAttr) {
      const tokens = classAttr.trim().split(/\s+/);
      // A @class lists ancestors from the most general to the most specific
      // ("- topic/ph hi-d/b my-d/mybold "). Without a DTD the best answer is the
      // most specific token that is a standard element or a known base type.
      for (let i = tokens.length - 1; i >= 0; i--) {
        const token = tokens[i];
        const slash = token.indexOf('/');
        if (slash > 0) {
          if (STANDARD_MODULES.has(token.slice(0, slash))) {
            const viaName = tagMap[token.slice(slash + 1)];
            if (viaName) return viaName;
          }
          if (known.has(token)) return token;
        }
      }
      // Nothing recognisable: keep the first topic/map token, as before.
      for (const token of tokens) {
        if (TOPIC_PATTERN.test(token)) {
          return token;
        }
      }
    }

    return undefined;
  };
}

function makeRange(): SourceRange {
  return { startLine: 0, startCol: 0, endLine: 0, endCol: 0 };
}

/** One `<tag …>` / `</tag>` occurrence found by the source scanner below. */
interface TagEvent {
  name: string;
  selfClosing: boolean;
  isClose: boolean;
  /** Offset of the tag's '<'. */
  start: number;
  /** Offset just past the tag's '>'. */
  end: number;
}

/**
 * Walks the raw source and lists every element tag with its exact offsets.
 * sax's parser.line/column only update on newlines and at onopentag describe
 * the position AFTER the tag's '>', and parser.position is unreliable once
 * text has been reported — so tag ranges come from this scan instead. SAX
 * consumes tags in source order, so the parser's onopentag/onclosetag
 * handlers shift this queue one event at a time; `>` inside quoted attribute
 * values (conref="a>b.dita#t/id") is skipped like a real XML parser does,
 * `<` inside them is rejected by strict-mode sax outright.
 */
function scanTagEvents(xml: string): TagEvent[] {
  const events: TagEvent[] = [];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      i = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      i = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      // processing instruction / DOCTYPE: find the terminating '>' outside quotes
      let j = lt + 2;
      while (j < xml.length) {
        const ch = xml[j];
        if (ch === '"' || ch === "'") {
          const close = xml.indexOf(ch, j + 1);
          if (close < 0) break;
          j = close + 1;
          continue;
        }
        if (ch === '>') break;
        j++;
      }
      i = j + 1;
      continue;
    }
    const m = /^([A-Za-z_:][\w.:-]*)/.exec(xml.slice(lt + 1));
    if (!m) {
      i = lt + 1;
      continue;
    }
    const name = m[1];
    let j = lt + 1 + name.length;
    let selfClosing = false;
    let gt = -1;
    while (j < xml.length) {
      const ch = xml[j];
      if (ch === '"' || ch === "'") {
        const close = xml.indexOf(ch, j + 1);
        if (close < 0) break;
        j = close + 1;
        continue;
      }
      if (ch === '>') {
        selfClosing = xml[j - 1] === '/';
        gt = j;
        break;
      }
      j++;
    }
    if (gt < 0) break; // unterminated tag: leave the rest to sax's error handling
    const isClose = xml[lt + 1] === '/';
    events.push({ name, selfClosing, isClose, start: lt, end: gt + 1 });
    i = gt + 1;
  }
  return events;
}

function makeParser(tagMap: Record<string, string>) {
  const parseBaseType = makeParseBaseType(tagMap);

  return function parseXml(xml: string): DitaDocument {
    const parser = sax.parser(true, { trim: false, normalize: false });

    const root: DitaNode = {
      type: 'element',
      children: [],
      sourceRange: makeRange(),
    };

    const stack: DitaNode[] = [root];
    let currentText = '';
    let currentTextStartLine = 0;
    let currentTextStartCol = 0;
    // Range end stashed by onopentag for a self-closing tag, consumed by the
    // onclosetag sax fires immediately after for it.
    let selfClosingEnd: { line: number; col: number } | undefined;

    // The source scan feeding exact tag offsets to the handlers below.
    const tagEvents = scanTagEvents(xml);
    let q = 0;
    // (line, col) of a raw offset, via an ever-forward line-start cursor.
    // Tag offsets are consumed in document order, so it never rewinds.
    let lastLineStart = 0;
    let currentLine = 0;
    function locAt(pos: number): { line: number; col: number } {
      let i = lastLineStart;
      let line = currentLine;
      let nl = xml.indexOf('\n', i);
      while (nl !== -1 && nl < pos) {
        i = nl + 1;
        line++;
        nl = xml.indexOf('\n', i);
      }
      lastLineStart = i;
      currentLine = line;
      return { line, col: pos - i };
    }
    /**
     * Pops the queue's next tag of the given kind, trusting sax as the
     * authority on order but the scan as the authority on position. sax
     * lower-cases names by default, so the scan's raw spelling is compared
     * the same way. A head mismatch means the two disagree on something
     * exotic (a comment form neither skips identically); re-sync within a
     * small window and otherwise fall back to sax's own line/column, so
     * parsing never fails over a bookkeeping disagreement.
     */
    function nextTag(name: string, isClose: boolean): TagEvent | undefined {
      const want = name.toLowerCase();
      for (let k = q; k < Math.min(q + 8, tagEvents.length); k++) {
        const e = tagEvents[k];
        if (e.isClose !== isClose || e.name.toLowerCase() !== want) continue;
        // Skip the entries between q and k: whatever they were, sax has not
        // reported them, so they don't correspond to this parser's stream.
        q = k + 1;
        return e;
      }
      return undefined;
    }
    function saxFallbackEnd(): { line: number; col: number } {
      return { line: parser.line, col: parser.column };
    }

    function flushText() {
      if (currentText.length > 0) {
        const parent = stack[stack.length - 1];
        if (parent) {
          parent.children.push({
            type: 'text',
            text: currentText,
            children: [],
            sourceRange: {
              startLine: currentTextStartLine,
              startCol: currentTextStartCol,
              endLine: parser.line,
              endCol: parser.column,
            },
          });
        }
        currentText = '';
      }
    }

    parser.onopentag = (node) => {
      flushText();

      const tagName = node.name;
      const classAttr = node.attributes['class'] as string | undefined;
      const baseType = parseBaseType(tagName, classAttr);

      const classTokens = classAttr
        ? classAttr.trim().split(/\s+/).filter(Boolean)
        : undefined;

      // The range spans the tag's own source text, from its '<' to just past
      // its '>' — not sax's after-'>' position — so cursor positions
      // anywhere inside the tag's text (the common case of clicking a line
      // to locate it in the preview) resolve to this element, and a
      // self-closing element no longer records a zero-width range sitting
      // beyond its own end.
      const open = nextTag(tagName, false);
      const start = open ? locAt(open.start) : { line: parser.line, col: Math.max(0, parser.column - 1) };
      if (open?.selfClosing) {
        // sax fires onclosetag for self-closing tags too, immediately after
        // onopentag, with the parser position unmoved: consume that queue
        // entry here and let the close carry the range end below.
        selfClosingEnd = open ? locAt(open.end) : saxFallbackEnd();
      } else {
        selfClosingEnd = undefined;
      }

      const element: DitaNode = {
        type: 'element',
        tagName,
        classTokens,
        baseType,
        attributes: node.attributes as Record<string, string>,
        children: [],
        sourceRange: {
          startLine: start.line,
          startCol: start.col,
          endLine: 0,
          endCol: 0,
        },
      };

      const parent = stack[stack.length - 1];
      if (parent) {
        parent.children.push(element);
      }
      stack.push(element);
    };

    parser.onclosetag = () => {
      flushText();
      const element = stack.pop();
      if (element) {
        // Self-closing: onopentag already consumed the scan entry and stashed
        // the end. Real close tag: its '>' ends the element's range.
        let end: { line: number; col: number };
        if (selfClosingEnd) {
          end = selfClosingEnd;
          selfClosingEnd = undefined;
        } else {
          const close = nextTag(element.tagName || '', true);
          end = close && close.end >= 0 ? locAt(close.end) : saxFallbackEnd();
        }
        element.sourceRange.endLine = end.line;
        element.sourceRange.endCol = end.col;
      }
    };

    parser.ontext = (text: string) => {
      if (currentText.length === 0) {
        currentTextStartLine = parser.line;
        currentTextStartCol = parser.column;
      }
      currentText += text;
    };

    // CDATA sections fire a separate sax event (not ontext) — without this
    // handler, <![CDATA[...]]> content (common in codeblocks) is dropped.
    parser.oncdata = (text: string) => {
      if (currentText.length === 0) {
        currentTextStartLine = parser.line;
        currentTextStartCol = parser.column;
      }
      currentText += text;
    };

    parser.onerror = (err) => {
      throw new Error(`SAX parse error at line ${parser.line}:${parser.column}: ${err.message}`);
    };

    parser.write(xml).close();

    const docRoot = root.children.find(
      (c): c is DitaNode => c.type === 'element',
    );
    if (!docRoot) {
      throw new Error('No root element found in DITA document');
    }

    return {
      root: docRoot,
      sourceRange: docRoot.sourceRange,
    };
  };
}

/**
 * Common ISO/HTML character entities that DITA DTDs normally declare in
 * external subsets. The DOCTYPE (and with it those declarations) is
 * stripped before parsing, so map the frequent ones to literal characters
 * instead of silently deleting the text.
 */
const ISO_ENTITIES: Record<string, string> = {
  nbsp: '\u00a0', copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±',
  micro: 'µ', middot: '·', laquo: '«', raquo: '»', sect: '§', para: '¶',
  times: '×', divide: '÷', frac12: '½', frac14: '¼', frac34: '¾',
  sup1: '¹', sup2: '²', sup3: '³', cent: '¢', pound: '£', yen: '¥', euro: '€',
  ndash: '–', mdash: '—', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  hellip: '…', bull: '•', dagger: '†', Dagger: '‡', prime: '′', Prime: '″',
  larr: '←', uarr: '↑', rarr: '→', darr: '↓', harr: '↔',
};

const BUILTIN_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);

/** Nested-entity expansion cap; also what stops a self-referential declaration. */
const MAX_ENTITY_DEPTH = 8;

/** A CDATA section or comment (left verbatim) or a named entity reference. */
const CDATA_COMMENT_OR_ENTITY_REF = /(<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->)|&([a-zA-Z_][a-zA-Z0-9_.-]*);/g;

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/**
 * Preprocess XML to avoid SAX parse errors:
 * 1. Extract general entity declarations from the DOCTYPE (single- or
 *    double-quoted; parameter entities `<!ENTITY % ...>` are ignored)
 * 2. Strip the entire DOCTYPE declaration
 * 3. Replace entity references outside CDATA sections and comments:
 *    declared entities (first declaration wins; values may reference other
 *    entities, expanded up to MAX_ENTITY_DEPTH) take precedence over the
 *    ISO/HTML character tables; built-in XML entities are kept as-is
 * 4. Any reference that still can't be resolved (e.g. declared in an
 *    external DTD subset that is never loaded) is kept as the literal
 *    text "&name;" rather than deleted -- deleting it made the text vanish
 *    without a trace, and a bare reference would make SAX throw
 *
 * CDATA sections and comments are left exactly as written: inside them
 * "&nbsp;" is just characters (e.g. a codeblock showing HTML), not a reference.
 */
export function preprocessEntities(xml: string): string {
  // 1. Extract simple entity declarations: <!ENTITY name "value"> / 'value'.
  //    `[^\s%]` as the first name character rejects parameter entities
  //    (<!ENTITY % name ...>), which are not referenced as &name;.
  const entityRegex = /<!ENTITY\s+([^\s%]\S*)\s+(?:"([^"]*)"|'([^']*)')\s*>/g;
  const declared = new Map<string, string>();
  let match;
  while ((match = entityRegex.exec(xml)) !== null) {
    if (!declared.has(match[1])) declared.set(match[1], match[2] ?? match[3]);
  }

  // 2. Strip the entire DOCTYPE declaration
  const stripped = stripDoctype(xml);

  // 3./4. One pass over everything that is not a CDATA section or comment.
  //    Values are substituted via a callback so '$&'/'$$' sequences in an
  //    entity value stay literal, and names are looked up in a Map so ones
  //    containing regex metacharacters (e.g. '.') match exactly.
  const expand = (text: string, depth: number): string =>
    text.replace(CDATA_COMMENT_OR_ENTITY_REF, (full: string, verbatim: string | undefined, name: string) => {
      if (verbatim !== undefined) return full;
      if (BUILTIN_ENTITIES.has(name)) return full;
      const declaredValue = declared.get(name);
      if (declaredValue !== undefined) {
        // Declared values are markup and are inserted as written.
        return depth < MAX_ENTITY_DEPTH ? expand(declaredValue, depth + 1) : `&amp;${name};`;
      }
      const chars = ISO_ENTITIES[name] ?? lookupNamedEntity(name);
      // Table values are plain characters: escape the markup-significant
      // ones (e.g. the HTML5 aliases &AMP; and &LT;).
      if (chars !== undefined) return chars.replace(/[&<>]/g, (c) => XML_ESCAPES[c]);
      return `&amp;${name};`;
    });

  return expand(stripped, 0);
}

/** Strips the entire <!DOCTYPE ...> declaration, including internal subset [...]. */
function stripDoctype(xml: string): string {
  const start = xml.indexOf('<!DOCTYPE');
  if (start < 0) return xml;

  // Check for an internal subset marked by [ ... ]>
  const bracketStart = xml.indexOf('[', start);
  const firstGt = xml.indexOf('>', start);

  if (bracketStart >= 0 && (firstGt < 0 || bracketStart < firstGt)) {
    // Has internal subset — find the closing ]>
    const end = xml.indexOf(']>', bracketStart);
    if (end >= 0) {
      return xml.substring(0, start) + xml.substring(end + 2);
    }
  }
  // No internal subset — just strip up to and including the first >
  if (firstGt >= 0) {
    return xml.substring(0, start) + xml.substring(firstGt + 1);
  }
  return xml;
}

const _parseDita = makeParser(STANDARD_TAG_TO_BASETYPE);
const _parseDitamap = makeParser(MAP_STANDARD_TAG_TO_BASETYPE);

export function parseDita(xml: string): DitaDocument {
  return _parseDita(xml);
}

export function parseDitamap(xml: string): DitaDocument {
  return _parseDitamap(xml);
}
