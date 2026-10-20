import { DitaNode } from '../parser/domTypes';
import { RenderContext } from './renderer';

// parentBaseType only reflects the immediate ancestor (entry sits under row,
// not thead), so header status is carried by an explicit ctx flag set when
// entering thead/sthead and cleared when entering tbody.
function isInTableHeader(ctx: RenderContext): boolean {
  return ctx.inTableHeader === true;
}

export type Renderer = (
  node: DitaNode,
  context: RenderContext,
  renderChildren: (node: DitaNode, ctx: RenderContext) => string,
) => string;

function getAttr(node: DitaNode, name: string): string | undefined {
  return node.attributes?.[name];
}

// Mirrors DEFAULT_NOTE_LABELS in src/editor/ditaRenderUtils.ts. Duplicated
// rather than imported to keep this module free of editor-layer
// dependencies (it's also used by the HTML export pipeline); update both
// if the label set changes.
const FALLBACK_NOTE_LABELS: Record<string, string> = {
  note: 'Note', notice: 'Notice', warning: 'Warning', danger: 'Danger',
  important: 'Important', tip: 'Tip', restriction: 'Restriction',
  attention: 'Attention', caution: 'Caution', fastpath: 'Fastpath',
  remember: 'Remember', trouble: 'Trouble',
};

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// CALS colwidth proportional notation: "N*" (e.g. "3*"), a bare "*" (= 1*),
// or "N.*"/"N.5*" with a decimal. A trailing dot with nothing after it
// ("3.*") is strictly malformed CALS, but Oxygen (and most DITA-OT
// transforms) tolerate it and just treat it as "3*" -- so this parses it
// the same way rather than silently falling through to "no colwidth", which
// used to make every column of a table with even ONE such colspec collapse
// to unweighted 'auto' sizing.
function parseColwidthStar(w: string): number | undefined {
  const m = w.match(/^(\d+(?:\.\d*)?)?\*$/);
  if (!m) return undefined;
  return m[1] ? parseFloat(m[1]) : 1;
}

// Maps a CALS/DITA @align value to its direct CSS text-align equivalent.
// "char" (align relative to a specific character, e.g. lining up decimal
// points) has no simple CSS equivalent and is intentionally left
// unhandled -- falls back to whatever alignment the column/browser would
// otherwise use, rather than guessing at a character-alignment approximation.
function mapCalsAlign(value: string | undefined): string | undefined {
  return value === 'left' || value === 'right' || value === 'center' || value === 'justify' ? value : undefined;
}

// Recursively flattens an element's descendants to plain text, dropping all
// markup. Used for attribute-value contexts (alt/title) where HTML tags
// would just show up as literal escaped text if renderChildren() were used
// instead. Local to this module rather than imported from the editor/map
// layers' own copies of the same idea (extractTextFromNode/plainText) — see
// FALLBACK_NOTE_LABELS above for why src/render/ keeps its own copies.
function extractPlainText(node: DitaNode): string {
  if (node.type === 'text') return node.text || '';
  return (node.children || []).map(extractPlainText).join('');
}

// ── Index term extraction ──
//
// <indexterm> nesting encodes index levels: <indexterm>A<indexterm>B
// <indexterm>C</indexterm></indexterm></indexterm> is a three-level entry
// "A, B, C". Sibling nested indexterms under the same parent are separate
// entries sharing the same prefix, e.g. <indexterm>A<indexterm>B</indexterm>
// <indexterm>C</indexterm></indexterm> means "A, B" and "A, C". This walks
// that structure directly (not via the generic renderChildren dispatch --
// see the topic/indexterm renderer below) and produces one chip per leaf
// path, each with own text plus any index-see/index-see-also attached at
// that level.
export interface IndextermChip {
  /** Term levels from outermost to innermost, e.g. ['Database', 'backup']. */
  path: string[];
  /** Rendered "see: X" / "see also: X" annotations attached at this level. */
  seeAnnotations: string[];
}

function directTermText(node: DitaNode): string {
  return (node.children || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text || '')
    .join('')
    .trim();
}

/**
 * Exported for the full-book search index (docsite design doc, 4.4):
 * findTopLevelIndextermsInSubtree finds every independent indexterm tree in
 * a topic (body and prolog/keywords alike), and this turns each one into
 * its leaf-path chips -- the same two-step extraction the topic/indexterm
 * renderer below already does for on-page display.
 */
export function collectIndextermChips(node: DitaNode, ancestorPath: string[] = []): IndextermChip[] {
  const ownTerm = directTermText(node);
  const path = ownTerm ? [...ancestorPath, ownTerm] : ancestorPath;
  const children = node.children || [];
  const nestedTerms = children.filter((c) => c.type === 'element' && c.baseType === 'topic/indexterm');
  const seeNodes = children.filter(
    (c) => c.type === 'element' && (c.baseType === 'topic/index-see' || c.baseType === 'topic/index-see-also'),
  );

  const seeAnnotations = seeNodes
    .map((s) => {
      // index-see/index-see-also's own content is itself indexterm(s)
      // naming the target entry, not plain text -- reuse the same
      // extraction rather than a separate plain-text read so a
      // multi-level "see" target (rare but valid) still reads correctly.
      const targets = collectIndextermChips(s).map((c) => c.path.join(', '));
      const label = s.baseType === 'topic/index-see-also' ? 'see also' : 'see';
      return targets.length ? `${label}: ${targets.join('; ')}` : '';
    })
    .filter(Boolean);

  if (nestedTerms.length === 0) {
    return path.length > 0 ? [{ path, seeAnnotations }] : [];
  }

  const childChips = nestedTerms.flatMap((child) => collectIndextermChips(child, path));
  // A see-annotation attached at an intermediate level (this node has both
  // its own term text AND nested sub-entries) would otherwise be silently
  // dropped -- surface it as its own chip alongside the leaf chips rather
  // than losing it.
  if (seeAnnotations.length > 0 && path.length > 0) {
    return [{ path, seeAnnotations }, ...childChips];
  }
  return childChips;
}

/** Finds every topic/indexterm node in a subtree, but does NOT recurse
 *  into an indexterm's own children once found -- collectIndextermChips
 *  already walks that internal nesting (primary/secondary/... levels)
 *  itself, so recursing here too would double-collect the same entries.
 *  Used to pull indexterm chips out of <prolog><metadata><keywords>
 *  without also rendering the other, genuinely-private prolog content
 *  that happens to be a sibling of the keywords container. */
export function findTopLevelIndextermsInSubtree(node: DitaNode): DitaNode[] {
  const results: DitaNode[] = [];
  for (const child of node.children || []) {
    if (child.type !== 'element') continue;
    if (child.baseType === 'topic/indexterm') {
      results.push(child);
      continue;
    }
    results.push(...findTopLevelIndextermsInSubtree(child));
  }
  return results;
}

function renderIndextermChip(chip: IndextermChip, ctx: RenderContext): string {
  const pathText = chip.path.map(escapeAttr).join(' \u203A ');
  const seeText = chip.seeAnnotations.length
    ? ` <span class="indexterm-chip__see">(${chip.seeAnnotations.map(escapeAttr).join('; ')})</span>`
    : '';
  const label = ctx.indexLabel || 'Index';
  return `<span class="indexterm-chip" title="${escapeAttr(label)}: ${pathText}">\u{1F4D1} ${pathText}${seeText}</span>`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// topic/foreign covers DITA's generic <foreign> element plus the MathML
// domain's <mathml> (and this project's own 'svg-container' convenience
// mapping) — see standardTagMap.ts. Its content is arbitrary raw markup
// from OUTSIDE the DITA vocabulary, so unlike every other renderer here
// (which maps a *specific known* DITA element to a *specific known* HTML
// shape), this one has to decide what to do with tag names it can't
// otherwise account for. Chromium (what VS Code's webview runs on) has
// supported MathML Core natively since Chrome 109 (Jan 2023), so real
// MathML markup — which is what DITA-OT/Oxygen actually emit here, per
// https://www.oxygenxml.com/dita/1.3/specs/langRef/technicalContent/mathml.html
// — can simply be serialized back out verbatim and left to the browser's
// own MathML renderer, rather than DITA Viewer needing to implement math
// typesetting itself.
//
// "Verbatim" is deliberately bounded, though: this is the one place in the
// renderer that takes a tag name and attribute set straight from the
// source XML and writes it into the HTML output without mapping it to a
// controlled shape first. Restricting to a real MathML tag allowlist, and
// stripping event-handler-shaped/URL-bearing attribute names regardless of
// tag, keeps a malformed or hand-edited <mathml> block from doing anything
// beyond "render as MathML (or not at all)" — it can't smuggle through an
// arbitrary tag the browser would treat as active content.
const MATHML_TAGS = new Set([
  'math', 'mrow', 'mi', 'mn', 'mo', 'mtext', 'mspace', 'ms', 'mglyph',
  'mfrac', 'msqrt', 'mroot', 'mstyle', 'merror', 'mpadded', 'mphantom',
  'mfenced', 'menclose', 'msub', 'msup', 'msubsup', 'munder', 'mover',
  'munderover', 'mmultiscripts', 'mprescripts', 'none', 'mtable', 'mtr',
  'mtd', 'mlabeledtr', 'maligngroup', 'malignmark', 'mstack', 'mlongdiv',
  'msgroup', 'msrow', 'mscarries', 'mscarry', 'msline', 'maction',
  'semantics', 'annotation', 'annotation-xml',
]);

function isUnsafeForeignAttr(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith('on') || n === 'href' || n === 'src' || n === 'style' || n === 'xlink:href';
}

// Looks up a MathML attribute by its local (prefix-stripped) name -- the
// same tolerance serializeForeignContent's general attribute pass already
// applies, needed here too since <mfenced> (like everything else in this
// tree) may arrive as <m:mfenced separators="|" .../> with every attribute
// name unprefixed but the tag itself prefixed, or occasionally with a
// prefixed attribute as well.
function getForeignAttr(node: DitaNode, name: string): string | undefined {
  const attrs = node.attributes || {};
  if (attrs[name] !== undefined) return attrs[name];
  for (const [k, v] of Object.entries(attrs)) {
    if (localName(k) === name) return v;
  }
  return undefined;
}

// Namespace-prefixed MathML (<mml:math>, <mml:msup>, ...) is extremely
// common in practice -- Oxygen's equation editor and MathType both export
// this shape by default -- but only the *local* part of the name is a real
// MathML tag; "mml:msup" itself will never match MATHML_TAGS. Browsers also
// don't recognize prefixed tags for the HTML math-integration point at
// all, so the prefix has to come off both for the allowlist check and for
// what actually gets written into the output, or the element silently
// falls through to the "unrecognized tag" branch below (dropping structure
// exactly like the un-fixed flatten-to-text bug this renderer exists to
// avoid).
function localName(tag: string): string {
  const i = tag.indexOf(':');
  return i === -1 ? tag : tag.slice(i + 1);
}

// <mfenced> is real MathML 3, and it's how Oxygen/MathType export every
// parenthesized group and every |...| absolute-value bar -- but MathML
// Core (what Chromium, and therefore this webview and every "open in
// browser" WebHelp reader, actually implements) dropped it entirely.
// Passing it through verbatim renders as nothing: not "wrong brackets",
// the whole element and its fences silently disappear, which is exactly
// the "brackets and absolute values missing" symptom. The fix used by
// every engine that still wants mfenced to work under Core (MathJax
// included) is to expand it at serialization time into the primitives
// Core does support: an <mrow> with explicit <mo> fence/separator
// characters around the children, rather than relying on the browser to
// synthesize them from the mfenced attributes.
function expandMfenced(node: DitaNode): string {
  const openAttr = getForeignAttr(node, 'open');
  const closeAttr = getForeignAttr(node, 'close');
  const sepAttr = getForeignAttr(node, 'separators');
  // Per the MathML 3 spec, an absent attribute gets the default fence/
  // separator; an attribute present but explicitly empty (open="") means
  // "no fence on this side" (used for one-sided constructs) and must stay
  // empty rather than falling back to the default.
  const open = openAttr !== undefined ? openAttr : '(';
  const close = closeAttr !== undefined ? closeAttr : ')';
  const separators = sepAttr !== undefined ? sepAttr : ',';

  // Whitespace-only text nodes between tags (from source indentation/
  // newlines, which the sax parser preserves as real text-node children)
  // are not semantic arguments of mfenced -- only its element children
  // (or text nodes with actual visible content) count as "items" that
  // get fence/separator characters between them. Without this filter, a
  // single-child mfenced formatted across multiple lines would pick up
  // spurious extra separator characters for the whitespace "children"
  // surrounding the real one.
  const items = (node.children || [])
    .filter((c) => c.type !== 'text' || (c.text || '').trim() !== '')
    .map(serializeForeignContent);

  let inner = '';
  if (open !== '') inner += `<mo>${escapeHtml(open)}</mo>`;
  for (let i = 0; i < items.length; i++) {
    inner += items[i];
    if (i < items.length - 1 && separators !== '') {
      // Fewer separator characters than gaps: the last one repeats for
      // the rest, per spec. More than needed: the extras are unused.
      const sepChar = separators[Math.min(i, separators.length - 1)];
      inner += `<mo>${escapeHtml(sepChar)}</mo>`;
    }
  }
  if (close !== '') inner += `<mo>${escapeHtml(close)}</mo>`;

  return `<mrow>${inner}</mrow>`;
}

function serializeForeignContent(node: DitaNode): string {
  if (node.type === 'text') return escapeHtml(node.text || '');
  const tag = localName((node.tagName || '').toLowerCase());
  if (!MATHML_TAGS.has(tag)) {
    // Not a tag we recognize as real MathML — don't trust it enough to
    // emit as a live element, but keep any visible text rather than
    // silently dropping the whole subtree.
    return (node.children || []).map(serializeForeignContent).join('');
  }
  if (tag === 'mfenced') return expandMfenced(node);
  const attrs = Object.entries(node.attributes || {})
    // xmlns / xmlns:* declarations are what produced the mml: prefix in
    // the first place; now that the prefix is stripped from the tag name
    // itself they're meaningless (and on re-serialized <math> would just
    // be inert clutter), so drop them rather than carrying them through.
    .filter(([name]) => {
      const n = name.toLowerCase();
      return n !== 'xmlns' && !n.startsWith('xmlns:') && !isUnsafeForeignAttr(localName(n));
    })
    .map(([name, value]) => safeAttr(localName(name), value))
    .join('');
  const inner = (node.children || []).map(serializeForeignContent).join('');
  return `<${tag}${attrs}>${inner}</${tag}>`;
}


function safeAttr(name: string, value: string | undefined | null): string {
  if (value == null) return '';
  return ` ${name}="${escapeAttr(value)}"`;
}

// ── Utilities domain: image maps ─────────────────────────────────────────
// <imagemap> pairs one <image> with <area> hotspots, each declaring a
// region (<shape> + <coords>) and a destination (<xref>). The HTML
// translation is the native image-map construct the DITA element was
// designed around: the <img> carries usemap="#id", and a sibling
// <map name="id"> holds one <area shape coords href alt> per hotspot.
// Building that structure is what makes the region data clickable AND
// what keeps it off the page — the previous topic/fig + topic/figgroup
// mapping rendered the areas as visible "rect 0,0,10,10 Section 1"
// text lines with no click behavior at all.

// The <map> id needs to be unique per imagemap instance (two imagemaps
// in one rendered page would otherwise fight over the same map, and the
// browser only honors the first). A monotonic module-level counter keeps
// it deterministic and collision-free across a whole book render; it only
// needs uniqueness within one rendered document, which is also all it
// guarantees (re-renders restart the count, and separate documents never
// share a DOM).
let imagemapSequence = 0;

// Region geometry + destination for one <area>. Only shape/coords/xref
// are meaningful here (sort-as is authoring metadata for link-text
// generation and is deliberately not rendered); anything else the DTD
// allows is equally invisible in a hotspot.
function renderImageMapArea(area: DitaNode, ctx: RenderContext): string {
  const children = (area.children || []).filter(
    (c): c is DitaNode => c.type === 'element',
  );
  const shapeNode = children.find((c) => c.baseType === 'topic/shape');
  const coordsNode = children.find((c) => c.baseType === 'topic/coords');
  const xrefNode = children.find((c) => c.baseType === 'topic/xref');

  // HTML shape keywords are case-insensitive; normalize to the canonical
  // lowercase form so authoring style ("RECT", "Poly") doesn't leak into
  // the markup. Whitespace between numbers is tolerated by browsers'
  // coords parsing, so it's collapsed, not rejected.
  const shape = shapeNode ? extractPlainText(shapeNode).trim().toLowerCase() : '';
  const coords = coordsNode ? extractPlainText(coordsNode).trim().replace(/\s+/g, ' ') : '';

  const rawHref = xrefNode ? getAttr(xrefNode, 'href') || '' : '';

  // Three-way target resolution, mirroring topic/xref below so a hotspot
  // behaves like the same link would outside an imagemap:
  // same-page fragment -> real anchor; target inside the current
  // book/docsite -> data-dita-book-xref (the site/book click handlers
  // use closest(), which works on <area> like on any element);
  // everything else -> the raw href kept on the area. Unlike topic/xref,
  // which renders non-book targets as non-clickable hint spans, a
  // hotspot can't opt out of being a link (an <area> without a usable
  // href is a dead region, and clickable regions are the element's whole
  // purpose), so the raw href stays and the webviews' image-map click
  // guard (getImageMapSupportScript in ditaRenderUtils.ts) routes the
  // click to the host, which resolves it like the map tree's openTopic
  // handler does -- a bare relative href must never navigate the webview
  // itself, that navigation is the white page.
  let hrefAttr: string | undefined;
  let bookXref: string | undefined;
  if (rawHref) {
    if (rawHref.startsWith('#')) {
      hrefAttr = rawHref.includes('/') ? '#' + rawHref.split('/').pop()! : rawHref;
    } else {
      const bookTarget = ctx.isInCurrentBook?.(rawHref);
      if (bookTarget) {
        const hashIdx = rawHref.indexOf('#');
        const idPart = hashIdx >= 0 ? rawHref.slice(hashIdx + 1) : '';
        const anchorId = idPart ? (idPart.includes('/') ? idPart.split('/').pop()! : idPart) : '';
        bookXref = bookTarget + (anchorId ? '#' + anchorId : '');
        // Same href="#" placeholder topic/xref uses for book-internal
        // links: without an href the area isn't a link at all (no pointer
        // cursor, no click), and the site/book click handlers key off
        // data-dita-book-xref anyway.
        hrefAttr = '#';
      } else {
        hrefAttr = rawHref;
      }
    }
  }

  // Alternative text per the spec example: the <xref>'s own content is
  // the link's alternative text ("Section 1 alternative text"). An empty
  // xref (e.g. the spec's "pull title" comment case) falls back the same
  // way topic/xref falls back for its visible text: keyref resolution,
  // then the referenced document/element's title, then the raw href —
  // an <area> must never end up with NO text hint at all.
  let alt = xrefNode ? extractPlainText(xrefNode).trim() : '';
  if (!alt && xrefNode) {
    const keyref = getAttr(xrefNode, 'keyref');
    if (keyref) alt = ctx.resolveKey?.(keyref) || '';
  }
  if (!alt && rawHref) {
    const titleId = rawHref.startsWith('#')
      ? (rawHref.includes('/') ? rawHref.split('/').pop()! : rawHref.slice(1))
      : rawHref;
    alt = ctx.resolveTitle?.(titleId) || '';
  }
  if (!alt) alt = rawHref;

  // title= doubles the alt text as a hover tooltip — the one affordance
  // a hotspot has, since it renders no visible link text of its own.
  // injectAttributes (renderer.ts) sees this title= and skips its
  // generic tag-name tooltip for the element, as intended.
  return `<area${safeAttr('shape', shape || undefined)}${safeAttr('coords', coords || undefined)}${safeAttr('href', hrefAttr)}${safeAttr('alt', alt || undefined)}${safeAttr('title', alt || undefined)}${bookXref ? ` data-dita-book-xref="${escapeAttr(bookXref)}"` : ''}>`;
}

export const BASE_TYPE_RENDERERS: Record<string, Renderer> = {
  'topic/foreign': (node) => {
    // No renderChildren() here — that would fall through to the generic
    // "no handler for this baseType" path for every MathML tag underneath
    // (none of them have a DITA baseType of their own), stripping all
    // structure and leaving only flattened text. serializeForeignContent
    // recurses on its own, bypassing the normal per-node baseType dispatch
    // entirely for this subtree.
    const inner = (node.children || []).map(serializeForeignContent).join('');
    return `<span class="foreign-content">${inner}</span>`;
  },

  'topic/topic': (node, ctx, renderChildren) => {
    const id = getAttr(node, 'id');
    return `<article${safeAttr('id', id)} class="topic">${renderChildren(node, ctx)}</article>`;
  },

  'topic/title': (node, ctx, renderChildren) => {
    const level = Math.min(Math.max(ctx.headingLevel, 1), 6);
    // org.dita.html5 gives every title a `title` class plus a context marker:
    // `topictitle{N}` for a topic's own title, `sectiontitle` for a title that
    // heads a section/example. WebHelp template css keys on those, so add them
    // (plan §2.4: only add, never remove). Branch on the real parent -- the
    // overloaded ctx.parentBaseType would read back as 'topic/title' here.
    const owner = ctx.ownerBaseType;
    const titleClass =
      owner === 'topic/section' || owner === 'topic/example'
        ? 'title sectiontitle'
        : `title topictitle${level}`;
    return `<h${level} class="${titleClass}">${renderChildren(node, ctx)}</h${level}>`;
  },

  'topic/shortdesc': (node, ctx, renderChildren) => {
    return `<p class="shortdesc">${renderChildren(node, ctx)}</p>`;
  },

  'topic/body': (node, ctx, renderChildren) => {
    return `<main class="body">${renderChildren(node, ctx)}</main>`;
  },

  'topic/section': (node, ctx, renderChildren) => {
    const id = getAttr(node, 'id');
    return `<section${safeAttr('id', id)} class="section">${renderChildren(node, ctx)}</section>`;
  },

  'topic/example': (node, ctx, renderChildren) => {
    const id = getAttr(node, 'id');
    return `<section${safeAttr('id', id)} class="example">${renderChildren(node, ctx)}</section>`;
  },

  'topic/p': (_node, ctx, renderChildren) => {
    return `<p class="p">${renderChildren(_node, ctx)}</p>`;
  },

  'topic/itemgroup': (node, ctx, renderChildren) => {
    return `<div class="itemgroup">${renderChildren(node, ctx)}</div>`;
  },

  'topic/note': (node, ctx, renderChildren) => {
    const type = getAttr(node, 'type') || 'note';
    const spectitle = getAttr(node, 'spectitle');
    const othertype = getAttr(node, 'othertype');
    const labels = ctx.noteLabels || FALLBACK_NOTE_LABELS;
    // spectitle always wins when present (DITA lets any note override its
    // default title); otherwise type="other" falls back to @othertype
    // (its label isn't a fixed string, unlike the other 12 note types);
    // otherwise look up the type in the label map, or fall back to the
    // raw attribute value for anything outside the known enumeration.
    let label: string;
    if (spectitle) {
      label = spectitle;
    } else if (type === 'other' && othertype) {
      label = othertype;
    } else {
      label = labels[type] || type;
    }
    // Additive dual-classing (plan §2.2/§2.4): keep the own-mode `note--<type>`
    // and `note__label` the built-in templates style, and add the org.dita.html5
    // names WebHelp css expects -- the bare `{type}` token + `note_<type>` on the
    // wrapper, `note__title` on the label, and a `note__body` wrapper around the
    // content (the only structural addition, approved in the M2-8 audit).
    return `<div class="note note--${escapeAttr(type)} ${escapeAttr(type)} note_${escapeAttr(type)}"><span class="note__label note__title">${escapeAttr(label)}:</span> <div class="note__body">${renderChildren(node, ctx)}</div></div>`;
  },

  'topic/ul': (_node, ctx, renderChildren) => `<ul class="ul">${renderChildren(_node, ctx)}</ul>`,
  'topic/ol': (_node, ctx, renderChildren) => `<ol class="ol">${renderChildren(_node, ctx)}</ol>`,
  'topic/li': (_node, ctx, renderChildren) => `<li class="li">${renderChildren(_node, ctx)}</li>`,
  'topic/sl': (_node, ctx, renderChildren) => `<ul class="simple-list sl">${renderChildren(_node, ctx)}</ul>`,
  'topic/sli': (_node, ctx, renderChildren) => `<li class="li sli">${renderChildren(_node, ctx)}</li>`,

  'topic/dl': (_node, ctx, renderChildren) => `<dl class="dl">${renderChildren(_node, ctx)}</dl>`,
  'topic/dlentry': (_node, ctx, renderChildren) => `<div class="dlentry">${renderChildren(_node, ctx)}</div>`,
  'topic/dt': (_node, ctx, renderChildren) => `<dt class="dt dlterm">${renderChildren(_node, ctx)}</dt>`,
  'topic/dd': (_node, ctx, renderChildren) => `<dd class="dd">${renderChildren(_node, ctx)}</dd>`,

  'topic/table': (node, ctx, renderChildren) => {
    const id = getAttr(node, 'id');
    // If any tgroup declares colspecs, its <colgroup> gives every column an
    // authoritative width -- but the default 'auto' table layout treats
    // that width as only a hint: the browser still redistributes space
    // based on each cell's own content (a long-unbroken run of CJK text or
    // a single wide token can force its column wider than specified, at
    // the expense of others), which is why some tables render with columns
    // in roughly the proportions the author specified and others don't --
    // it depends on what that particular table's cell content happens to
    // do to the 'auto' algorithm's per-column min/max content width, not
    // on anything wrong with the colspec/colwidth parsing itself. Forcing
    // 'table-layout: fixed' (see styles.css's .cals-table--fixed-layout)
    // makes the colgroup widths authoritative instead of a mere hint. Only
    // applied when a colgroup actually exists -- tables with no colwidth
    // hints at all should keep sizing themselves from content as before.
    const hasColspec = (node.children || []).some(
      (tgroup) =>
        tgroup.type === 'element' &&
        tgroup.baseType === 'topic/tgroup' &&
        (tgroup.children || []).some(
          (c) => c.type === 'element' && c.baseType === 'topic/colspec' && !!c.attributes?.colwidth,
        ),
    );
    const cls = hasColspec ? 'table cals-table cals-table--fixed-layout' : 'table cals-table';
    return `<table${safeAttr('id', id)} class="${cls}">${renderChildren(node, ctx)}</table>`;
  },

  'topic/tgroup': (node, ctx, renderChildren) => {
    // Build column name → number map from colspec elements
    const colspecs = (node.children || []).filter(
      (c) => c.type === 'element' && c.baseType === 'topic/colspec',
    );
    const colMap = new Map<string, number>();
    colspecs.forEach((cs, i) => {
      const colname = cs.attributes?.colname;
      if (colname) {
        const colnum = cs.attributes?.colnum
          ? parseInt(cs.attributes.colnum, 10)
          : i + 1;
        colMap.set(colname, colnum);
      }
    });

    // Table-wide default alignment (CALS @align on <tgroup>), overridden
    // per-column by @align on that column's own <colspec>. Resolved once,
    // up front, into an array indexed by colnum - 1, and applied per-cell
    // below (an entry's own @align, when present, wins over this — see the
    // cursor-tracking pass right below). NOTE: CSS explicitly restricts
    // <col>/<colgroup> to only 'width', 'border', 'background' and
    // 'visibility' — a <col style="text-align:...">, which an earlier
    // version of this fix tried, is simply ignored by every browser, so
    // this has to be threaded onto each individual <td>/<th> instead.
    const tgroupAlign = mapCalsAlign(getAttr(node, 'align'));
    const colAlignByIndex: (string | undefined)[] = colspecs.map(
      (cs) => mapCalsAlign(cs.attributes?.align) || tgroupAlign,
    );

    // Pre-process entries: add colspan/rowspan attributes derived from
    // CALS namest/nameend and morerows so the entry renderer can emit
    // them as standard HTML attributes, and (when the entry has no @align
    // of its own) fill in the alignment its column resolves to above, so
    // the 'topic/entry' renderer's "own @align wins" check picks it up as
    // if the source had declared it explicitly. Column position is
    // tracked per row via a left-to-right cursor that advances by each
    // entry's colspan -- this doesn't account for columns already
    // occupied by an earlier row's @morerows/rowspan (CALS technically
    // requires a full row/column occupancy grid for that), matching the
    // same scope the existing colspan derivation below already had.
    function addSpans(el: DitaNode): DitaNode {
      if (el.type !== 'element') return el;

      if (el.baseType === 'topic/row') {
        let cursor = 1;
        const children = (el.children || []).map((child) => {
          const processed = addSpans(child);
          if (processed.type !== 'element' || processed.baseType !== 'topic/entry') {
            return processed;
          }
          const attrs = { ...processed.attributes };
          const colStart = attrs.namest && colMap.has(attrs.namest) ? colMap.get(attrs.namest)! : cursor;
          const span = attrs.colspan ? parseInt(attrs.colspan, 10) : 1;
          if (!attrs.align) {
            const resolved = colAlignByIndex[colStart - 1];
            if (resolved) attrs.align = resolved;
          }
          cursor = colStart + (isNaN(span) || span < 1 ? 1 : span);
          return { ...processed, attributes: attrs };
        });
        return { ...el, children };
      }

      const processedChildren = (el.children || []).map(addSpans);
      if (el.baseType === 'topic/entry') {
        const attrs = { ...el.attributes };
        const { namest, nameend } = attrs;
        if (namest && nameend && !attrs.colspan) {
          const startCol = colMap.get(namest);
          const endCol = colMap.get(nameend);
          if (startCol !== undefined && endCol !== undefined) {
            attrs.colspan = String(endCol - startCol + 1);
          }
        }
        if (attrs.morerows !== undefined && !attrs.rowspan) {
          const mr = parseInt(attrs.morerows, 10);
          if (!isNaN(mr)) attrs.rowspan = String(mr + 1);
        }
        return { ...el, attributes: attrs, children: processedChildren };
      }
      return { ...el, children: processedChildren };
    }

    const processedNode = addSpans(node);

    // Generate <colgroup> with column widths.
    // CALS colwidth can be: "5*" or "1.5*" (proportional), "*" (= 1*),
    // "50px", "30%", "2in", or a bare number (treated as pixels). Column
    // alignment is handled per-cell above (in addSpans), not here -- CSS
    // restricts <col> to only 'width', 'border', 'background', and
    // 'visibility', so a <col style="text-align:...">, tried in an earlier
    // version of this fix, is simply ignored by every browser.
    let colgroup = '';
    if (colspecs.length > 0) {
      // Calculate total proportional parts for "*" notation
      let totalStars = 0;
      let hasStars = false;
      for (const cs of colspecs) {
        const w = cs.attributes?.colwidth;
        const stars = w ? parseColwidthStar(w) : undefined;
        if (stars !== undefined) {
          hasStars = true;
          totalStars += stars;
        }
      }
      const cols = colspecs
        .map((cs) => {
          const w = cs.attributes?.colwidth;
          if (!w) return '<col>';
          // Convert CALS proportional notation (N*) to percentage
          const stars = parseColwidthStar(w);
          if (stars !== undefined && hasStars && totalStars > 0) {
            return `<col style="width: ${((stars / totalStars) * 100).toFixed(2)}%">`;
          }
          // Bare number → treat as pixels
          if (/^\d+(?:\.\d+)?$/.test(w)) {
            return `<col style="width: ${escapeAttr(w)}px">`;
          }
          // Pass through CSS-compatible values (px, %, em, in, cm, etc.)
          return `<col style="width: ${escapeAttr(w)}">`;
        })
        .join('');
      colgroup = `<colgroup>${cols}</colgroup>`;
    }

    // Render non-colspec children (thead, tbody, tfoot)
    const childCtx: RenderContext = { ...ctx, parentBaseType: 'topic/tgroup' };
    const nodeWithoutColspec: DitaNode = {
      ...processedNode,
      children: (processedNode.children || []).filter(
        (c) => !(c.type === 'element' && c.baseType === 'topic/colspec'),
      ),
    };
    return colgroup + renderChildren(nodeWithoutColspec, childCtx);
  },
  'topic/colspec': () => '',

  'topic/thead': (_node, ctx, renderChildren) =>
    `<thead class="thead">${renderChildren(_node, { ...ctx, inTableHeader: true })}</thead>`,
  'topic/tbody': (_node, ctx, renderChildren) =>
    `<tbody class="tbody">${renderChildren(_node, { ...ctx, inTableHeader: false })}</tbody>`,
  'topic/row': (_node, ctx, renderChildren) => `<tr class="row">${renderChildren(_node, ctx)}</tr>`,
  'topic/entry': (node, ctx, renderChildren) => {
    const tag = isInTableHeader(ctx) ? 'th' : 'td';
    const colspan = getAttr(node, 'colspan');
    const rowspan = getAttr(node, 'rowspan');
    // Overrides the column's own alignment (set via <colspec>/<tgroup>
    // @align, see 'topic/tgroup' above) for just this cell, same as CALS
    // precedence: entry > colspec > tgroup.
    const align = mapCalsAlign(getAttr(node, 'align'));
    const attrs = ` class="entry"${safeAttr('colspan', colspan)}${safeAttr('rowspan', rowspan)}${align ? ` style="text-align: ${align}"` : ''}`;
    return `<${tag}${attrs}>${renderChildren(node, ctx)}</${tag}>`;
  },

  'topic/simpletable': (node, ctx, renderChildren) => {
    const id = getAttr(node, 'id');
    return `<table${safeAttr('id', id)} class="simple-table simpletable">${renderChildren(node, ctx)}</table>`;
  },

  'topic/sthead': (_node, ctx, renderChildren) =>
    `<thead class="sthead">${renderChildren(_node, { ...ctx, inTableHeader: true })}</thead>`,
  'topic/strow': (_node, ctx, renderChildren) =>
    `<tr class="strow">${renderChildren(_node, { ...ctx, inTableHeader: false })}</tr>`,
  'topic/stentry': (node, ctx, renderChildren) => {
    const tag = isInTableHeader(ctx) ? 'th' : 'td';
    return `<${tag} class="stentry">${renderChildren(node, ctx)}</${tag}>`;
  },

  'topic/image': (node, ctx) => {
    const href = getAttr(node, 'href') || '';
    const placement = getAttr(node, 'placement') || 'inline';
    let width = getAttr(node, 'width');
    let height = getAttr(node, 'height');
    const scale = getAttr(node, 'scale');
    const scalefit = getAttr(node, 'scalefit');
    // Captured before the natural-dimensions fallback below overwrites
    // width/height for aspect-ratio reservation, so the @scale gate further
    // down can still tell "the author actually gave a size" apart from "we
    // filled one in ourselves" — see the bug this fixes at that gate.
    const hadAuthorSize = !!(width || height);

    // Author-specified @width/@height on the <image> element always wins;
    // only fall back to the file's own natural dimensions (read from disk,
    // not decoded from the loaded image — see readImageDimensions) when
    // neither is given, purely to reserve the right aspect-ratio box
    // before the browser has actually loaded the image (this project's
    // own img{height:auto} means a bare width/height attribute doesn't
    // force a fixed pixel size, it just informs the aspect ratio while
    // max-width:100% still scales the box down responsively as usual).
    if (!width && !height && href && ctx.getImageDimensions) {
      const natural = ctx.getImageDimensions(href);
      if (natural) {
        width = String(natural.width);
        height = String(natural.height);
      }
    }

    // DITA allows alt text as both the @alt attribute and a richer <alt>
    // child element (topic/alt) — the child can carry formatted content
    // (ph, draft-comment, etc.) and takes precedence when present. Neither
    // present -> alt stays undefined so safeAttr omits the attribute
    // entirely, rather than always emitting alt="" regardless of whether
    // the author gave any alt info at all.
    const altChild = (node.children || []).find(
      (c) => c.type === 'element' && c.baseType === 'topic/alt',
    );
    const altFromChild = altChild ? extractPlainText(altChild).trim() : '';
    const alt = altFromChild || getAttr(node, 'alt');

    const extra = `${safeAttr('width', width)}${safeAttr('height', height)}`;
    const imgSrc = href ? ctx.asWebviewUri(href) : '';
    const cls = placement === 'break' ? ' class="image image-break"' : ' class="image"';

    // @scale sizes the image relative to its OWN natural dimensions, not
    // the container — expressed via the CSS custom property --dita-scale,
    // which styles.css combines with the toolbar's preview-only zoom via
    // the CSS 'zoom' property (reflows the box, unlike transform:scale).
    // Explicit width/height are a more specific instruction and win over
    // scale when given. @scalefit="yes" means "prioritize fitting the
    // available width", which this project already does by default for
    // every image (img{max-width:100%}); so scalefit=yes just needs to
    // suppress scale/width/height rather than actively doing anything.
    let scaleStyle: string | undefined;
    if (scalefit !== 'yes' && scale && !hadAuthorSize) {
      const pct = parseFloat(scale);
      if (!isNaN(pct) && pct > 0) {
        scaleStyle = `--dita-scale:${pct / 100}`;
      }
    }

    // Preview-default downscale flag: for an image with no @scale/@width/
    // @height of its own, the preview should start smaller than full size
    // -- but @scale's zoom-relative-to-natural-size mechanism above is the
    // wrong tool for this, because zoom only shrinks what's already fitting
    // under the container's max-width:100% clamp. A large image already
    // being clamped down to the container's width stays clamped to that
    // same width after a zoom<1 is applied (natural-size * zoom can still
    // exceed the container), so "shrink by X%" would visibly do nothing
    // for exactly the images most in need of shrinking. The actual pixel
    // width of that clamped box is only known in the browser, at layout
    // time -- see the webview script's use of this attribute, which reads
    // getBoundingClientRect() (the same measurement the zoom toolbar's
    // "100%" already means) and applies the reduction from there instead.
    const useDefaultPreviewScale = scalefit !== 'yes' && !scale && !hadAuthorSize;

    const altAttr = alt !== undefined ? safeAttr('alt', alt) : '';
    const titleAttr = alt ? safeAttr('title', alt) : '';
    const styleAttr = safeAttr('style', scaleStyle);
    const defaultScaleAttr = useDefaultPreviewScale ? ' data-dita-default-scale="1"' : '';

    return `<img src="${escapeAttr(imgSrc)}"${altAttr}${titleAttr}${extra}${cls}${styleAttr}${defaultScaleAttr} loading="lazy" data-dita-src="${escapeAttr(href)}">`;
  },

  'topic/fig': (node, ctx, renderChildren) => {
    const id = getAttr(node, 'id');
    const titleNode = (node.children || []).find(
      (c) => c.type === 'element' && c.baseType === 'topic/title',
    );
    const rest = (node.children || []).filter(
      (c) => !(c.type === 'element' && c.baseType === 'topic/title'),
    );
    const figContent = renderChildren({ ...node, children: rest }, ctx);
    const figCaption = titleNode
      ? `<figcaption>${renderChildren(titleNode, { ...ctx, headingLevel: ctx.headingLevel + 1 })}</figcaption>`
      : '';
    return `<figure${safeAttr('id', id)} class="fig">${figContent}${figCaption}</figure>`;
  },

  // ── Utilities domain: image maps ── renderers below; the shared helpers
  // (imagemapSequence + renderImageMapArea) live just above this object.

  'topic/imagemap': (node, ctx, renderChildren) => {
    const id = getAttr(node, 'id');
    const children = (node.children || []).filter((c): c is DitaNode => c.type === 'element');
    const titleNode = children.find((c) => c.baseType === 'topic/title');
    const imageNode = children.find((c) => c.baseType === 'topic/image');
    const areaNodes = children.filter((c) => c.baseType === 'topic/area');

    imagemapSequence += 1;
    const mapId = `dita-imagemap-${imagemapSequence}`;

    // The hotspot image reuses the full topic/image renderer — webview URI
    // resolution, natural-dimension reservation, @width/@height/@scale,
    // <alt> handling — then gains the usemap binding. The renderer's
    // data-dita-default-scale marker is stripped for imagemap images: that
    // marker triggers the webview's cosmetic "start smaller" shrink, and a
    // shrunken image would leave every <area> hit region misaligned with
    // the pixels underneath (browsers don't rescale map coordinates for
    // CSS-resized images). Keeping the image at its natural/author size is
    // what keeps the coordinates honest; the zoom toolbar remains
    // available for deliberate inspection.
    let imgHtml = '';
    if (imageNode) {
      imgHtml = BASE_TYPE_RENDERERS['topic/image'](imageNode, ctx, renderChildren);
      imgHtml = imgHtml.replace(/^<img/, `<img usemap="#${escapeAttr(mapId)}"`);
      imgHtml = imgHtml.replace(/ data-dita-default-scale="1"/g, '');
    }

    const mapHtml = `<map${safeAttr('name', mapId)}${safeAttr('id', mapId)}>${areaNodes.map((a) => renderImageMapArea(a, ctx)).join('')}</map>`;

    const figCaption = titleNode
      ? `<figcaption>${renderChildren(titleNode, { ...ctx, headingLevel: ctx.headingLevel + 1 })}</figcaption>`
      : '';
    return `<figure${safeAttr('id', id)} class="fig imagemap">${imgHtml}${mapHtml}${figCaption}</figure>`;
  },

  // Standalone <area> (not inside an <imagemap>) has no image to attach
  // its region to — any output would be an invisible no-op element or a
  // stray link, so render nothing, same convention as the index-see family
  // of parent-consumed elements. Valid markup never reaches here: the
  // imagemap renderer above walks its own area children directly.
  'topic/area': () => '',
  // shape/coords text is region data consumed by renderImageMapArea above;
  // visited standalone they can only be malformed markup, and echoing
  // "rect" / "0,0,10,10" into the page is exactly the bug this renderer
  // pair exists to fix.
  'topic/shape': () => '',
  'topic/coords': () => '',

  'topic/codeblock': (node, ctx, renderChildren) => {
    const outputClass = getAttr(node, 'outputclass') || '';
    const lang = outputClass.replace(/^language-/, '');
    const pre = `<pre class="pre codeblock ${escapeAttr(outputClass)}"><code>${renderChildren(node, ctx)}</code></pre>`;
    if (!lang) return pre;
    // The label used to live *inside* <pre>, which has overflow-x:auto for
    // wide code -- an absolutely-positioned child of a scrolling element
    // scrolls along with that element's content, so the label drifted off
    // to the left as soon as the user scrolled the code horizontally
    // instead of staying pinned to the corner. Moving it to a sibling of
    // <pre>, wrapped in a non-scrolling container, keeps it fixed in place;
    // .codeblock-wrap in styles.css supplies the positioning context.
    const langLabel = `<div class="codeblock-lang">${escapeAttr(lang)}</div>`;
    return `<div class="codeblock-wrap">${pre}${langLabel}</div>`;
  },

  'topic/pre': (_node, ctx, renderChildren) =>
    `<pre class="pre preformatted">${renderChildren(_node, ctx)}</pre>`,

  'topic/xref': (node, ctx, renderChildren) => {
    const href = getAttr(node, 'href') || '';
    if (!href) return '';

    let content: string;
    if (node.children.length > 0) {
      content = renderChildren(node, ctx);
    } else if (href.startsWith('#')) {
      const id = href.includes('/') ? href.split('/').pop()! : href.slice(1);
      content = escapeAttr(ctx.resolveTitle?.(id) ?? '') || escapeAttr(href);
    } else {
      // Cross-file reference (with or without fragment):
      // try to resolve the referenced document's title
      content = escapeAttr(ctx.resolveTitle?.(href) ?? '') || escapeAttr(href);
    }

    if (href.startsWith('#')) {
      const anchor = href.includes('/') ? '#' + href.split('/').pop()! : href;
      return `<a href="${escapeAttr(anchor)}" class="xref">${content}</a>`;
    }

    // Cross-file: when the target topic is part of the book/docsite this
    // topic is itself being rendered as part of, isInCurrentBook resolves
    // it to an absolute path and this becomes a real, clickable link
    // instead of the plain hint text below -- the webview's click handler
    // reads data-dita-book-xref to ask the extension host to switch pages
    // (see getSiteNavClickHandlerScript in ditaRenderUtils.ts). The
    // anchor id reuses the same "last path segment" convention the
    // same-page branch above already uses, so a nested
    // "topicId/elementId" fragment still resolves to the specific element
    // to scroll to, not just the topic root.
    const bookTarget = ctx.isInCurrentBook?.(href);
    if (bookTarget) {
      const hashIdx = href.indexOf('#');
      const idPart = hashIdx >= 0 ? href.slice(hashIdx + 1) : '';
      const anchorId = idPart ? (idPart.includes('/') ? idPart.split('/').pop()! : idPart) : '';
      const target = bookTarget + (anchorId ? '#' + anchorId : '');
      return `<a href="#" class="xref" data-dita-book-xref="${escapeAttr(target)}">${content}</a>`;
    }

    return `<span class="xref-external">→ ${content}</span>`;
  },

  'topic/link': (node, ctx, renderChildren) => {
    const href = getAttr(node, 'href');
    const keyref = getAttr(node, 'keyref');
    const target = href || keyref || '';
    if (!target) return renderChildren(node, ctx);
    return `<a href="${escapeAttr(target)}" class="link">${renderChildren(node, ctx)}</a>`;
  },
  'topic/linktext': (_node, ctx, renderChildren) => renderChildren(_node, ctx),

  'topic/related-links': (_node, ctx, renderChildren) =>
    `<aside class="related-links"><h2>Related links</h2>${renderChildren(_node, ctx)}</aside>`,

  'topic/b': (_node, ctx, renderChildren) => `<strong class="ph b">${renderChildren(_node, ctx)}</strong>`,
  'topic/i': (_node, ctx, renderChildren) => `<em class="ph i">${renderChildren(_node, ctx)}</em>`,
  'topic/u': (_node, ctx, renderChildren) => `<u class="ph u">${renderChildren(_node, ctx)}</u>`,
  'topic/tt': (_node, ctx, renderChildren) => `<code class="ph tt">${renderChildren(_node, ctx)}</code>`,
  'topic/sup': (_node, ctx, renderChildren) => `<sup class="ph sup">${renderChildren(_node, ctx)}</sup>`,
  'topic/sub': (_node, ctx, renderChildren) => `<sub class="ph sub">${renderChildren(_node, ctx)}</sub>`,

  // Highlight domain additions (specialize topic/ph; given element-specific
  // baseTypes + renderers so the visual styling survives even when the class
  // attribute is omitted from the XML — same approach as b/i/u above).
  // line-through maps to the semantic <s> element (zero CSS, like b→<strong>);
  // overline has no semantic HTML element, so it uses a .overline CSS class
  // (defined in styles.css) instead of an inline style so themes can override it.
  // Both are hi-d specialisations of ph, so (like b/i/u/tt/sup/sub) they carry the
  // html5 `ph` token. overline is the one hi-d member rendered as a <span>, so
  // styles.css excludes it from the span.ph dimming rule with :not(.overline).
  'topic/line-through': (_node, ctx, renderChildren) =>
    `<s class="ph line-through">${renderChildren(_node, ctx)}</s>`,
  'topic/overline': (_node, ctx, renderChildren) =>
    `<span class="ph overline">${renderChildren(_node, ctx)}</span>`,

  'topic/q': (_node, ctx, renderChildren) => `<q class="q">${renderChildren(_node, ctx)}</q>`,
  'topic/lq': (_node, ctx, renderChildren) => `<blockquote class="lq">${renderChildren(_node, ctx)}</blockquote>`,

  'topic/keyword': (_node, ctx, renderChildren) =>
    `<span class="keyword">${renderChildren(_node, ctx)}</span>`,

  'topic/term': (_node, ctx, renderChildren) =>
    `<span class="term">${renderChildren(_node, ctx)}</span>`,

  'topic/ph': (node, ctx, renderChildren) => {
    const keyref = getAttr(node, 'keyref');
    const hasContent = (node.children || []).some(
      (c) => c.type === 'element' || (c.text || '').trim() !== '',
    );
    // Content wins over keyref (DITA spec). An empty ph with a resolvable
    // keyref is substituted upstream; reaching here empty means unresolved.
    if (keyref && !hasContent && ctx.resolveKey) {
      const resolved = ctx.resolveKey(keyref);
      if (resolved) return `<span class="ph">${escapeAttr(resolved)}</span>`;
      return `<span class="ph unresolved-keyref" title="Unresolved key: ${escapeAttr(keyref)}">[${escapeAttr(keyref)}]</span>`;
    }
    return `<span class="ph">${renderChildren(node, ctx)}</span>`;
  },

  // UI elements
  'topic/uicontrol': (_node, ctx, renderChildren) =>
    `<span class="uicontrol">${renderChildren(_node, ctx)}</span>`,

  'topic/wintitle': (_node, ctx, renderChildren) =>
    `<span class="wintitle">${renderChildren(_node, ctx)}</span>`,

  'topic/menucascade': (_node, ctx, renderChildren) =>
    `<span class="menucascade">${renderChildren(_node, ctx)}</span>`,

  // Computer interaction
  'topic/filepath': (_node, ctx, renderChildren) =>
    `<span class="filepath">${renderChildren(_node, ctx)}</span>`,

  'topic/userinput': (_node, ctx, renderChildren) =>
    `<span class="userinput">${renderChildren(_node, ctx)}</span>`,

  'topic/systemoutput': (_node, ctx, renderChildren) =>
    `<span class="systemoutput">${renderChildren(_node, ctx)}</span>`,

  // API & code references
  'topic/apiname': (_node, ctx, renderChildren) =>
    `<span class="apiname">${renderChildren(_node, ctx)}</span>`,

  'topic/option': (_node, ctx, renderChildren) =>
    `<span class="option">${renderChildren(_node, ctx)}</span>`,

  'topic/parmname': (_node, ctx, renderChildren) =>
    `<span class="parmname">${renderChildren(_node, ctx)}</span>`,

  'topic/cmdname': (_node, ctx, renderChildren) =>
    `<span class="cmdname">${renderChildren(_node, ctx)}</span>`,

  'topic/varname': (_node, ctx, renderChildren) =>
    `<span class="varname">${renderChildren(_node, ctx)}</span>`,

  'topic/msgnum': (_node, ctx, renderChildren) =>
    `<span class="msgnum">${renderChildren(_node, ctx)}</span>`,

  // Programming domain additions
  'topic/codeph': (_node, ctx, renderChildren) =>
    `<code class="codeph">${renderChildren(_node, ctx)}</code>`,
  'topic/coderef': (_node, ctx, renderChildren) =>
    `<span class="coderef">${renderChildren(_node, ctx)}</span>`,
  'topic/synph': (_node, ctx, renderChildren) =>
    `<span class="synph">${renderChildren(_node, ctx)}</span>`,
  'topic/kwd': (_node, ctx, renderChildren) =>
    `<span class="kwd">${renderChildren(_node, ctx)}</span>`,
  'topic/var': (_node, ctx, renderChildren) =>
    `<span class="var">${renderChildren(_node, ctx)}</span>`,
  'topic/oper': (_node, ctx, renderChildren) =>
    `<span class="oper">${renderChildren(_node, ctx)}</span>`,
  'topic/sep': (_node, ctx, renderChildren) =>
    `<span class="sep">${renderChildren(_node, ctx)}</span>`,
  'topic/delim': (_node, ctx, renderChildren) =>
    `<span class="delim">${renderChildren(_node, ctx)}</span>`,
  'topic/fragment': (_node, ctx, renderChildren) =>
    `<span class="fragment">${renderChildren(_node, ctx)}</span>`,
  'topic/fragref': (_node, ctx, renderChildren) =>
    `<span class="fragref">${renderChildren(_node, ctx)}</span>`,
  // synblk specialises figgroup (not pre): class is `figgroup synblk`. The <pre>
  // element stays so the syntax text keeps its whitespace.
  'topic/synblk': (_node, ctx, renderChildren) =>
    `<pre class="figgroup synblk">${renderChildren(_node, ctx)}</pre>`,
  'topic/synnote': (_node, ctx, renderChildren) =>
    `<div class="synnote">${renderChildren(_node, ctx)}</div>`,
  'topic/synnoteref': (_node, ctx, renderChildren) =>
    `<span class="synnoteref">${renderChildren(_node, ctx)}</span>`,
  'topic/syntaxdiagram': (_node, ctx, renderChildren) =>
    `<div class="syntaxdiagram">${renderChildren(_node, ctx)}</div>`,

  // Software domain
  'topic/screen': (_node, ctx, renderChildren) =>
    `<pre class="pre screen">${renderChildren(_node, ctx)}</pre>`,
  'topic/msgph': (_node, ctx, renderChildren) =>
    `<span class="msgph">${renderChildren(_node, ctx)}</span>`,
  'topic/msgblock': (_node, ctx, renderChildren) =>
    `<pre class="pre msgblock">${renderChildren(_node, ctx)}</pre>`,

  // Common body elements
  'topic/lines': (_node, ctx, renderChildren) =>
    `<pre class="pre lines">${renderChildren(_node, ctx)}</pre>`,
  'topic/fn': (node, ctx, renderChildren) => {
    const id = getAttr(node, 'id');
    const cls = id ? ` fn-call-${escapeAttr(id)}` : '';
    return `<sup class="fn${cls}">${renderChildren(node, ctx)}</sup>`;
  },
  'topic/cite': (_node, ctx, renderChildren) =>
    `<cite class="cite">${renderChildren(_node, ctx)}</cite>`,
  'topic/boolean': (node, ctx, renderChildren) => {
    const val = getAttr(node, 'value') || '';
    return `<span class="boolean" data-value="${escapeAttr(val)}">${escapeAttr(val) || renderChildren(node, ctx)}</span>`;
  },
  'topic/tm': (_node, ctx, renderChildren) =>
    `<span class="tm">${renderChildren(_node, ctx)}</span>`,
  // Index terms carried no visual representation at all before this --
  // <indexterm> rendered to '', so authored index entries were invisible
  // in preview even though they're routinely used to check placement and
  // wording while writing. This renders each indexterm as a small inline
  // chip showing its full term path (indexterm nesting encodes
  // primary/secondary/tertiary levels: <indexterm>A<indexterm>B</indexterm>
  // </indexterm> means "A, B" as a two-level entry), plus any index-see/
  // index-see-also cross-reference. Deliberately NOT a compiled, sorted
  // index page the way a printed book's back-of-book index works --
  // sorting only makes sense for scripts with a stable alphabetic/stroke
  // order, and silently doing nothing useful (or something arbitrary) for
  // e.g. Chinese content would be worse than not having a generated index
  // at all. Showing the term(s) inline, right where they're authored, is
  // useful in every language and needs no sort-order decision.
  'topic/indexterm': (node, ctx) =>
    ctx.suppressIndexterm ? '' : collectIndextermChips(node).map((chip) => renderIndextermChip(chip, ctx)).join(''),
  'topic/indextermref': (node) => {
    const key = getAttr(node, 'keyref');
    return key ? `<span class="indexterm-chip indexterm-chip--ref" title="indextermref">\u{1F4D1} ${escapeAttr(key)}</span>` : '';
  },
  // index-see / index-see-also / index-sort-as are only ever meaningful as
  // children consumed directly by their parent topic/indexterm's own
  // renderer above (collectIndextermChips walks node.children itself
  // rather than going through the generic renderChildren dispatch for
  // these) -- if one of these somehow gets visited on its own (malformed
  // markup with the referencing indexterm parent missing, or ctx.uiLanguage
  // paths hitting some node.children traversal outside indexterm's own
  // renderer), rendering empty is right: there is no sensible standalone
  // presentation for "the target of a see-reference" with no surrounding
  // indexterm chip to attach it to.
  'topic/index-see': () => '',
  'topic/index-see-also': () => '',
  'topic/index-sort-as': () => '',
  'topic/index-base': () => '',
  'topic/div': (_node, ctx, renderChildren) =>
    `<div class="body-div div">${renderChildren(_node, ctx)}</div>`,
  'topic/sectiondiv': (_node, ctx, renderChildren) =>
    `<div class="section-div sectiondiv">${renderChildren(_node, ctx)}</div>`,
  'topic/bodydiv': (_node, ctx, renderChildren) =>
    `<div class="body-div bodydiv">${renderChildren(_node, ctx)}</div>`,
  // Generic grouping container (programming domain
  // groupchoice/groupcomp/groupseq alternatives). Same block treatment as
  // bodydiv/sectiondiv — no distinct visual semantics of its own.
  // (Image-map <area> groups no longer land here — see topic/imagemap
  // above, which builds the real <map>/<area> structure.)
  'topic/figgroup': (_node, ctx, renderChildren) =>
    `<div class="figgroup">${renderChildren(_node, ctx)}</div>`,
  'topic/desc': (_node, ctx, renderChildren) =>
    `<span class="desc">${renderChildren(_node, ctx)}</span>`,
  'topic/alt': (_node, ctx, renderChildren) =>
    `<span class="alt">${renderChildren(_node, ctx)}</span>`,

  // Parameter lists
  'topic/parml': (_node, ctx, renderChildren) =>
    `<dl class="parml">${renderChildren(_node, ctx)}</dl>`,
  'topic/plentry': (_node, ctx, renderChildren) =>
    `<div class="plentry">${renderChildren(_node, ctx)}</div>`,
  'topic/pt': (_node, ctx, renderChildren) =>
    `<dt class="pt">${renderChildren(_node, ctx)}</dt>`,
  'topic/pd': (_node, ctx, renderChildren) =>
    `<dd class="pd">${renderChildren(_node, ctx)}</dd>`,

  // Abbreviation & glossary
  'topic/abbreviated-form': (node, ctx, renderChildren) => {
    const keyref = getAttr(node, 'keyref');
    if (keyref && ctx.resolveKey) return `<abbr class="abbreviated-form" title="${escapeAttr(keyref)}">${escapeAttr(ctx.resolveKey(keyref) || keyref)}</abbr>`;
    return `<abbr class="abbreviated-form">${renderChildren(node, ctx)}</abbr>`;
  },
  'topic/glossterm': (_node, ctx, renderChildren) =>
    `<dfn class="glossterm">${renderChildren(_node, ctx)}</dfn>`,
  'topic/glossdef': (_node, ctx, renderChildren) =>
    `<dd class="glossdef">${renderChildren(_node, ctx)}</dd>`,
  'topic/glossentry': (_node, ctx, renderChildren) =>
    `<dl class="glossentry">${renderChildren(_node, ctx)}</dl>`,
  'topic/glossref': (_node, ctx, renderChildren) =>
    `<span class="glossref">${renderChildren(_node, ctx)}</span>`,
  'topic/glossgroup': (_node, ctx, renderChildren) =>
    `<div class="glossgroup">${renderChildren(_node, ctx)}</div>`,

  // Hazard
  'topic/hazardstatement': (node, ctx, renderChildren) =>
    `<div class="hazardstatement">${renderChildren(node, ctx)}</div>`,
  'topic/typeofhazard': (_node, ctx, renderChildren) =>
    `<span class="typeofhazard">${renderChildren(_node, ctx)}</span>`,
  'topic/hazardsymbol': () => '',
  'topic/howtoavoid': (_node, ctx, renderChildren) =>
    `<p class="howtoavoid">${renderChildren(_node, ctx)}</p>`,
  'topic/consequence': (_node, ctx, renderChildren) =>
    `<p class="consequence">${renderChildren(_node, ctx)}</p>`,

  // Multimedia
  'topic/object': (_node, ctx, renderChildren) =>
    `<object class="dita-object object">${renderChildren(_node, ctx)}</object>`,
  'topic/param': () => '',

  // Anchors
  'topic/anchor': (node) => {
    const id = getAttr(node, 'id');
    return id ? `<a${safeAttr('id', id)}></a>` : '';
  },
  'topic/anchorid': (node) => {
    const id = getAttr(node, 'id');
    return id ? `<span${safeAttr('id', id)}></span>` : '';
  },
  'topic/anchorkey': () => '',
  'topic/anchorref': () => '',

  // Prolog — metadata container (author, critdates, permissions, metadata,
  // keywords, etc.). Entirely non-display; swallow the whole subtree so
  // nothing leaks into the body preview. Mirrors the anchorkey/anchorref
  // pattern. Evidence: base/dtd/commonElementMod.ent — class
  // "- topic/prolog " — appears between title and body in topic/concept/
  // task/reference. Without this entry the fallback renderer recurses into
  // children, causing author/keyword content to appear in the body.
  //
  // EXCEPT <indexterm>: declaring topic-level index entries inside
  // <prolog><metadata><keywords> (rather than as an inline marker inside
  // <body>) is a very common, arguably more common, real-world authoring
  // pattern -- and blanket-suppressing all of prolog meant those index
  // entries were silently invisible in preview for exactly that pattern,
  // even though the whole point of adding indexterm rendering (see
  // topic/indexterm below) was to make them visible. Every OTHER prolog
  // descendant (author, critdates, plain keyword text meant only for
  // search metadata, etc.) is still fully suppressed -- only indexterm
  // chips get pulled out.
  'topic/prolog': (node, ctx) => {
    if (ctx.suppressIndexterm) return '';
    const topLevelTerms = findTopLevelIndextermsInSubtree(node);
    if (topLevelTerms.length === 0) return '';
    const chips = topLevelTerms
      .flatMap((termNode) => collectIndextermChips(termNode))
      .map((chip) => renderIndextermChip(chip, ctx))
      .join('');
    return chips ? `<div class="indexterm-chip-group" title="${escapeAttr(ctx.indexLabel || 'Index')}">${chips}</div>` : '';
  },

  // These three (topic/keywords, topic/metadata, topic/publisher) are always
  // nested inside <prolog> in valid DITA — topic/prolog already suppresses
  // the whole subtree above, so these never actually get reached. Mapped
  // explicitly anyway, matching the anchorid/anchorkey/anchorref/prolog
  // precedent of not relying solely on an ancestor's suppression.
  'topic/keywords': () => '',
  'topic/metadata': () => '',
  'topic/publisher': () => '',

};
