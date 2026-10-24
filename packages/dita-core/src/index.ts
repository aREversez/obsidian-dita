// Public surface of @dita-viewer/core.
//
// Hosts (the Obsidian plugin, and in time the VS Code extension) render DITA
// through these exports only. The VS Code DITA Viewer depends on this package
// and holds no copies of ./parser, ./render and ./editor (see README), so they
// are edited here and released as a new version.

export { renderTopicXml, buildTitleMap, collectDitamapFilesUpward } from './editor/topicRender';
export type { TopicXmlRenderInput, TopicRenderInput, TopicRenderResult, ParsedTopicResult } from './editor/topicRender';
export { buildKeySpace, getKeyDefs } from './editor/keySpace';
export type { KeyHrefDef, KeySpace } from './editor/keySpace';
export { readSourceText, setSourceOverlay, clearSourceOverlay } from './editor/sourceText';
export { decodeHrefPart } from './editor/refResolvers';
export { buildKeyMapForDocument, buildKeySpaceForDocument } from './keyMapForDocument';
export { complete } from './completion';
export { collectDiagnostics } from './diagnostics';
export type { DitaDiagnostic, DiagnosticSeverity, DiagnosticsInput } from './diagnostics';
export type { CompletionEnv, CompletionResult, Suggestion, SuggestionKind } from './completion';
export { collectReferenceableFiles, toRelativeHref } from './language/referenceableFiles';
export type { ReadDir, WalkEntry } from './language/referenceableFiles';
export { IMAGE_EXT } from './completionData';
export { collectIds, splitRefFragment } from './language/ditaLanguageUtils';
export { collectRefEntries, offsetToLineCol } from './language/ditaLanguageUtils';
export type { RefEntry } from './language/ditaLanguageUtils';
export { renderMapXml } from './mapRender';
export type { MapXmlRenderInput } from './mapRender';
export { renderBookXml } from './bookRender';
export type { BookXmlRenderInput, BookXmlRenderResult } from './bookRender';
export { renderSiteXml } from './siteRender';
export type { SiteNavEntry, SiteXmlRenderInput, SiteXmlRenderResult } from './siteRender';
export {
  PROFILE_ATTRS,
  ditavalAction,
  isEmptyFilter,
  isExcluded,
  isValueExcluded,
  parseDitaval,
  profileGroups,
  profileKey,
  profileValuesOf,
  profileValuesOfKeys,
  pruneExcluded,
} from './profiling';
export type { Ditaval, DitavalAction, DitavalRule, ProfileFilter, ProfileGroup, ProfileValues } from './profiling';
export { collectMapEntries, getMapTitleText } from './render/mapTypeMap';
// The parser and renderer entry points a host that renders by itself needs, and
// what they take and return. Everything the VS Code viewer imports from the
// copied modules is here, so it can depend on this package instead of copying.
export { parseDita, parseDitamap, preprocessEntities } from './parser/ditaParser';
export type { DitaDocument, DitaNode, SourceRange } from './parser/domTypes';
export { STANDARD_TAG_TO_BASETYPE } from './parser/standardTagMap';
export { MAP_STANDARD_TAG_TO_BASETYPE } from './parser/mapTagMap';
export { renderDocument, renderElement } from './render/renderer';
export type { RenderContext } from './render/renderer';
export { collectIndextermChips, findTopLevelIndextermsInSubtree } from './render/baseTypeMap';
export { createBookRoleLabeler, extractText, getDisplayNameInfo, isDitamapRef, renderMapDocument } from './render/mapTypeMap';
export { isExternalRef } from './language/ditaLanguageUtils';
export type { MapEntry } from './render/mapTypeMap';
export type { RoleLabelFormatter, RoleLabelInfo } from './render/mapTypeMap';
export type { KeyMapOptions } from './keyMapForDocument';
// The rest of what the VS Code viewer imports from the copied modules: the
// render cache, the file and key resolvers, the source overlay, the editor
// language helpers, and the helpers its tests call. Their shapes follow the
// viewer's needs and may change while the version is 0.x.
export { lookupNamedEntity } from './parser/namedEntities';
export { BASE_TYPE_RENDERERS } from './render/baseTypeMap';
export { computeKeyrefSpacing, needsSpace } from './render/cjkSpacing';
export { mergeProfilingAttrs, profilingChipsHtml, profilingKeysAttr } from './render/renderer';
export { resolveConkeyref } from './editor/conkeyref';
export { collectMapKeys, isKeyContextAvailable, keySourceMaps, qualifiedNames, qualifiedNamesMulti } from './editor/keySpace';
export { DEFAULT_NOTE_LABELS, IMAGE_DIMENSIONS_CACHE_MAX, URL_SCHEME_RE, ZH_NOTE_LABELS, clearImageDimensionsCache, detectIndexLabel, detectNoteLabels, expandDitamapRefs, makeConrefRangeResolver, makeConrefResolver, makeFileCache, makeFileTitleResolver, makeIsInCurrentBook, readImageDimensions } from './editor/refResolvers';
export type { FileReader } from './editor/refResolvers';
export { buildRenderContext } from './editor/renderContext';
export { clearAllSourceOverlays, dependsOn, noteSourceDependencies, sourceOverlaySize, sourceStamp, trackSourceReads } from './editor/sourceText';
export { TOPIC_RENDER_CACHE_MAX_BYTES, clearTopicRenderCache, collectText, renderTopicCached, renderTopicToHtml, setTopicRenderCacheBudgetForTesting, stampFiles, topicRenderCacheBytesHeld, topicRenderCacheSize } from './editor/topicRender';
export { collectMapSymbols, collectTopicSymbols, collectUnknownElements, findConrefTargetOffset, findEnclosingKeydefKeys, findIdAttrAt, findKeyDefinitionOffset, findKeysAttrAt, findRefAttrAt, findUnclosedTag, getAttributesForTag, getAutoCloseTag, getCloseTagCompletion, getCompletionContext, getMapRefName, stripSameDocumentFragmentPrefix } from './language/ditaLanguageUtils';
export type { DocSymbolSpec } from './language/ditaLanguageUtils';

/**
 * Host tokens the stylesheet reads (styles/dita-content.css). A host defines
 * these on the element that carries the rendered content; styles/TOKENS.md
 * says what each one means.
 */
export const HOST_TOKENS = [
  '--dita-fg',
  '--dita-fg-muted',
  '--dita-bg',
  '--dita-bg-elevated',
  '--dita-border',
  '--dita-focus',
  '--dita-hover-bg',
  '--dita-selected-fg',
  '--dita-link',
  '--dita-code-bg',
  '--dita-code-inline-bg',
  '--dita-font',
] as const;
