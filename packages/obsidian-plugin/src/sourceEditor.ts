// The XML source editor: a CodeMirror 6 view that takes its look from the
// active Obsidian theme.
//
// Obsidian bundles CodeMirror and provides @codemirror/state, view, language,
// commands, search and autocomplete (and @lezer/highlight) at runtime; the
// bundle keeps them external so this editor shares one copy of each with the
// app. Only @codemirror/lang-xml is bundled.
//
// Theme handling follows the same rule as the preview: no colour is written
// here, every one is an Obsidian variable (--code-*, --text-*, --background-*,
// --font-monospace), so the editor changes with the theme.

import { Annotation, EditorState, Extension } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { bracketMatching, HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { CompletionSource, autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';
import { xml } from '@codemirror/lang-xml';
import { minimalReplacement } from './textDiff';

export interface SourceEditorOptions {
  text: string;
  /** The user changed the document (not a programmatic load). */
  onChange: (text: string) => void;
  /** The editor scrolled. */
  onScroll: () => void;
  /** The caret moved to another line, by typing or navigation. 0-based line. */
  onCursorLine: (line: number) => void;
  /** Tag, attribute and value completion. */
  completion?: CompletionSource;
}

export interface SourceEditor {
  readonly view: EditorView;
  getText(): string;
  /** Replace the text from outside (file loaded, or changed on disk). `resetHistory` for a different file. */
  load(text: string, resetHistory: boolean): void;
  /** Source position at the top of the viewport: 0-based line plus the fraction of it scrolled past. */
  topLine(): number;
  /** Move the caret to a 0-based line/column and bring it into view. */
  reveal(line: number, col: number): void;
  /** Call after the editor's container goes from hidden to visible. */
  remeasure(): void;
  focus(): void;
  destroy(): void;
}

/** Marks a transaction as coming from `load`, so it is not reported as a user edit. */
const external = Annotation.define<boolean>();

const highlightStyle = HighlightStyle.define([
  { tag: [t.angleBracket, t.punctuation], color: 'var(--code-punctuation)' },
  { tag: t.tagName, color: 'var(--code-tag)' },
  { tag: t.attributeName, color: 'var(--code-property)' },
  { tag: [t.attributeValue, t.string], color: 'var(--code-string)' },
  { tag: t.definitionOperator, color: 'var(--code-operator, var(--code-punctuation))' },
  { tag: [t.blockComment, t.comment], color: 'var(--code-comment)', fontStyle: 'italic' },
  { tag: [t.processingInstruction, t.documentMeta], color: 'var(--code-important, var(--code-keyword))' },
  { tag: [t.character, t.special(t.string)], color: 'var(--code-value)' },
  { tag: t.invalid, color: 'var(--text-error)', textDecoration: 'underline wavy' },
]);

const theme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--text-normal)',
    backgroundColor: 'var(--background-primary)',
    fontSize: 'var(--font-text-size, 16px)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-monospace, ui-monospace, monospace)',
    fontSize: 'var(--code-size, 0.875em)',
    lineHeight: 'var(--line-height-normal, 1.5)',
  },
  '.cm-content': { caretColor: 'var(--caret-color, var(--text-normal))', padding: 'var(--size-4-2, 8px) 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--caret-color, var(--text-normal))' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--text-selection)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--background-modifier-hover)' },
  '.cm-gutters': {
    backgroundColor: 'var(--background-primary)',
    color: 'var(--text-faint)',
    border: 'none',
  },
  '.cm-activeLineGutter': { backgroundColor: 'var(--background-modifier-hover)', color: 'var(--text-muted)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--background-modifier-hover)', outline: '1px solid var(--text-faint)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--text-highlight-bg, var(--background-modifier-hover))' },
  '.cm-searchMatch': { backgroundColor: 'var(--text-highlight-bg)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--background-primary)',
    color: 'var(--text-normal)',
    border: '1px solid var(--background-modifier-border)',
    borderRadius: 'var(--radius-s, 4px)',
    boxShadow: 'var(--shadow-s)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-monospace, monospace)', maxHeight: '16em' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--interactive-accent)',
    color: 'var(--text-on-accent)',
  },
  '.cm-completionDetail': { color: 'var(--text-muted)', fontStyle: 'normal', marginLeft: '1em' },
  '.cm-tooltip-autocomplete ul li[aria-selected] .cm-completionDetail': { color: 'inherit' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: 'bold' },
  '.cm-panels': { backgroundColor: 'var(--background-secondary)', color: 'var(--text-normal)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--background-modifier-border)' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontSize: 'inherit' },
});

function baseExtensions(opts: SourceEditorOptions): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    history(),
    bracketMatching(),
    closeBrackets(),
    highlightSelectionMatches(),
    indentUnit.of('  '),
    EditorState.tabSize.of(2),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
    xml(),
    ...(opts.completion ? [autocompletion({ override: [opts.completion], icons: false })] : []),
    syntaxHighlighting(highlightStyle),
    theme,
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
    EditorView.updateListener.of((u) => {
      const programmatic = u.transactions.some((tr) => tr.annotation(external));
      if (u.docChanged && !programmatic) opts.onChange(u.state.doc.toString());
      if (u.selectionSet || u.docChanged) {
        const line = u.state.doc.lineAt(u.state.selection.main.head).number - 1;
        const before = u.startState.doc.lineAt(Math.min(u.startState.selection.main.head, u.startState.doc.length)).number - 1;
        if (line !== before || u.docChanged) opts.onCursorLine(line);
      }
    }),
    EditorView.domEventHandlers({
      scroll: () => {
        opts.onScroll();
        return false;
      },
    }),
  ];
}

export function createSourceEditor(parent: HTMLElement, opts: SourceEditorOptions): SourceEditor {
  const extensions = baseExtensions(opts);
  const view = new EditorView({ parent, state: EditorState.create({ doc: opts.text, extensions }) });

  return {
    view,
    getText: () => view.state.doc.toString(),

    load(text, resetHistory) {
      if (resetHistory) {
        // A different file: start from a clean state so undo cannot cross files.
        view.setState(EditorState.create({ doc: text, extensions }));
        return;
      }
      const change = minimalReplacement(view.state.doc.toString(), text);
      if (change) view.dispatch({ changes: change, annotations: external.of(true) });
    },

    topLine() {
      // lineBlockAtHeight works in document coordinates: pixels from the top
      // of the first line, so the scroller's own top padding is subtracted.
      const height = Math.max(0, view.scrollDOM.scrollTop - view.documentPadding.top);
      const block = view.lineBlockAtHeight(height);
      const line = view.state.doc.lineAt(block.from).number - 1;
      const frac = block.height > 0 ? Math.min(1, Math.max(0, (height - block.top) / block.height)) : 0;
      return line + frac;
    },

    reveal(line, col) {
      const doc = view.state.doc;
      const target = doc.line(Math.min(doc.lines, Math.max(1, line + 1)));
      const pos = Math.min(target.to, target.from + Math.max(0, col));
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    },

    remeasure: () => view.requestMeasure(),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
