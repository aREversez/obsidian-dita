// What the wrap and insert pickers offer.
//
// Kept apart from snippets.ts so the template text is easy to find and change:
// the logic there only knows about {{caret}} and indentation.

export interface WrapSpec {
  id: string;
  /** Shown in the picker. */
  name: string;
  open: string;
  close: string;
}

export interface StructureSpec {
  id: string;
  name: string;
  /** `\n`-separated source with `{{caret}}` where the caret goes. */
  template: string;
}

/** Inline elements, most used first. */
export const WRAPS: readonly WrapSpec[] = [
  { id: 'b', name: 'Bold (<b>)', open: '<b>', close: '</b>' },
  { id: 'i', name: 'Italic (<i>)', open: '<i>', close: '</i>' },
  { id: 'u', name: 'Underline (<u>)', open: '<u>', close: '</u>' },
  { id: 'codeph', name: 'Code phrase (<codeph>)', open: '<codeph>', close: '</codeph>' },
  { id: 'cmd', name: 'Command (<cmd>)', open: '<cmd>', close: '</cmd>' },
  { id: 'filepath', name: 'File path (<filepath>)', open: '<filepath>', close: '</filepath>' },
  { id: 'userinput', name: 'User input (<userinput>)', open: '<userinput>', close: '</userinput>' },
  { id: 'term', name: 'Term (<term>)', open: '<term>', close: '</term>' },
  { id: 'ph', name: 'Phrase (<ph>)', open: '<ph>', close: '</ph>' },
  { id: 'q', name: 'Quotation (<q>)', open: '<q>', close: '</q>' },
];

export const STRUCTURES: readonly StructureSpec[] = [
  {
    id: 'step',
    name: 'Step',
    template: '<step>\n  <cmd>{{caret}}</cmd>\n</step>',
  },
  {
    id: 'note',
    name: 'Note',
    template: '<note>\n  <p>{{caret}}</p>\n</note>',
  },
  {
    id: 'table',
    name: 'Table (two columns)',
    template: [
      '<table>',
      '  <title>{{caret}}</title>',
      '  <tgroup cols="2">',
      '    <thead>',
      '      <row>',
      '        <entry></entry>',
      '        <entry></entry>',
      '      </row>',
      '    </thead>',
      '    <tbody>',
      '      <row>',
      '        <entry></entry>',
      '        <entry></entry>',
      '      </row>',
      '    </tbody>',
      '  </tgroup>',
      '</table>',
    ].join('\n'),
  },
  {
    id: 'ul',
    name: 'Unordered list',
    template: '<ul>\n  <li>{{caret}}</li>\n</ul>',
  },
];
