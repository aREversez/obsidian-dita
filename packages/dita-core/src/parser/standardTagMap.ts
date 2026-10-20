export const STANDARD_TAG_TO_BASETYPE: Record<string, string> = {
  // Root & structure
  topic: 'topic/topic',
  title: 'topic/title',
  shortdesc: 'topic/shortdesc',
  prolog: 'topic/prolog',
  body: 'topic/body',
  section: 'topic/section',
  example: 'topic/example',

  // Paragraphs & notes
  p: 'topic/p',
  note: 'topic/note',

  // Lists
  ul: 'topic/ul',
  ol: 'topic/ol',
  li: 'topic/li',
  sl: 'topic/sl',
  sli: 'topic/sli',

  // Definition lists
  dl: 'topic/dl',
  dlentry: 'topic/dlentry',
  dt: 'topic/dt',
  dd: 'topic/dd',

  // Complex table (CALS)
  table: 'topic/table',
  tgroup: 'topic/tgroup',
  colspec: 'topic/colspec',
  thead: 'topic/thead',
  tbody: 'topic/tbody',
  row: 'topic/row',
  entry: 'topic/entry',

  // Simple table
  simpletable: 'topic/simpletable',
  sthead: 'topic/sthead',
  strow: 'topic/strow',
  stentry: 'topic/stentry',

  // Media
  image: 'topic/image',
  fig: 'topic/fig',

  // Code & preformatted
  codeblock: 'topic/codeblock',
  pre: 'topic/pre',

  // Links
  xref: 'topic/xref',
  link: 'topic/link',
  linktext: 'topic/linktext',
  'related-links': 'topic/related-links',

  // Inline formatting
  b: 'topic/b',
  i: 'topic/i',
  u: 'topic/u',
  tt: 'topic/tt',
  sup: 'topic/sup',
  sub: 'topic/sub',

  // Quotes
  q: 'topic/q',
  lq: 'topic/lq',

  // Semantic inline
  keyword: 'topic/keyword',
  term: 'topic/term',

  // UI & interaction
  uicontrol: 'topic/uicontrol',
  wintitle: 'topic/wintitle',
  menucascade: 'topic/menucascade',

  // Computer interaction
  filepath: 'topic/filepath',
  userinput: 'topic/userinput',
  systemoutput: 'topic/systemoutput',

  // API & code references
  apiname: 'topic/apiname',
  option: 'topic/option',
  parmname: 'topic/parmname',
  cmdname: 'topic/cmdname',
  varname: 'topic/varname',
  msgnum: 'topic/msgnum',

  // Misc
  ph: 'topic/ph',
  'draft-comment': 'topic/draft-comment',
  'required-cleanup': 'topic/required-cleanup',
  data: 'topic/data',
  'data-about': 'topic/data-about',
  foreign: 'topic/foreign',
  state: 'topic/state',

  // Programming domain (missing)
  codeph: 'topic/codeph',
  coderef: 'topic/coderef',
  synph: 'topic/synph',
  kwd: 'topic/kwd',
  var: 'topic/var',
  oper: 'topic/oper',
  sep: 'topic/sep',
  delim: 'topic/delim',
  fragment: 'topic/fragment',
  fragref: 'topic/fragref',
  synblk: 'topic/synblk',
  synnote: 'topic/synnote',
  synnoteref: 'topic/synnoteref',
  syntaxdiagram: 'topic/syntaxdiagram',

  // Software domain
  screen: 'topic/screen',
  msgph: 'topic/msgph',
  msgblock: 'topic/msgblock',

  // Common body elements
  lines: 'topic/lines',
  fn: 'topic/fn',
  cite: 'topic/cite',
  boolean: 'topic/boolean',
  tm: 'topic/tm',
  indexterm: 'topic/indexterm',
  indextermref: 'topic/indextermref',
  'index-see': 'topic/index-see',
  'index-see-also': 'topic/index-see-also',
  'index-sort-as': 'topic/index-sort-as',
  'index-base': 'topic/index-base',
  div: 'topic/div',
  sectiondiv: 'topic/sectiondiv',
  bodydiv: 'topic/bodydiv',
  desc: 'topic/desc',
  alt: 'topic/alt',

  // Parameter lists
  parml: 'topic/parml',
  plentry: 'topic/plentry',
  pt: 'topic/pt',
  pd: 'topic/pd',

  // Abbreviation & glossary
  'abbreviated-form': 'topic/abbreviated-form',
  glossterm: 'topic/glossterm',
  glossdef: 'topic/glossdef',
  glossentry: 'topic/glossentry',
  glossref: 'topic/glossref',
  glossgroup: 'topic/glossgroup',

  // Hazard
  hazardstatement: 'topic/hazardstatement',
  typeofhazard: 'topic/typeofhazard',
  hazardsymbol: 'topic/hazardsymbol',
  howtoavoid: 'topic/howtoavoid',
  consequence: 'topic/consequence',

  // Multimedia
  object: 'topic/object',
  param: 'topic/param',

  // Anchors
  anchor: 'topic/anchor',
  anchorid: 'topic/anchorid',
  anchorkey: 'topic/anchorkey',
  anchorref: 'topic/anchorref',

  // Task module (mapped to the topic/* ancestor of the spec class chain,
  // e.g. steps = "- topic/ol task/steps " -> topic/ol)
  task: 'topic/topic',
  taskbody: 'topic/body',
  prereq: 'topic/section',
  context: 'topic/section',
  steps: 'topic/ol',
  'steps-unordered': 'topic/ul',
  'steps-informal': 'topic/section',
  step: 'topic/li',
  stepsection: 'topic/li',
  cmd: 'topic/ph',
  info: 'topic/itemgroup',
  substeps: 'topic/ol',
  substep: 'topic/li',
  tutorialinfo: 'topic/itemgroup',
  stepxmp: 'topic/itemgroup',
  stepresult: 'topic/itemgroup',
  steptroubleshooting: 'topic/itemgroup',
  choices: 'topic/ul',
  choice: 'topic/li',
  choicetable: 'topic/simpletable',
  chhead: 'topic/sthead',
  chrow: 'topic/strow',
  choptionhd: 'topic/stentry',
  chdeschd: 'topic/stentry',
  choption: 'topic/stentry',
  chdesc: 'topic/stentry',
  result: 'topic/section',
  tasktroubleshooting: 'topic/section',
  postreq: 'topic/section',

  // Concept module
  concept: 'topic/topic',
  conbody: 'topic/body',
  conbodydiv: 'topic/bodydiv',

  // Reference module
  reference: 'topic/topic',
  refbody: 'topic/body',
  refbodydiv: 'topic/bodydiv',
  refsyn: 'topic/section',
  properties: 'topic/simpletable',
  prophead: 'topic/sthead',
  property: 'topic/strow',
  proptypehd: 'topic/stentry',
  propvaluehd: 'topic/stentry',
  propdeschd: 'topic/stentry',
  proptype: 'topic/stentry',
  propvalue: 'topic/stentry',
  propdesc: 'topic/stentry',

  // ── Highlight domain additions (element-specific baseType + renderer, ──
  // matching the existing b/i/u convention so distinct visual styling is ──
  // preserved even when the class attribute is omitted from the XML). ──
  // Evidence: base/dtd/highlightDomain.mod — class "+ topic/ph hi-d/line-through "
  'line-through': 'topic/line-through',
  // Evidence: base/dtd/highlightDomain.mod — class "+ topic/ph hi-d/overline "
  overline: 'topic/overline',

  // ── Equation domain ── baseType = first pair of the class chain ──
  // Evidence: technicalContent/dtd/equationDomain.mod
  'equation-inline': 'topic/ph',
  'equation-block': 'topic/div',
  'equation-number': 'topic/ph',
  'equation-figure': 'topic/fig',

  // ── Troubleshooting module ── Evidence: technicalContent/dtd/troubleshooting.mod
  troubleshooting: 'topic/topic',
  troublebody: 'topic/body',
  troubleSolution: 'topic/bodydiv',
  cause: 'topic/section',
  condition: 'topic/section',
  remedy: 'topic/section',
  responsibleParty: 'topic/p',

  // ── Glossentry module ── Evidence: technicalContent/dtd/glossentry.mod
  glossBody: 'topic/body',
  glossAbbreviation: 'topic/title',
  glossAcronym: 'topic/title',
  glossShortForm: 'topic/title',
  glossSynonym: 'topic/title',
  glossPartOfSpeech: 'topic/data',
  glossProperty: 'topic/data',
  glossStatus: 'topic/data',
  glossAlt: 'topic/section',
  glossAlternateFor: 'topic/xref',
  glossScopeNote: 'topic/note',
  glossSurfaceForm: 'topic/p',
  glossSymbol: 'topic/image',
  glossUsage: 'topic/note',

  // ── Task requirements domain (taskreq-d) ── ──
  // Evidence: technicalContent/dtd/taskreqDomain.mod — each class chain's ──
  // first pair is the topic/* ancestor (section/ul/ol/li/p/data). ──
  prelreqs: 'topic/section',
  closereqs: 'topic/section',
  reqconds: 'topic/ul',
  noconds: 'topic/li',
  reqcond: 'topic/li',
  reqcontp: 'topic/li',
  reqpers: 'topic/ul',
  personnel: 'topic/li',
  perscat: 'topic/li',
  perskill: 'topic/li',
  esttime: 'topic/li',
  supequip: 'topic/p',
  nosupeq: 'topic/data',
  supeqli: 'topic/ul',
  supequi: 'topic/li',
  supplies: 'topic/p',
  nosupply: 'topic/data',
  supplyli: 'topic/ul',
  supply: 'topic/li',
  spares: 'topic/p',
  nospares: 'topic/data',
  sparesli: 'topic/ul',
  spare: 'topic/li',
  safety: 'topic/ol',
  nosafety: 'topic/li',
  safecond: 'topic/li',

  // ── Delay-resolution domain (delay-d) ──
  // Evidence: base/dtd/delayResolutionDomain.mod:94 — class
  // "+ topic/keywords delay-d/exportanchors". exportanchors always lives
  // inside <prolog>, so it never renders on its own (see topic/prolog
  // suppression in baseTypeMap.ts) — mapped here for baseType correctness.
  exportanchors: 'topic/keywords',

  // ── Ditavalref domain (ditavalref-d) ──
  // Evidence: base/dtd/ditavalrefDomain.mod:163-166
  dvrResourcePrefix: 'topic/data',
  dvrResourceSuffix: 'topic/data',
  dvrKeyscopePrefix: 'topic/data',
  dvrKeyscopeSuffix: 'topic/data',

  // ── Hazard statement domain (additional) ──
  // Evidence: base/dtd/hazardstatementDomain.mod:233
  messagepanel: 'topic/ul',

  // ── Utilities domain (image maps) ──
  // Evidence: base/dtd/utilitiesDomain.mod:151-155 — class
  // "+ topic/fig ut-d/imagemap ", "+ topic/figgroup ut-d/area ",
  // "+ topic/keyword ut-d/shape ", "+ topic/ph ut-d/coords ".
  //
  // imagemap/area deliberately get their OWN baseTypes rather than their
  // topic ancestors: mapping imagemap → topic/fig made the generic fig
  // renderer dump every child (including the area groups) straight into
  // the page, and figgroup rendered each <area>'s shape/coords/xref as
  // visible text while never producing the HTML <map>/<area> structure
  // that makes the image clickable at all. Dedicated baseTypes carry
  // dedicated renderers (see baseTypeMap.ts) that build the real
  // <img usemap> + <map><area shape coords href></map> output.
  //
  // shape/coords follow the index-see/index-see-also convention: their
  // text is authoring metadata consumed directly by the parent <area>
  // renderer (which reads the parsed nodes itself), so a standalone
  // visit — only reachable through malformed markup — renders nothing
  // rather than leaking "rect" / "0,0,10,10" into the page.
  imagemap: 'topic/imagemap',
  area: 'topic/area',
  shape: 'topic/shape',
  coords: 'topic/coords',
  'sort-as': 'topic/data',

  // ── Markup domain ──
  // Evidence: technicalContent/dtd/markupDomain.mod:45
  markupname: 'topic/keyword',

  // ── MathML domain ──
  // Evidence: technicalContent/dtd/mathmlDomain.mod:89-90
  mathml: 'topic/foreign',
  mathmlref: 'topic/xref',

  // ── Programming domain (grouping elements) ──
  // Evidence: technicalContent/dtd/programmingDomain.mod:677-679,688
  groupchoice: 'topic/figgroup',
  groupcomp: 'topic/figgroup',
  groupseq: 'topic/figgroup',
  repsep: 'topic/ph',

  // ── Release-management domain (relmgmt-d) ──
  // Evidence: technicalContent/dtd/releaseManagementDomain.mod:231-241.
  // change-historylist always lives inside <prolog> like exportanchors above.
  'change-historylist': 'topic/metadata',
  'change-item': 'topic/data',
  'change-person': 'topic/data',
  'change-organization': 'topic/data',
  'change-revisionid': 'topic/data',
  'change-request-reference': 'topic/data',
  'change-request-system': 'topic/data',
  'change-request-id': 'topic/data',
  'change-started': 'topic/data',
  'change-completed': 'topic/data',
  'change-summary': 'topic/data',

  // ── SVG domain ──
  // Evidence: technicalContent/dtd/svgDomain.mod:70-71
  'svg-container': 'topic/foreign',
  svgref: 'topic/xref',

  // ── UI domain (additional) ──
  // Evidence: technicalContent/dtd/uiDomain.mod:158
  shortcut: 'topic/keyword',

  // ── XML domain ──
  // Evidence: technicalContent/dtd/xmlDomain.mod:154-160
  numcharref: 'topic/keyword',
  parameterentity: 'topic/keyword',
  textentity: 'topic/keyword',
  xmlatt: 'topic/keyword',
  xmlelement: 'topic/keyword',
  xmlnsname: 'topic/keyword',
  xmlpi: 'topic/keyword',

  // ── Bookmap metadata fields ──
  // Evidence: bookmap/dtd/bookmap.mod:1204-1259. These are front-matter
  // metadata (copyright/publisher/revision info), not body content — no
  // dedicated visual treatment needed, generic topic/data|ph|title covers
  // them the same way it already covers the rest of the bookmeta block.
  approved: 'topic/data',
  bookchangehistory: 'topic/data',
  bookevent: 'topic/data',
  bookeventtype: 'topic/data',
  bookid: 'topic/data',
  booklibrary: 'topic/ph',
  booknumber: 'topic/data',
  bookowner: 'topic/data',
  bookpartno: 'topic/data',
  bookrestriction: 'topic/data',
  bookrights: 'topic/data',
  // NOTE: booktitle/booktitlealt/mainbooktitle already have dedicated,
  // real-world-tested entries in mapTagMap.ts (all → 'map/map-title', added
  // 2026-07-28 with the BookMap feature, driving the book title-page
  // renderer). A real .bookmap file always goes through parseDitamap, which
  // only consults mapTagMap.ts — so these three topic-side entries below
  // are DTD-correct but effectively unreachable for actual bookmap
  // documents; they only matter if parseDita ever sees one of these tags
  // outside a bookmap context.
  booktitle: 'topic/title',
  booktitlealt: 'topic/ph',
  completed: 'topic/ph',
  copyrfirst: 'topic/data',
  copyrlast: 'topic/data',
  day: 'topic/ph',
  edited: 'topic/data',
  edition: 'topic/data',
  isbn: 'topic/data',
  mainbooktitle: 'topic/ph',
  maintainer: 'topic/data',
  month: 'topic/ph',
  organization: 'topic/data',
  person: 'topic/data',
  printlocation: 'topic/data',
  published: 'topic/data',
  // publisherinformation always lives inside <prolog>/bookmeta like
  // exportanchors/change-historylist above.
  publisherinformation: 'topic/publisher',
  publishtype: 'topic/data',
  reviewed: 'topic/data',
  revisionid: 'topic/ph',
  started: 'topic/ph',
  summary: 'topic/ph',
  tested: 'topic/data',
  volume: 'topic/data',
  year: 'topic/ph',

};
