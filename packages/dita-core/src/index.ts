// Public surface of @dita-viewer/core.
//
// Hosts (the Obsidian plugin, and in time the VS Code extension) render DITA
// through these exports only. Everything under ./parser, ./render and ./editor
// is a verbatim copy of the VS Code DITA Viewer sources (see README), so a
// change there should be made upstream and re-synced, not edited here.

export { renderTopicXml, buildTitleMap, collectDitamapFilesUpward } from './editor/topicRender';
export type { TopicXmlRenderInput, TopicRenderInput, TopicRenderResult, ParsedTopicResult } from './editor/topicRender';
export { buildKeySpace } from './editor/keySpace';
export { readSourceText, setSourceOverlay, clearSourceOverlay } from './editor/sourceText';
export { decodeHrefPart } from './editor/refResolvers';
export { buildKeyMapForDocument } from './keyMapForDocument';
export type { KeyMapOptions } from './keyMapForDocument';

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
