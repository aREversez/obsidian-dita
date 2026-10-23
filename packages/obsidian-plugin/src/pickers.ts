// The pickers behind the editing commands and the DITA quick switcher.
//
// Obsidian imports live only here; the snippets themselves are data
// (snippetsData.ts), so their wording and indentation stay testable.

import { App, Keymap, Platform, SuggestModal, TFile } from 'obsidian';

/** How many paths the quick switcher offers at once; typing narrows the list anyway. */
const MAX_SUGGESTIONS = 200;

/** A modal over a fixed list of named snippets. */
export class SnippetPicker<T extends { id: string; name: string }> extends SuggestModal<T> {
  private readonly items: readonly T[];

  constructor(app: App, items: readonly T[], placeholder: string, private readonly onPick: (item: T) => void) {
    super(app);
    this.items = items;
    this.setPlaceholder(placeholder);
  }

  getSuggestions(query: string): T[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [...this.items];
    return this.items.filter((item) => item.name.toLowerCase().includes(needle) || item.id.includes(needle));
  }

  renderSuggestion(item: T, el: HTMLElement): void {
    el.setText(item.name);
  }

  onChooseSuggestion(item: T): void {
    this.onPick(item);
  }
}

/** Lists only the files the DITA view opens, with the vault path under each name. */
export class DitaFileSwitcher extends SuggestModal<TFile> {
  private readonly files: TFile[];

  constructor(app: App) {
    super(app);
    this.files = app.vault
      .getFiles()
      .filter((file) => file.extension === 'dita' || file.extension === 'ditamap')
      .sort((a, b) => a.path.localeCompare(b.path));
    this.setPlaceholder('Open a DITA topic or map…');
    this.setInstructions([
      { command: '↵', purpose: 'to open' },
      { command: Platform.isMacOS ? 'cmd ↵' : 'ctrl ↵', purpose: 'to open in new tab' },
    ]);
    // A suggest modal only binds a bare Enter. Ctrl/Cmd+Enter goes through the
    // modal's own chooser (the same path Enter takes) so the event reaches
    // onChooseSuggestion with its modifier; if a future Obsidian drops the
    // chooser, the key just does nothing rather than throwing.
    this.scope.register(['Mod'], 'Enter', (evt: KeyboardEvent) => {
      const chooser = (this as unknown as { chooser?: { useSelectedItem(e: KeyboardEvent): void } }).chooser;
      if (!chooser) return true;
      chooser.useSelectedItem(evt);
      return false;
    });
  }

  getSuggestions(query: string): TFile[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return this.files.slice(0, MAX_SUGGESTIONS);
    const matches = this.files.filter((file) => file.path.toLowerCase().includes(needle));
    // A name match is usually what was typed; a path-only match comes after.
    matches.sort(
      (a, b) =>
        Number(b.basename.toLowerCase().includes(needle)) - Number(a.basename.toLowerCase().includes(needle)) ||
        a.path.localeCompare(b.path),
    );
    return matches.slice(0, MAX_SUGGESTIONS);
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.createDiv({ text: file.basename });
    el.createDiv({ cls: 'dita-suggest-path', text: file.path });
  }

  onChooseSuggestion(file: TFile, evt: MouseEvent | KeyboardEvent): void {
    void this.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(file);
  }
}

/** Lists the .ditaval files found in the vault folder, by vault path. */
export class DitavalPicker extends SuggestModal<string> {
  constructor(app: App, private readonly files: readonly string[], private readonly onPick: (path: string) => void) {
    super(app);
    this.setPlaceholder('Choose a DITAVAL file…');
  }

  getSuggestions(query: string): string[] {
    const needle = query.trim().toLowerCase();
    const matches = needle ? this.files.filter((path) => path.toLowerCase().includes(needle)) : [...this.files];
    return matches.slice(0, MAX_SUGGESTIONS);
  }

  renderSuggestion(path: string, el: HTMLElement): void {
    el.createDiv({ text: path.split('/').pop() ?? path });
    el.createDiv({ cls: 'dita-suggest-path', text: path });
  }

  onChooseSuggestion(path: string): void {
    this.onPick(path);
  }
}
