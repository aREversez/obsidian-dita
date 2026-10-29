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

import { Annotation, EditorState, Extension, RangeSet, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, ViewPlugin, ViewUpdate, drawSelection, gutter, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { bracketMatching, HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { CompletionSource, autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';
import { xml } from '@codemirror/lang-xml';
import { minimalReplacement } from './textDiff';
import { ProblemRange } from './sourceDiagnostics';
import { SourceReference, referenceAt } from './references';

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
  /** Problems in the document, recomputed a moment after typing stops. */
  lint?: (text: string) => readonly ProblemRange[];
  /** Ctrl/Cmd+click landed on a reference attribute (href, conref, keyref, ...). */
  onReference?: (ref: SourceReference, evt: MouseEvent) => void;
}

export interface SourceEditor {
  readonly view: EditorView;
  getText(): string;
  /** Replace the text from outside (file loaded, or changed on disk). `resetHistory` for a different file. */
  load(text: string, resetHistory: boolean): void;
  /** Source position at the top of the viewport: 0-based line plus the fraction of it scrolled past. */
  topLine(): number;
  /** Scroll so `line` (0-based, may be fractional, as topLine returns) is at the top of the viewport. The caret stays. */
  scrollToTopLine(line: number): void;
  /** Move the caret to a 0-based line/column and bring it into view. */
  reveal(line: number, col: number): void;
  /** Re-check the source now (a file the check reads changed on disk). */
  recheck(): void;
  /** Call after the editor's container goes from hidden to visible. */
  remeasure(): void;
  focus(): void;
  destroy(): void;
}

/** Marks a transaction as coming from `load`, so it is not reported as a user edit. */
const external = Annotation.define<boolean>();

// ── diagnostics ──
// Problems arrive from outside the editor (they read other files), so they
// travel through a state field: the field holds the last set, decorations and
// gutter dots derive from it, and one effect replaces the whole set.

/** How long the editor waits after the last keystroke before re-checking. */
const PROBLEM_DELAY_MS = 600;

const setProblems = StateEffect.define<readonly ProblemRange[]>();

/** Runs the check over the current text. Undefined when the view is gone or the check failed. */
function checkSource(view: EditorView, lint: (text: string) => readonly ProblemRange[]): readonly ProblemRange[] | undefined {
  // A pending timer can outlive the pane's editor.
  if (!view.dom.isConnected) return undefined;
  try {
    return lint(view.state.doc.toString());
  } catch (e) {
    console.warn('DITA Viewer: could not check the source:', e instanceof Error ? e.message : e);
    return undefined;
  }
}

const problems = StateField.define<readonly ProblemRange[]>({
  create: () => [],
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setProblems)) return effect.value;
    // Until the scanner catches up, keep each squiggle over the text it was
    // about: an edit above a problem must move it, not paint the line above.
    if (tr.docChanged) {
      return value.flatMap((p) => {
        const from = tr.changes.mapPos(p.from, 1);
        const to = tr.changes.mapPos(p.to, -1);
        return from < to ? [{ ...p, from, to }] : [];
      });
    }
    return value;
  },
});

/** Wavy underline under each problem, with the message as its native tooltip. */
const problemDecorations = EditorView.decorations.compute([problems], (state) => {
  const ranges = state.field(problems).flatMap((p) => {
    // The document may have shrunk since the problems arrived; a range past
    // its end would be rejected when the set is applied.
    const from = Math.min(p.from, state.doc.length);
    const to = Math.min(p.to, state.doc.length);
    if (from >= to) return [];
    return [
      Decoration.mark({
        class: p.severity === 'error' ? 'cm-dita-problem-error' : 'cm-dita-problem-warning',
        attributes: { title: p.message },
      }).range(from, to),
    ];
  });
  return Decoration.set(ranges, true);
});

class ProblemDot extends GutterMarker {
  constructor(private readonly severity: ProblemRange['severity']) {
    super();
  }

  override eq(other: GutterMarker): boolean {
    return other instanceof ProblemDot && other.severity === this.severity;
  }

  override toDOM(): Node {
    const dot = document.createElement('span');
    dot.className = `cm-dita-problem-dot cm-dita-problem-dot-${this.severity}`;
    dot.title = this.severity === 'error' ? 'Error' : 'Warning';
    return dot;
  }
}

/** One dot per line that has a problem; an error wins over a warning on the same line. */
function problemMarkers(state: EditorState): RangeSet<GutterMarker> {
  const builder = new RangeSetBuilder<GutterMarker>();
  const byLine = new Map<number, ProblemRange['severity']>();
  for (const problem of state.field(problems)) {
    const from = state.doc.lineAt(Math.min(problem.from, state.doc.length)).from;
    if (byLine.get(from) !== 'error') byLine.set(from, problem.severity);
  }
  for (const [from, severity] of [...byLine].sort((a, b) => a[0] - b[0])) {
    builder.add(from, from, new ProblemDot(severity));
  }
  return builder.finish();
}

/**
 * The dots sit in a gutter of their own, left of the line numbers. Putting the
 * markers on the line-number gutter instead would replace the numbers: a
 * marker that draws anything hides the number it sits on.
 */
const problemGutter = gutter({
  class: 'cm-dita-problem-gutter',
  markers: (view) => problemMarkers(view.state),
  lineMarkerChange: (update) => update.transactions.some((tr) => tr.effects.some((e) => e.is(setProblems))) || update.docChanged,
  initialSpacer: () => new ProblemDot('error'),
});

/** Re-checks the document once typing pauses. */
function problemScanner(lint: (text: string) => readonly ProblemRange[]): Extension {
  return ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | undefined;

      constructor(private readonly view: EditorView) {
        this.schedule();
      }

      update(update: ViewUpdate): void {
        if (update.docChanged) this.schedule();
      }

      destroy(): void {
        if (this.timer !== undefined) clearTimeout(this.timer);
      }

      private schedule(): void {
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.run(), PROBLEM_DELAY_MS);
      }

      private run(): void {
        if (this.timer !== undefined) {
          clearTimeout(this.timer);
          this.timer = undefined;
        }
        const found = checkSource(this.view, lint);
        if (found) this.view.dispatch({ effects: setProblems.of(found) });
      }
    },
  );
}

/** The reference on the caret's own line (a tag that wraps over lines is a rare miss for the hover cursor only). */
function referenceOnLine(view: EditorView, pos: number): SourceReference | undefined {
  const line = view.state.doc.lineAt(pos);
  return referenceAt(line.text, pos - line.from);
}

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
  // Diagnostics: the message is the mark's title (a native tooltip), so no
  // extra tooltip UI is needed and nothing competes with the theme.
  '.cm-dita-problem-error': { textDecoration: 'underline wavy var(--text-error)', textUnderlineOffset: '2px' },
  '.cm-dita-problem-warning': {
    textDecoration: 'underline wavy var(--text-warning, var(--text-muted))',
    textUnderlineOffset: '2px',
  },
  '.cm-dita-problem-dot': { display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%', margin: '0 2px' },
  '.cm-dita-problem-dot-error': { backgroundColor: 'var(--text-error)' },
  '.cm-dita-problem-dot-warning': { backgroundColor: 'var(--text-warning, var(--text-muted))' },
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
    ...(opts.lint ? [problems, problemGutter] : []),
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
    ...(opts.lint ? [problemDecorations, problemScanner(opts.lint)] : []),
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
    // Ctrl/Cmd+click on a reference: the host decides where it goes. The
    // handlers live here because only the editor knows which attribute the
    // pointer is on.
    ...(opts.onReference
      ? [
          EditorView.domEventHandlers({
            mousedown: (evt, view) => {
              if (evt.button !== 0 || (!evt.ctrlKey && !evt.metaKey)) return false;
              const pos = view.posAtCoords({ x: evt.clientX, y: evt.clientY });
              const reference = pos === null ? undefined : referenceAt(view.state.doc.toString(), pos);
              if (!reference) return false;
              evt.preventDefault();
              opts.onReference!(reference, evt);
              return true;
            },
            // The pointer only changes shape; the click is handled above.
            mousemove: (evt, view) => {
              const pos = evt.ctrlKey || evt.metaKey ? view.posAtCoords({ x: evt.clientX, y: evt.clientY }) : null;
              view.contentDOM.style.cursor = pos !== null && referenceOnLine(view, pos) ? 'pointer' : '';
              return false;
            },
            mouseleave: (_evt, view) => {
              view.contentDOM.style.cursor = '';
              return false;
            },
          }),
        ]
      : []),
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

    scrollToTopLine(line) {
      const doc = view.state.doc;
      const whole = Math.min(doc.lines - 1, Math.max(0, Math.floor(line)));
      const block = view.lineBlockAt(doc.line(whole + 1).from);
      const frac = Math.min(1, Math.max(0, line - whole));
      view.scrollDOM.scrollTop = block.top + frac * block.height + view.documentPadding.top;
    },

    reveal(line, col) {
      const doc = view.state.doc;
      const target = doc.line(Math.min(doc.lines, Math.max(1, line + 1)));
      const pos = Math.min(target.to, target.from + Math.max(0, col));
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    },

    recheck() {
      if (!opts.lint) return;
      // Called by the host when a file the check reads changed, not during an
      // editor update, so dispatching the new set here is safe.
      const found = checkSource(view, opts.lint);
      if (found) view.dispatch({ effects: setProblems.of(found) });
    },

    remeasure: () => view.requestMeasure(),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
