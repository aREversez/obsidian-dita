import { DitaNode, SourceRange } from '../parser/domTypes';
import { BASE_TYPE_RENDERERS } from './baseTypeMap';
import { computeKeyrefSpacing } from './cjkSpacing';

export interface RenderContext {
  headingLevel: number;
  asWebviewUri: (path: string) => string;
  documentDir: string;
  parentBaseType?: string;
  /**
   * The baseType of the element that directly contains the node currently
   * being rendered (its real parent). `parentBaseType` is overloaded -- it is
   * repurposed as the context handed to children, so inside a renderer it
   * reads back as the node's *own* baseType. Renderers that must branch on the
   * actual parent (topic/title chooses topictitleN vs sectiontitle) read this
   * field instead. Set in renderEffectiveNode from the incoming context's
   * parentBaseType, which is the parent's own baseType at that point.
   */
  ownerBaseType?: string;
  /** True while rendering descendants of thead/sthead (entry/stentry → th) */
  inTableHeader?: boolean;
  /** Conref targets already resolved on this branch (cycle protection) */
  conrefChain?: ReadonlySet<string>;
  /**
   * True while rendering inside content that carries a conref mark. Only
   * affects the keyboard stop of a nested mark (tabindex -1 rather than 0:
   * still focusable by click or script, but not one more Tab stop per reuse
   * inside reuse); see markConrefContent.
   */
  insideConref?: boolean;
  resolveTitle?: (id: string) => string | undefined;
  resolveKey?: (key: string) => string | undefined;
  resolveConref?: (conref: string) => DitaNode | undefined;
  /**
   * Resolves a @conkeyref value ("keyname[/elementid]") to the target element
   * by first looking the key up in the map key space (to get the target
   * topic's href) and then addressing the element inside it. The key-based
   * analogue of resolveConref: the renderer substitutes the returned element
   * exactly as it would a direct conref target. Undefined (or a return of
   * undefined) means "cannot resolve", which is when a co-located @conref acts
   * as the fallback (DITA 1.3).
   */
  resolveConkeyref?: (conkeyref: string) => DitaNode | undefined;
  /**
   * The next hop of a reference chain: given a resolved target element that
   * itself carries a conref/conkeyref, returns what that reference points at,
   * resolved relative to the file the element lives in. Undefined means "cannot
   * resolve" (the chain stops at `from`). Absent: chains resolve one hop only.
   */
  resolveChainHop?: (from: DitaNode) => DitaNode | undefined;
  /**
   * Opt-in: marks conref/conkeyref/conrefend content so the preview can tell
   * it from the element's own content and offer a jump to where it comes
   * from. Given a resolved target element, returns the absolute path of the
   * file that holds it (undefined = cannot place it, which leaves the content
   * unmarked). Absent for every path that must emit plain markup -- "Export
   * as HTML" and the diff view -- so those never see the data-conref-*
   * attributes. See markConrefContent below for what is emitted.
   */
  conrefSource?: (target: DitaNode) => string | undefined;
  /** conrefend range support — see renderConrefRange below */
  resolveConrefRange?: (conref: string, conrefend: string) => DitaNode[] | undefined;
  noteLabels?: Record<string, string>;
  /**
   * Reads an image's natural pixel dimensions from disk (relative to
   * documentDir, same as asWebviewUri) so the renderer can reserve the
   * right aspect-ratio box via width/height attributes before the browser
   * has loaded the actual image data -- only consulted when the DITA
   * source itself has no @width/@height, which always wins when present.
   */
  getImageDimensions?: (relPath: string) => { width: number; height: number } | undefined;
  /** Localized "Index" label used in indexterm chip tooltips -- resolved
   *  upstream (see detectIndexLabel in ditaRenderUtils.ts) the same way
   *  noteLabels is, so this module stays free of any locale logic of its
   *  own. Falls back to 'Index' when not supplied. */
  indexLabel?: string;
  /**
   * When true, <indexterm> content is never rendered -- neither as an
   * inline chip in the body nor pulled out of <prolog><metadata><keywords>.
   * Index terms are authoring metadata (an index-generation hint for a
   * publishing toolchain), and the interactive preview surfaces them as
   * chips only as an editing aid; a standalone "Export as HTML" file has no
   * such editing context and no index to build, so they'd just be stray
   * clutter in the shipped document. Left undefined/false everywhere except
   * the export path so the interactive preview (DitaViewerProvider /
   * MapViewerProvider) keeps showing chips exactly as before.
   */
  suppressIndexterm?: boolean;
  /**
   * Resolves a cross-file xref's raw href to an absolute path IF the
   * referenced topic is part of the book/docsite this topic is itself
   * being rendered as part of, and undefined otherwise (target isn't in
   * this book, or isn't a resolvable local .dita reference at all). Only
   * set by callers assembling a book (renderBookParts) or a docsite page
   * (MapViewerProvider's site mode) -- standalone single-topic preview
   * (DitaViewerProvider) and "Export as HTML" never set this, so a
   * cross-file xref there keeps rendering as the existing non-clickable
   * <span class="xref-external"> hint (docsite design doc, 3.2/4.5).
   *
   * Deliberately returns the resolved path rather than a plain boolean:
   * the caller (MapViewerProvider's webview click handler) needs an
   * address to act on, not just a yes/no, and resolving the href against
   * the right base directory (this topic's own directory, not the map's)
   * is something only the caller building this closure can do correctly
   * -- see makeFileTitleResolver's own resolution for the same rule
   * applied to xref titles.
   */
  isInCurrentBook?: (href: string) => string | undefined;
}

const CONTAINER_BASETYPES = new Set([
  'topic/section',
  'topic/example',
  'topic/fig',
  'topic/imagemap',
  'topic/related-links',
]);

const PASS_THROUGH_BASETYPES = new Set([
  'topic/tgroup',
  'topic/link',
  'topic/linktext',
]);

function isContainerBaseType(baseType: string): boolean {
  return CONTAINER_BASETYPES.has(baseType);
}

// ── Profiling / conditional-processing attribute highlighting ──
// Per the OASIS DITA 1.3 select-atts entity (commonElements.mod): the full
// set of attributes conditional-processing tools (Oxygen's "Conditional
// Text" / DITA-OT's .ditaval) act on is props, platform, product, audience,
// otherprops (the filter-atts subgroup), plus base, importance, rev, and
// status. This only *highlights* profiled content (matches it visually, the
// way Oxygen shows profiling by default) — it does not hide anything; that
// would be a real conditional-processing engine (a .ditaval-driven filter),
// which is a separate, larger feature this doesn't attempt.
const PROFILING_ATTRS = ['props', 'platform', 'product', 'audience', 'otherprops', 'base', 'importance', 'rev', 'status'];

const PROFILING_ATTR_LABELS: Record<string, string> = {
  otherprops: 'Other',
};

function profilingAttrLabel(attr: string): string {
  return PROFILING_ATTR_LABELS[attr] || attr.charAt(0).toUpperCase() + attr.slice(1);
}

// ── Shared with the ditamap renderer (mapTypeMap.ts) ──
// A topicref's profiling attributes cascade to every descendant topicref
// that doesn't set its own value for the same attribute (own value replaces
// the inherited one wholesale, it doesn't merge token-by-token — this
// matches real .ditaval/Oxygen conditional-processing semantics, and is
// also how DITA-OT itself resolves the same attribute set at different
// levels of a map). mapTypeMap.ts calls this while walking the map tree so
// each topicref/topichead/topicgroup gets the correctly cascaded effective
// set, including through map-of-maps (expandDitamapRefs has already
// flattened those into the same tree by the time this runs).
export function mergeProfilingAttrs(
  own: Record<string, string> | undefined,
  inherited: Record<string, string>,
): Record<string, string> {
  const effective: Record<string, string> = { ...inherited };
  const attrs = own || {};
  for (const name of PROFILING_ATTRS) {
    const v = attrs[name];
    if (v && v.trim()) effective[name] = v;
  }
  return effective;
}

/** The data-profile-keys attribute value the webview's filter panel keys off of. */
export function profilingKeysAttr(effective: Record<string, string>): string {
  const chips = getProfilingChipsFromEffective(effective);
  return chips.map((c) => `${encodeURIComponent(c.attr)}:${encodeURIComponent(c.value)}`).join(',');
}

/** Human-readable "Attr [value]" chip spans, for visual display next to a map entry. */
export function profilingChipsHtml(effective: Record<string, string>): string {
  return getProfilingChipsFromEffective(effective)
    .map((c) => `<span class="profiling-chip">${escapeHtml(profilingAttrLabel(c.attr))} <span class="profiling-chip__value">[${escapeHtml(c.value)}]</span></span>`)
    .join('');
}

function getProfilingChipsFromEffective(effective: Record<string, string>): { attr: string; value: string }[] {
  const chips: { attr: string; value: string }[] = [];
  for (const name of PROFILING_ATTRS) {
    const raw = effective[name];
    if (!raw) continue;
    for (const token of raw.trim().split(/\s+/)) {
      if (token) chips.push({ attr: name, value: token });
    }
  }
  return chips;
}

// Elements commonly authored inline, within a sentence — highlighting these
// as a full-width block would break the surrounding text flow, so they get
// an inline-flavored wrapper instead. Not an exhaustive classification (the
// renderer has no general block/inline taxonomy to draw on); anything not
// listed here defaults to the block treatment, which matches the more
// common case of profiling applied at paragraph/step/section granularity
// (as in the reported example) rather than to individual inline phrases.
const INLINE_PROFILING_BASETYPES = new Set([
  'topic/ph', 'topic/b', 'topic/i', 'topic/u', 'topic/sup', 'topic/sub',
  'topic/term', 'topic/keyword', 'topic/tm', 'topic/xref', 'topic/cite',
  'topic/q', 'topic/filepath', 'topic/userinput', 'topic/systemoutput',
  'topic/varname', 'topic/cmdname', 'topic/wintitle', 'topic/uicontrol',
  'topic/menucascade', 'topic/shortcut',
]);

function getProfilingChips(node: DitaNode): { attr: string; value: string }[] {
  return getProfilingChipsFromEffective(node.attributes || {});
}

// li (and other block content whose own layout/marker position depends on
// its *real* parent -- ul/ol for li, but block content generally shouldn't
// gain a synthetic intermediate parent either) can't just be wrapped in an
// extra <span>: the browser positions a list marker relative to the li's
// own containing block, and wrapping it in a block-level .profiled <span>
// makes that wrapper the containing block instead of the real <ul>/<ol> --
// the marker ends up offset by .profiled's own padding/border, both
// visually overlapping the marker and making a profiled <li>'s indent not
// match its plain siblings. injectBlockProfiling adds the class/data
// attribute onto the block element's own tag in place, and the label just
// before its own closing tag, instead of introducing a wrapper element at
// all -- the DOM shape for a profiled block element ends up identical to
// an unprofiled one, just with two extra attributes and one extra child.
function injectBlockProfiling(html: string, tagName: string, keysAttr: string, labelHtml: string): string {
  const openTagEnd = html.indexOf('>');
  const openTag = openTagEnd >= 0 ? html.slice(0, openTagEnd) : html;
  const hasClass = / class="/.test(openTag);
  let out = hasClass
    ? html.replace(/ class="([^"]*)"/, (_m, existing) => ` class="${existing ? `${existing} profiled` : 'profiled'}"`)
    : html.replace(/^<([a-zA-Z][a-zA-Z0-9]*)/, '<$1 class="profiled"');
  out = out.replace(/^<([a-zA-Z][a-zA-Z0-9]*)/, `<$1 data-profile-keys="${keysAttr}"`);

  // `tagName` is the *DITA source* element name (e.g. "row", "entry",
  // "stentry"), passed through from effectiveNode.tagName purely so
  // injectAttributes can stamp the original authoring tag onto
  // data-dita-tagname for tooltips. It is NOT reliable for finding this
  // element's own closing tag in `html`: several base types render under a
  // different HTML tag than their DITA element name -- a <row> renders as
  // <tr>, and <entry>/<stentry> render as <td> or <th> depending on
  // header context. Building the close-tag search from `tagName` in that
  // case (`</row>`, `</entry>`) never matches anything in `html` (which
  // actually contains `</tr>`/`</td>`/`</th>`), so the lookup below fell
  // through its "not found" branch and silently dropped the label for
  // every profiled table row or cell. Reading the real tag straight out of
  // the opening tag we just edited keeps this correct regardless of what
  // the DITA source called the element.
  const actualTagMatch = /^<([a-zA-Z][a-zA-Z0-9]*)/.exec(out);
  const actualTag = actualTagMatch ? actualTagMatch[1] : tagName;

  // html is always exactly one complete element at this point in the
  // pipeline (possibly with same-named descendants nested inside, e.g. a
  // <li> containing a nested <ul><li>...) -- proper nesting guarantees any
  // child's closing tag appears before its parent's, so the *last*
  // occurrence of this tag's own closing tag in the string is always the
  // outermost (real) one, letting the label be inserted as the true last
  // child without needing a full tag-depth parser.
  const closeTag = `</${actualTag}>`;
  const closeIdx = out.lastIndexOf(closeTag);
  if (closeIdx === -1) return out;

  if (actualTag === 'tr') {
    // A <tr>'s only legal direct children are <td>/<th> (plus
    // script/template) -- inserting the label <span> as the row's own
    // last child, the way every other block element is handled below, is
    // invalid content. The HTML parser "fixes" that by foster-parenting
    // the span out of the table entirely (per the "in row"/"in table"
    // insertion modes: anything that isn't a cell gets relocated to just
    // before the <table>, not left where it was written). That relocation
    // is exactly what produced both reported symptoms: the label render­
    // ing detached from its own row -- so it shows up vertically offset,
    // stacked wherever the parser moved it rather than next to its row --
    // and the <tr>'s child list no longer matching what was authored,
    // which breaks the shared collapsed-border edge with the row below
    // it. The fix is to anchor the label inside the row's own last cell
    // instead, which is valid content there.
    const lastTd = out.lastIndexOf('</td>', closeIdx);
    const lastTh = out.lastIndexOf('</th>', closeIdx);
    const lastCellClose = Math.max(lastTd, lastTh);
    if (lastCellClose === -1) return out; // no cells to anchor the label to
    return `${out.slice(0, lastCellClose)}<span class="profiling-label">${labelHtml}</span>${out.slice(lastCellClose)}`;
  }

  return `${out.slice(0, closeIdx)}<span class="profiling-label">${labelHtml}</span>${out.slice(closeIdx)}`;
}

function wrapProfilingHighlight(html: string, node: DitaNode, tagName?: string): string {
  const chips = getProfilingChips(node);
  if (chips.length === 0) return html;
  const inline = node.baseType ? INLINE_PROFILING_BASETYPES.has(node.baseType) : false;
  const labelHtml = chips
    .map((c) => `<span class="profiling-chip">${escapeHtml(profilingAttrLabel(c.attr))} <span class="profiling-chip__value">[${escapeHtml(c.value)}]</span></span>`)
    .join('');
  // Machine-readable twin of the human-readable chips above, for the
  // toolbar's filter panel (webview-side) to key visibility off of without
  // re-parsing chip text. encodeURIComponent on each part keeps the ':'/','
  // delimiters unambiguous regardless of what characters appear in a real
  // attribute value (DITA doesn't restrict these to a safe token charset).
  const keysAttr = escapeHtml(
    chips.map((c) => `${encodeURIComponent(c.attr)}:${encodeURIComponent(c.value)}`).join(','),
  );
  if (!inline && tagName) {
    return injectBlockProfiling(html, tagName, keysAttr, labelHtml);
  }
  const cls = inline ? 'profiled profiled--inline' : 'profiled';
  return `<span class="${cls}" data-profile-keys="${keysAttr}">${html}<span class="profiling-label">${labelHtml}</span></span>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function injectAttributes(html: string, tagName: string, range: SourceRange): string {
  // A renderer's own `title=` (checked only within its opening tag, not
  // inside any nested children's markup) wins over the generic
  // tag-name-as-tooltip fallback — otherwise the generic one lands first
  // in the tag and, per HTML5's first-duplicate-wins parsing rule, silently
  // shadows whatever the renderer intended (e.g. topic/image using the
  // resolved alt text as its tooltip instead of the literal word "image").
  //
  // The generic fallback itself is a data attribute, not a second title=:
  // baking "every element gets a native browser tooltip reading its raw
  // tag name" straight into the HTML made it impossible to turn off without
  // a full re-render, and reading the tag name on hover is useful while
  // learning DITA but noisy otherwise. data-dita-tagname carries the same
  // information; the "Tags" toolbar toggle promotes it to a real title
  // attribute only when the reader has asked for it (see applyTagTooltips
  // in DitaViewerProvider.ts/MapViewerProvider.ts's webview scripts).
  const openTagEnd = html.indexOf('>');
  const openTag = openTagEnd >= 0 ? html.slice(0, openTagEnd) : html;
  const hasOwnTitle = / title="/.test(openTag);
  const tagNamePart = hasOwnTitle ? '' : ` data-dita-tagname="${tagName}"`;
  return html.replace(
    /^<([a-zA-Z][a-zA-Z0-9]*)/,
    `<$1${tagNamePart} data-line="${range.startLine}" data-end-line="${range.endLine}" data-start-col="${range.startCol}" data-end-col="${range.endCol}"`,
  );
}

// Content pulled in by a conref/conkeyref/conrefend merge is authored in the
// *target* file, but data-line highlighting and scroll-sync resolve against
// the referencing document's editor. Left with the target's own line numbers,
// the merged subtree is a field of foreign ranges inside this document:
// findContaining matches the click position against them (highlighting an
// arbitrary entry of a block the cursor never touched, or the whole coarse
// ancestor when nothing matches), and findClosest falls back to whichever
// foreign start-line is numerically nearest. So every transplanted node is
// re-stamped with the referencing element's range — the only position in
// this file that content legitimately has. All elements of one merged run
// then share one range: clicking anywhere on the referencing tag picks that
// tag, which is exactly what "go to my source" means for content that has
// no per-entry source line here.
function stampSourceRange(node: DitaNode, range: SourceRange): DitaNode {
  return {
    ...node,
    sourceRange: range,
    children: node.children?.map((child) => stampSourceRange(child, range)),
  };
}

// Shared by both a normal single-target conref and the first member of a
// conrefend range: the referencing element's own attributes (minus
// conref/conrefend/conkeyref) take precedence, and its tag/baseType is kept when the
// target is the same baseType (DITA's "same-type" conref semantics) —
// otherwise the target's tag/baseType wins instead, since a same-shaped
// substitution isn't possible.
//
// Chains (A -> B -> C) are followed by followConrefChain before the merge, so
// `target` here is already the end of the chain. Conrefs nested *inside* the
// resolved content are followed as well, since renderNode resolves each child
// as it walks.
function mergeConrefTarget(node: DitaNode, target: DitaNode): DitaNode {
  const restAttrs = Object.fromEntries(
    Object.entries(node.attributes || {}).filter(([k]) => k !== 'conref' && k !== 'conrefend' && k !== 'conkeyref')
  );
  if (target.baseType && target.baseType === node.baseType) {
    return { ...node, children: (target.children || []).map((c) => stampSourceRange(c, node.sourceRange)), attributes: restAttrs };
  }
  // Cross-type merge: the target's element shape wins, but never its source
  // position — the target and all of its descendants sit at the referencing
  // element's range.
  const stamped = stampSourceRange(target, node.sourceRange);
  const targetAttrs = Object.fromEntries(
    Object.entries(stamped.attributes || {})
      .filter(([k]) => k !== 'conref' && k !== 'conrefend' && k !== 'conkeyref' && k !== 'id')
  );
  return { ...stamped, attributes: { ...targetAttrs, ...restAttrs } };
}

/** Where a piece of conref'd content really lives: the file and 0-based position of its target. */
interface ConrefMark {
  file: string;
  line: number;
  col: number;
}

// The target's own sourceRange is read here, BEFORE mergeConrefTarget
// re-stamps it with the referencing element's range (see stampSourceRange):
// the stamped copy points into this document, which is exactly the position
// the jump must NOT land on.
function conrefMarkFor(target: DitaNode, context: RenderContext): ConrefMark | undefined {
  const file = context.conrefSource?.(target);
  if (!file) return undefined;
  return { file, line: target.sourceRange.startLine, col: target.sourceRange.startCol };
}

// How the jump icon is laid out, chosen from the tag that actually rendered
// (not the DITA name: <row> renders as <tr>, <entry> as <td>/<th>).
//   inline -- a phrase inside running text: a small icon after it.
//   cell   -- table structure, which cannot take an in-flow block before its
//             first child: the icon floats over the top-left corner instead.
//   block  -- everything else: the icon sits on its own line above the content.
const CONREF_CELL_TAGS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'colgroup', 'caption']);

// Of the cell kind, only these are a sensible keyboard stop. table, thead,
// tbody, tfoot, tr, colgroup and caption keep the mouse icon but get no
// tabindex: colgroup has no box to draw a focus ring on, an outline on a tr
// is not reliable across browsers, and a Tab stop on every structural wrapper
// of a reused table is noise. Jumping from a reused table is a cell-level act.
const CONREF_FOCUSABLE_CELL_TAGS = new Set(['td', 'th']);

function openingTag(html: string): string {
  return (/^<([a-zA-Z][a-zA-Z0-9]*)/.exec(html)?.[1] ?? '').toLowerCase();
}

function conrefKind(html: string, baseType: string | undefined): 'inline' | 'cell' | 'block' {
  const tag = openingTag(html);
  if (CONREF_CELL_TAGS.has(tag)) return 'cell';
  if (baseType && INLINE_PROFILING_BASETYPES.has(baseType)) return 'inline';
  return 'block';
}

/**
 * Stamps conref'd content onto its own opening tag, in place (no wrapper
 * element: a wrapper would change the DOM shape under li/tr/table the same
 * way profiling's wrapper did, see injectBlockProfiling).
 *   data-conref="block|inline|cell"  -- the styling hook and icon layout
 *   data-conref-file / -line / -col  -- the target, for the jump button
 *   tabindex + aria-describedby      -- (tabindex 0 on the outermost mark, -1 on
 *     a mark nested inside another, so reuse-in-reuse is not a Tab stop each;
 *     omitted on table/thead/tbody/tfoot/tr/colgroup/caption, see
 *     CONREF_FOCUSABLE_CELL_TAGS) the badge is a background with no DOM,
 *     so the marked element itself is made focusable and points its accessible
 *     description at the one hidden hint node the webview script injects. The
 *     id literal must stay equal to CONREF_JUMP_HINT_ID in
 *     editor/webview/conrefJumpScript.ts (renderer cannot import from editor,
 *     so it is duplicated here; conrefJump.test asserts they match).
 * The webview treats the file as untrusted input and the host re-validates
 * it before opening anything.
 */
function markConrefContent(html: string, mark: ConrefMark, baseType: string | undefined, nested: boolean): string {
  const kind = conrefKind(html, baseType);
  const focusable = kind !== 'cell' || CONREF_FOCUSABLE_CELL_TAGS.has(openingTag(html));
  const a11y = focusable ? ` tabindex="${nested ? -1 : 0}" aria-describedby="dv-conref-jump-hint"` : '';
  const attrs = `data-conref="${kind}" data-conref-file="${escapeHtml(mark.file)}" data-conref-line="${mark.line}" data-conref-col="${mark.col}"${a11y}`;
  // A function replacement: the path is arbitrary text and must not be read
  // for $-patterns.
  return html.replace(/^<([a-zA-Z][a-zA-Z0-9]*)/, (_m, tag: string) => `<${tag} ${attrs}`);
}

/** Most hops a reference chain may take; a deeper chain degrades to one hop. */
export const MAX_CONREF_CHAIN_DEPTH = 10;

// Follow A -> B -> C transitively from the first resolved target. The first
// target counts as hop 1. An unresolvable later hop ends the chain at the last
// element that did resolve; a cycle or a chain deeper than the cap falls back
// to the first hop, which is what the renderer did before chains were followed.
function followConrefChain(first: DitaNode, context: RenderContext): DitaNode {
  const hop = context.resolveChainHop;
  if (!hop) return first;
  const seen = new Set<DitaNode>([first]);
  let current = first;
  for (let depth = 1; ; depth++) {
    if (!current.attributes?.conref && !current.attributes?.conkeyref) return current;
    const next = hop(current);
    if (!next) return current;
    if (seen.has(next) || depth >= MAX_CONREF_CHAIN_DEPTH) return first;
    seen.add(next);
    current = next;
  }
}

// Resolve one content reference for a node. conkeyref (indirect, by key) takes
// precedence over conref (direct) when it resolves — matching the DITA 1.3
// rule and DITA-OT's behaviour, where an unresolvable conkeyref falls back to
// the element's @conref. The returned chainKey is whichever reference actually
// fired, so the caller adds it to conrefChain for cycle protection.
function resolveConrefForNode(
  node: DitaNode,
  context: RenderContext,
): { node: DitaNode; chainKey?: string; mark?: ConrefMark } {
  const conkeyref = node.attributes?.conkeyref;
  if (conkeyref && context.resolveConkeyref && !context.conrefChain?.has(conkeyref)) {
    const keyTarget = context.resolveConkeyref(conkeyref);
    if (keyTarget) {
      const end = followConrefChain(keyTarget, context);
      return { node: mergeConrefTarget(node, end), chainKey: conkeyref, mark: conrefMarkFor(end, context) };
    }
  }
  const conref = node.attributes?.conref;
  if (!conref || !context.resolveConref) return { node };
  // A conref already resolved on this branch points back here — stop the
  // cycle and render the element's literal content instead of recursing.
  if (context.conrefChain?.has(conref)) return { node };
  const target = context.resolveConref(conref);
  if (!target) return { node };
  const end = followConrefChain(target, context);
  return { node: mergeConrefTarget(node, end), chainKey: conref, mark: conrefMarkFor(end, context) };
}

function resolveKeyrefForNode(node: DitaNode, context: RenderContext): DitaNode {
  const keyref = node.attributes?.keyref;
  if (!keyref || !context.resolveKey) return node;
  // Per the DITA spec, existing element content wins over the key-resolved
  // text — only substitute when the element is effectively empty.
  const hasLocalContent = (node.children || []).some(
    (c) => c.type === 'element' || (c.text || '').trim() !== '',
  );
  if (hasLocalContent) return node;
  const resolved = context.resolveKey(keyref);
  if (!resolved) return node;
  // Strip keyref after resolving, replace children with resolved text
  const restAttrs = Object.fromEntries(
    Object.entries(node.attributes || {}).filter(([k]) => k !== 'keyref')
  );
  return {
    ...node,
    children: [{ type: 'text', text: resolved, children: [], sourceRange: node.sourceRange }],
    attributes: restAttrs,
  };
}

// The "given a fully-resolved node, actually render it" half of
// renderElement — factored out so the conrefend range path below can reuse
// it for the merged first range member without re-running conref/keyref
// resolution on something that's already resolved.
function renderEffectiveNode(
  effectiveNode: DitaNode,
  context: RenderContext,
  resolvedConref: string | undefined,
  mark?: ConrefMark,
): string {
  const baseType = effectiveNode.baseType;
  const renderer = baseType ? BASE_TYPE_RENDERERS[baseType] : undefined;

  const isContainer = baseType ? isContainerBaseType(baseType) : false;
  const nextHeadingLevel = isContainer
    ? context.headingLevel + 1
    : context.headingLevel;

  const childCtx: RenderContext = {
    ...context,
    headingLevel: nextHeadingLevel,
    parentBaseType: baseType,
    ownerBaseType: context.parentBaseType,
    conrefChain: resolvedConref
      ? new Set([...(context.conrefChain || []), resolvedConref])
      : context.conrefChain,
    insideConref: context.insideConref || !!mark,
  };

  if (renderer) {
    let html = renderer(effectiveNode, childCtx, renderChildren);
    if (baseType && !PASS_THROUGH_BASETYPES.has(baseType)) {
      const tagName = effectiveNode.tagName || baseType.split('/').pop() || baseType;
      html = injectAttributes(html, tagName, effectiveNode.sourceRange);
      // Before the profiling wrapper: an inline element's wrapper span would
      // otherwise become the "first tag" the mark lands on.
      if (mark) html = markConrefContent(html, mark, baseType, !!context.insideConref);
      html = wrapProfilingHighlight(html, effectiveNode, tagName);
    }
    return html;
  }

  return wrapProfilingHighlight(renderChildren(effectiveNode, childCtx), effectiveNode);
}

// conrefend replaces a *single* referencing element with a *run* of
// elements pulled from the target document (the conref target through the
// conrefend target, inclusive) — a fundamentally different shape from
// normal conref's one-for-one substitution, so it's handled as its own
// path rather than folded into resolveConrefForNode. Only the first
// element in the range takes on the referencing element's own
// tag/attributes (mergeConrefTarget, same rule as normal conref) — the
// rest render as themselves, straight from the target document, since
// there's no second referencing element for them to inherit from.
//
// Every member is re-stamped with the referencing element's sourceRange
// (see stampSourceRange): the whole run highlights as the referencing tag,
// and no member leaks target-document line numbers into this file's
// data-line map — the bug that used to make range members after the first
// steal highlights and scroll-sync for unrelated lines.
function renderConrefRange(node: DitaNode, range: DitaNode[], context: RenderContext, conref: string): string {
  return range
    .map((rangeNode, i) => {
      // Each member is its own target in the source file, so each carries its
      // own jump position (the first one's merge keeps the referencing tag).
      const mark = conrefMarkFor(rangeNode, context);
      if (i === 0) {
        const merged = mergeConrefTarget(node, rangeNode);
        return renderEffectiveNode(merged, context, conref, mark);
      }
      return renderElement(stampSourceRange(rangeNode, node.sourceRange), context, mark);
    })
    .join('');
}

export function renderElement(node: DitaNode, context: RenderContext, conrefMark?: ConrefMark): string {
  if (node.type === 'text') {
    return escapeHtml(node.text || '');
  }

  const conref = node.attributes?.conref;
  const conrefend = node.attributes?.conrefend;
  if (conref && conrefend && context.resolveConrefRange && !context.conrefChain?.has(conref)) {
    const range = context.resolveConrefRange(conref, conrefend);
    // A range that fails to resolve (e.g. the two ids aren't siblings, or
    // one doesn't exist) falls through to normal single-target conref
    // handling below instead — showing the conref target alone is a more
    // useful degradation than showing nothing.
    if (range && range.length > 0) {
      return renderConrefRange(node, range, context, conref);
    }
  }

  const resolved = resolveConrefForNode(node, context);
  const effectiveNode = resolveKeyrefForNode(resolved.node, context);
  // The element's own conref wins over a mark handed down by a range.
  return renderEffectiveNode(effectiveNode, context, resolved.chainKey, resolved.mark ?? conrefMark);
}

function renderChildren(node: DitaNode, context: RenderContext): string {
  const children = node.children || [];
  // Resolved key text can leave CJK and Latin glued together (`打开` + `ABC`).
  // Insert a display-only space outside the key element; the source is untouched.
  const spacing = computeKeyrefSpacing(children, node.baseType, context.resolveKey);
  return children
    .map((child, i) => {
      const html = renderElement(child, context);
      return (spacing[i].before ? ' ' : '') + html + (spacing[i].after ? ' ' : '');
    })
    .join('');
}

export function renderDocument(
  root: DitaNode,
  context: RenderContext,
): string {
  return renderElement(root, context);
}