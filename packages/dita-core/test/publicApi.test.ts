import { strict as assert } from 'assert';
import * as core from '../src/index';
// Type-only: fails the build, not just the run, if a type the extension needs stops being exported.
import type { DitaDocument, DitaNode, DocSymbolSpec, FileReader, RenderContext, SourceRange } from '../src/index';

describe('public API', () => {
  // What the VS Code viewer imports from the modules it copied. If one of these
  // goes missing the extension cannot depend on this package instead of copying.
  const needed = [
    'parseDita',
    'parseDitamap',
    'preprocessEntities',
    'STANDARD_TAG_TO_BASETYPE',
    'MAP_STANDARD_TAG_TO_BASETYPE',
    'renderDocument',
    'renderElement',
    'collectIndextermChips',
    'findTopLevelIndextermsInSubtree',
    'createBookRoleLabeler',
    'extractText',
    'getDisplayNameInfo',
    'isDitamapRef',
    'renderMapDocument',
    'isExternalRef',
    'BASE_TYPE_RENDERERS',
    'DEFAULT_NOTE_LABELS',
    'IMAGE_DIMENSIONS_CACHE_MAX',
    'TOPIC_RENDER_CACHE_MAX_BYTES',
    'URL_SCHEME_RE',
    'ZH_NOTE_LABELS',
    'buildRenderContext',
    'clearAllSourceOverlays',
    'clearImageDimensionsCache',
    'clearTopicRenderCache',
    'collectMapKeys',
    'collectMapSymbols',
    'collectText',
    'collectTopicSymbols',
    'collectUnknownElements',
    'computeKeyrefSpacing',
    'dependsOn',
    'detectIndexLabel',
    'detectNoteLabels',
    'expandDitamapRefs',
    'findConrefTargetOffset',
    'findEnclosingKeydefKeys',
    'findIdAttrAt',
    'findKeyDefinitionOffset',
    'findKeysAttrAt',
    'findRefAttrAt',
    'findUnclosedTag',
    'getAttributesForTag',
    'getAutoCloseTag',
    'getCloseTagCompletion',
    'getCompletionContext',
    'getMapRefName',
    'isKeyContextAvailable',
    'keySourceMaps',
    'lookupNamedEntity',
    'makeConrefRangeResolver',
    'makeConrefResolver',
    'makeFileCache',
    'makeFileTitleResolver',
    'makeIsInCurrentBook',
    'mergeProfilingAttrs',
    'needsSpace',
    'noteSourceDependencies',
    'profilingChipsHtml',
    'profilingKeysAttr',
    'qualifiedNames',
    'qualifiedNamesMulti',
    'readImageDimensions',
    'renderTopicCached',
    'renderTopicToHtml',
    'resolveConkeyref',
    'setTopicRenderCacheBudgetForTesting',
    'sourceOverlaySize',
    'sourceStamp',
    'stampFiles',
    'stripSameDocumentFragmentPrefix',
    'topicRenderCacheBytesHeld',
    'topicRenderCacheSize',
    'trackSourceReads',
  ] as const;

  it('exports every parser and renderer entry point the VS Code viewer uses', () => {
    for (const name of needed) assert.ok(name in core && (core as Record<string, unknown>)[name] !== undefined, `${name} is not exported`);
  });

  it('parses and renders through the exported functions alone', () => {
    const doc: DitaDocument = core.parseDita(core.preprocessEntities('<topic id="t"><title>T</title><body><p>Hi</p></body></topic>'));
    const root: DitaNode = doc.root;
    const range: SourceRange = doc.sourceRange;
    assert.equal(typeof range.startLine, 'number');
    assert.ok(root.children.length > 0);
    assert.equal(core.parseDitamap('<map><topicref href="a.dita"/></map>').root.type, 'element');
    assert.equal(core.isDitamapRef(root), false);
    assert.equal(core.isExternalRef('https://example.com'), true);
    assert.equal(core.isExternalRef('topic.dita'), false);
    assert.equal(core.STANDARD_TAG_TO_BASETYPE.p, 'topic/p');
    assert.equal(core.MAP_STANDARD_TAG_TO_BASETYPE.topicref, 'map/topicref');
    // RenderContext is only named here, so a rename or removal is a compile error.
    const unused: RenderContext | DocSymbolSpec | FileReader | undefined = undefined;
    assert.equal(unused, undefined);
  });
});
