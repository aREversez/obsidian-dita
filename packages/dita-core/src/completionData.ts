// What the completion engine knows about DITA, as data.
//
// CHILD_HINTS says which elements are the usual children of a parent. It is a
// ranking aid, not a content model: every known element is still offered
// everywhere, and a hinted one is merely listed first. A wrong or missing
// entry therefore costs a suggestion's position, never its availability, which
// is why this can be a curated table rather than a copy of the DTDs.
//
// Entries follow the DITA 1.3 technical-content and map vocabularies. Order is
// the order the suggestions appear in.

const INLINE = [
  'ph', 'codeph', 'keyword', 'term', 'xref', 'b', 'i', 'u', 'tt', 'sup', 'sub',
  'uicontrol', 'menucascade', 'userinput', 'systemoutput', 'varname', 'filepath',
  'cmdname', 'apiname', 'parmname', 'option', 'image', 'q', 'indexterm', 'fn',
  'data', 'tm', 'cite', 'abbreviated-form', 'xmlelement', 'xmlatt', 'msgph',
  'wintitle', 'shortcut', 'synph',
];

const BLOCKS = [
  'p', 'ul', 'ol', 'dl', 'note', 'table', 'simpletable', 'fig', 'codeblock',
  'pre', 'lines', 'lq', 'sl', 'image', 'object', 'div', 'hazardstatement',
  'draft-comment', 'required-cleanup', 'foreign', 'data',
];

const BODY = ['p', 'section', 'example', 'ul', 'ol', 'dl', 'note', 'table', 'simpletable', 'fig', 'codeblock', 'pre', 'lines', 'lq', 'sl', 'image', 'div', 'bodydiv', 'sectiondiv', 'hazardstatement', 'object', 'foreign', 'data', 'draft-comment', 'required-cleanup', 'fn', 'indexterm'];

const MIXED = [...new Set([...BLOCKS, ...INLINE])];

const TITLED_SECTION = ['title', ...BLOCKS];

const TOPIC_PARTS = ['title', 'titlealts', 'shortdesc', 'abstract', 'prolog'];

const MAP_REF_CHILDREN = ['topicmeta', 'topicref', 'keydef', 'mapref', 'topicgroup', 'topichead'];

export const CHILD_HINTS: Readonly<Record<string, readonly string[]>> = {
  // Topic roots
  concept: [...TOPIC_PARTS, 'conbody', 'related-links'],
  task: [...TOPIC_PARTS, 'taskbody', 'related-links'],
  reference: [...TOPIC_PARTS, 'refbody', 'related-links'],
  topic: [...TOPIC_PARTS, 'body', 'related-links'],
  glossentry: ['glossterm', 'glossdef', 'glossBody', 'prolog'],
  troubleshooting: [...TOPIC_PARTS, 'troublebody', 'related-links'],
  // Bodies
  body: BODY,
  conbody: BODY,
  refbody: ['section', 'refsyn', 'properties', 'table', 'simpletable', 'example', 'dl', 'p', 'ul', 'ol', 'note', 'codeblock'],
  taskbody: ['prereq', 'context', 'steps', 'steps-unordered', 'steps-informal', 'result', 'example', 'postreq', 'section'],
  troublebody: ['condition', 'troubleSolution', 'section', 'example'],
  section: TITLED_SECTION,
  example: TITLED_SECTION,
  sectiondiv: BLOCKS,
  bodydiv: BODY,
  div: MIXED,
  prereq: BLOCKS,
  context: BLOCKS,
  result: BLOCKS,
  postreq: BLOCKS,
  // Task steps
  steps: ['step', 'stepsection'],
  'steps-unordered': ['step', 'stepsection'],
  step: ['cmd', 'info', 'substeps', 'stepxmp', 'choices', 'choicetable', 'stepresult', 'steptroubleshooting', 'tutorialinfo'],
  substeps: ['substep'],
  substep: ['cmd', 'info', 'stepxmp', 'choices', 'choicetable', 'stepresult'],
  choices: ['choice'],
  // Lists
  ul: ['li'],
  ol: ['li'],
  sl: ['sli'],
  dl: ['dlhead', 'dlentry'],
  dlentry: ['dt', 'dd'],
  dlhead: ['dthd', 'ddhd'],
  li: MIXED,
  dd: MIXED,
  sli: INLINE,
  // Tables
  table: ['title', 'desc', 'tgroup'],
  tgroup: ['colspec', 'thead', 'tbody'],
  thead: ['row'],
  tbody: ['row'],
  row: ['entry'],
  entry: MIXED,
  simpletable: ['sthead', 'strow'],
  sthead: ['stentry'],
  strow: ['stentry'],
  stentry: MIXED,
  // Figures and blocks that hold mixed content
  fig: ['title', 'desc', 'image', 'figgroup', 'codeblock', 'pre', 'lines', 'simpletable', 'table'],
  note: MIXED,
  p: INLINE,
  title: INLINE,
  shortdesc: INLINE,
  desc: INLINE,
  cmd: INLINE,
  info: MIXED,
  lq: MIXED,
  // Metadata
  prolog: ['author', 'source', 'publisher', 'copyright', 'critdates', 'permissions', 'metadata', 'resourceid', 'data'],
  metadata: ['audience', 'category', 'keywords', 'prodinfo', 'othermeta', 'data'],
  keywords: ['keyword', 'indexterm'],
  prodinfo: ['prodname', 'vrmlist', 'brand', 'component', 'featnum', 'prognum', 'platform', 'series'],
  'related-links': ['link', 'linklist', 'linkpool'],
  link: ['linktext', 'desc'],
  linklist: ['title', 'desc', 'link', 'linklist'],
  // Maps
  map: ['title', 'topicmeta', 'topicref', 'topichead', 'topicgroup', 'keydef', 'mapref', 'reltable', 'anchor', 'navref', 'topicset', 'data'],
  bookmap: ['booktitle', 'bookmeta', 'frontmatter', 'chapter', 'part', 'appendices', 'appendix', 'backmatter', 'reltable'],
  booktitle: ['mainbooktitle', 'booktitlealt'],
  topicref: MAP_REF_CHILDREN,
  topichead: MAP_REF_CHILDREN,
  topicgroup: ['topicref', 'topichead', 'keydef', 'mapref', 'topicmeta'],
  chapter: MAP_REF_CHILDREN,
  part: [...MAP_REF_CHILDREN, 'chapter'],
  appendix: MAP_REF_CHILDREN,
  appendices: ['appendix', 'topicmeta'],
  keydef: ['topicmeta', 'topicref'],
  mapref: ['topicmeta'],
  topicmeta: ['navtitle', 'linktext', 'shortdesc', 'keywords', 'data', 'othermeta', 'searchtitle', 'resourceid', 'author'],
  reltable: ['relheader', 'relrow'],
  relheader: ['relcolspec'],
  relrow: ['relcell'],
  relcolspec: ['topicref'],
  relcell: ['topicref'],
};

/** Roots offered where no element is open yet. */
export const ROOT_HINTS = {
  topic: ['concept', 'task', 'reference', 'topic', 'glossentry', 'troubleshooting'],
  map: ['map', 'bookmap'],
} as const;

/** Values for enumerated attributes. A `tag:attr` key outranks a bare `attr`. */
export const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  'note:type': ['note', 'tip', 'important', 'caution', 'warning', 'danger', 'attention', 'remember', 'restriction', 'fastpath', 'trouble', 'notice', 'other'],
  scope: ['local', 'peer', 'external'],
  format: ['dita', 'ditamap', 'html', 'pdf', 'xml', 'txt'],
  'processing-role': ['normal', 'resource-only'],
  toc: ['yes', 'no'],
  print: ['yes', 'no', 'printonly'],
  search: ['yes', 'no'],
  locktitle: ['yes', 'no'],
  linking: ['normal', 'targetonly', 'sourceonly', 'none'],
  'collection-type': ['unordered', 'sequence', 'choice', 'family'],
  type: ['fn', 'section', 'table', 'fig', 'li', 'step', 'topic', 'concept', 'task', 'reference'],
  placement: ['inline', 'break'],
  align: ['left', 'right', 'center', 'current', 'justify'],
  valign: ['top', 'middle', 'bottom'],
  frame: ['all', 'bottom', 'none', 'sides', 'top', 'topbot'],
  colsep: ['0', '1'],
  rowsep: ['0', '1'],
  pgwide: ['0', '1'],
  importance: ['obsolete', 'deprecated', 'optional', 'default', 'low', 'normal', 'high', 'recommended', 'required', 'urgent'],
  status: ['new', 'changed', 'deleted', 'unchanged'],
  translate: ['yes', 'no', '-dita-use-conref-target'],
  'xml:lang': ['en-US', 'en-GB', 'zh-CN', 'zh-TW', 'ja-JP', 'ko-KR', 'de-DE', 'fr-FR', 'es-ES', 'ru-RU'],
};

/** Attributes whose value is a path, and which kind of file it names. */
export const FILE_ATTRS: Readonly<Record<string, 'topic' | 'image'>> = {
  href: 'topic',
  conref: 'topic',
  conrefend: 'topic',
};

/** Elements whose `href` points at an image or other binary rather than a topic. */
export const IMAGE_HREF_TAGS: ReadonlySet<string> = new Set(['image', 'object', 'imagemap']);

export const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|tiff?|ico|emf)$/i;
