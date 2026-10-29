// Find in the rendered preview (Ctrl/Cmd+F).
//
// The preview lives in a Shadow DOM, where the browser's own find does not
// reach, so this is a small find bar of its own: a text field, the match
// count, previous / next, match case. Matches are painted with the CSS Custom
// Highlight API (no change to the page's DOM, so nothing to undo and no
// effect on the source line stamps the scroll sync relies on).
//
// The matching itself is in textSearch.ts.

import { setIcon } from 'obsidian';
import { MAX_MATCHES, TextPart, buildIndex, findMatches, locate } from './textSearch';

export interface PreviewFindHost {
  /** The preview's shadow root: where the highlight rules go. */
  shadow: ShadowRoot;
  /** The rendered page inside it. */
  body: HTMLElement;
  /** Where the bar is placed (positioned, covering the preview pane). */
  barParent: HTMLElement;
  /** What the reader has selected in the preview, to start a search from. */
  selectedText(): string;
  /** Called when the bar closes, so focus can go back to the preview. */
  onClose(): void;
}

let nextId = 1;

export class PreviewFind {
  private readonly bar: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly count: HTMLElement;
  private readonly caseButton: HTMLElement;
  private readonly allName: string;
  private readonly currentName: string;
  private readonly win: typeof window;
  private ranges: Range[] = [];
  private current = -1;
  private matchCase = false;
  private opened = false;
  /** Where the current match was when the page last changed, so a re-render keeps the reader's place. */
  private lastQuery = '';

  constructor(private readonly host: PreviewFindHost) {
    const id = nextId++;
    this.allName = `dita-find-${id}`;
    this.currentName = `dita-find-current-${id}`;
    this.win = host.shadow.host.ownerDocument.defaultView ?? window;

    // The ::highlight rules have to be in the shadow tree's own styles.
    const sheet = new this.win.CSSStyleSheet();
    sheet.replaceSync(
      `::highlight(${this.allName}) { background-color: var(--text-highlight-bg, #ffd54f); color: inherit; }` +
        `::highlight(${this.currentName}) { background-color: var(--interactive-accent, #ff7043); color: var(--text-on-accent, #fff); }`,
    );
    host.shadow.adoptedStyleSheets = [...host.shadow.adoptedStyleSheets, sheet];

    this.bar = host.barParent.createDiv({ cls: 'dita-find' });
    this.input = this.bar.createEl('input', { type: 'text', cls: 'dita-find-input', attr: { placeholder: 'Find', 'aria-label': 'Find in preview', spellcheck: 'false' } });
    this.count = this.bar.createDiv({ cls: 'dita-find-count' });
    this.caseButton = this.button('case-sensitive', 'Match case', () => this.toggleCase());
    this.button('chevron-up', 'Previous match (Shift+Enter)', () => this.step(-1));
    this.button('chevron-down', 'Next match (Enter)', () => this.step(1));
    this.button('x', 'Close (Esc)', () => this.close());

    this.input.addEventListener('input', () => this.search());
    this.input.addEventListener('keydown', (evt) => this.onKey(evt));
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** Show the bar and put the cursor in it. A selection in the preview becomes the query. */
  open(): void {
    const selected = this.host.selectedText().trim();
    if (selected && !selected.includes('\n') && selected.length <= 200) this.input.value = selected;
    this.opened = true;
    this.bar.addClass('is-open');
    this.bar.parentElement?.addClass('has-find');
    this.input.focus();
    this.input.select();
    this.search();
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.bar.removeClass('is-open');
    this.bar.parentElement?.removeClass('has-find');
    this.clearHighlights();
    this.host.onClose();
  }

  /** The page was rebuilt (or filtered): its text nodes are new, so look again. */
  refresh(): void {
    if (this.opened) this.search(true);
  }

  destroy(): void {
    this.clearHighlights();
    this.bar.remove();
    this.bar.parentElement?.removeClass('has-find');
  }

  // ── searching ──

  private search(keepPlace = false): void {
    const query = this.input.value;
    const place = keepPlace && query === this.lastQuery ? this.current : 0;
    this.lastQuery = query;
    this.ranges = this.findRanges(query);
    this.current = this.ranges.length === 0 ? -1 : Math.min(Math.max(0, place), this.ranges.length - 1);
    this.paint();
    if (!keepPlace && this.current >= 0) this.reveal();
  }

  private findRanges(query: string): Range[] {
    if (!query.trim()) return [];
    const nodes = this.textNodes();
    const index = buildIndex(nodes.parts);
    const ranges: Range[] = [];
    for (const m of findMatches(index.text, query, this.matchCase)) {
      const from = locate(index, m.start, 'start');
      const to = locate(index, m.end, 'end');
      const range = this.host.body.ownerDocument.createRange();
      range.setStart(nodes.nodes[from.part], from.offset);
      range.setEnd(nodes.nodes[to.part], to.offset);
      ranges.push(range);
    }
    return ranges;
  }

  /** The text a reader can see: what the profile filter or a hidden element has taken out is skipped. */
  private textNodes(): { nodes: Text[]; parts: TextPart[] } {
    const doc = this.host.body.ownerDocument;
    const walker = doc.createTreeWalker(this.host.body, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    const parts: TextPart[] = [];
    const blocks = new Map<Element, Element>();
    const visible = new Map<Element, boolean>();
    const isVisible = (el: Element): boolean => {
      let v = visible.get(el);
      if (v === undefined) {
        v = el.getClientRects().length > 0 && !el.closest('.dv-visually-hidden, script, style');
        visible.set(el, v);
      }
      return v;
    };
    const blockOf = (el: Element): Element => {
      let b = blocks.get(el);
      if (b) return b;
      let cur: Element = el;
      while (cur.parentElement && cur !== this.host.body) {
        const display = this.win.getComputedStyle(cur).display;
        if (!display.startsWith('inline') && display !== 'contents') break;
        cur = cur.parentElement;
      }
      blocks.set(el, cur);
      return cur;
    };
    let previousBlock: Element | undefined;
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      const parent = n.parentElement;
      if (!parent || n.data.length === 0 || !isVisible(parent)) continue;
      const block = blockOf(parent);
      nodes.push(n);
      parts.push({ text: n.data, breakBefore: previousBlock !== undefined && block !== previousBlock });
      previousBlock = block;
    }
    return { nodes, parts };
  }

  // ── showing the result ──

  private paint(): void {
    const highlights = this.win.CSS.highlights;
    highlights.delete(this.allName);
    highlights.delete(this.currentName);
    if (this.ranges.length > 0) {
      highlights.set(this.allName, new this.win.Highlight(...this.ranges));
      if (this.current >= 0) {
        const cur = new this.win.Highlight(this.ranges[this.current]);
        cur.priority = 1;
        highlights.set(this.currentName, cur);
      }
    }
    const n = this.ranges.length;
    this.count.setText(!this.input.value.trim() ? '' : n === 0 ? 'No results' : `${this.current + 1} / ${n >= MAX_MATCHES ? `${n}+` : n}`);
    this.bar.toggleClass('has-no-results', n === 0 && !!this.input.value.trim());
  }

  private clearHighlights(): void {
    this.win.CSS.highlights.delete(this.allName);
    this.win.CSS.highlights.delete(this.currentName);
    this.ranges = [];
    this.current = -1;
  }

  private step(delta: number): void {
    if (this.ranges.length === 0) return;
    this.current = (this.current + delta + this.ranges.length) % this.ranges.length;
    this.paint();
    this.reveal();
  }

  /** Bring the current match into view, centred, also inside a block that scrolls on its own. */
  private reveal(): void {
    const el = this.ranges[this.current]?.startContainer.parentElement;
    el?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }

  // ── the bar ──

  private button(icon: string, label: string, onClick: () => void): HTMLElement {
    const b = this.bar.createDiv({ cls: 'clickable-icon dita-find-button', attr: { 'aria-label': label, role: 'button', tabindex: '0' } });
    setIcon(b, icon);
    b.addEventListener('click', onClick);
    b.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' || evt.key === ' ') {
        evt.preventDefault();
        onClick();
      }
    });
    return b;
  }

  private toggleCase(): void {
    this.matchCase = !this.matchCase;
    this.caseButton.toggleClass('is-active', this.matchCase);
    this.search();
  }

  private onKey(evt: KeyboardEvent): void {
    if (evt.key === 'Enter') {
      evt.preventDefault();
      this.step(evt.shiftKey ? -1 : 1);
    } else if (evt.key === 'Escape') {
      evt.preventDefault();
      evt.stopPropagation();
      this.close();
    }
  }
}
