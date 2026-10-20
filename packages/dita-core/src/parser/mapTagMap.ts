export const MAP_STANDARD_TAG_TO_BASETYPE: Record<string, string> = {
  // Root
  map: 'map/map',

  // BookMap root (specializes map)
  bookmap: 'map/map',

  // Metadata within topicmeta
  title: 'map/map-title',
  topicmeta: 'map/topicmeta',
  navtitle: 'map/navtitle',
  linktext: 'map/linktext',
  shortdesc: 'map/shortdesc',
  keywords: 'map/keywords',
  keyword: 'map/keyword',

  // BookMap title structure (specializes map/title)
  booktitle: 'map/map-title',
  mainbooktitle: 'map/map-title',
  booktitlealt: 'map/map-title',
  subtitle: 'map/map-title',

  // BookMap metadata (specializes topicmeta)
  bookmeta: 'map/topicmeta',

  // Topic references
  topicref: 'map/topicref',
  topichead: 'map/topichead',
  topicgroup: 'map/topicgroup',
  keydef: 'map/keydef',

  // BookMap topicref specializations
  chapter: 'map/topicref',
  appendix: 'map/topicref',
  part: 'map/topicref',
  preface: 'map/topicref',
  notices: 'map/topicref',
  draftintro: 'map/topicref',
  glossaryref: 'map/topicref',
  dedication: 'map/topicref',
  colophon: 'map/topicref',
  bookabstract: 'map/topicref',
  amendments: 'map/topicref',

  // BookMap structural containers — rendered as visible labels in tree view,
  // children pass through at same depth for book view entry collection
  frontmatter: 'map/bookmap-structural',
  backmatter: 'map/bookmap-structural',
  booklists: 'map/bookmap-structural',
  toc: 'map/bookmap-structural',
  figurelist: 'map/bookmap-structural',
  tablelist: 'map/bookmap-structural',
  indexlist: 'map/bookmap-structural',
  glossarylist: 'map/bookmap-structural',
  abbrevlist: 'map/bookmap-structural',
  bibliolist: 'map/bookmap-structural',
  trademarklist: 'map/bookmap-structural',

  // Reltable
  reltable: 'map/reltable',
  relheader: 'map/relheader',
  relrow: 'map/relrow',
  relcell: 'map/relcell',
  relcolspec: 'map/relcolspec',

  // Other
  anchor: 'map/anchor',
  navref: 'map/navref',
  mapref: 'map/mapref',

  // ── ditavalref domain ── Evidence: base/dtd/ditavalrefDomain.mod ──
  // class "+ map/topicref ditavalref-d/ditavalref" → first pair map/topicref
  ditavalref: 'map/topicref',
  // class "+ map/topicmeta ditavalref-d/ditavalmeta" → map/topicmeta
  ditavalmeta: 'map/topicmeta',

  // ── mapGroup domain ── Evidence: base/dtd/mapGroup.mod ──
  anchorref: 'map/topicref',
  topicset: 'map/topicref',
  topicsetref: 'map/topicref',

  // ── glossref domain ── Evidence: technicalContent/dtd/glossrefDomain.mod ──
  // class "+ map/topicref glossref-d/glossref" → map/topicref
  glossref: 'map/topicref',

  // ── BookMap division/list wrappers (topicref specializations) ──
  // Evidence: bookmap/dtd/bookmap.mod — class "- map/topicref bookmap/..."
  appendices: 'map/topicref',
  booklist: 'map/topicref',
};
