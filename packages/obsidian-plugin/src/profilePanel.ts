// The conditional-processing panel: pick a .ditaval, tick the profiling values
// that stay in the preview, switch the highlight on or off.
//
// A small popover inside the view, under the header, built with plain DOM and
// styled from Obsidian variables (styles.css). It holds no state of its own;
// everything it shows it asks the view for, and every change goes back
// through the view, which owns the filter.

import { ditavalAction } from '@dita-viewer/core';
import type { Ditaval, ProfileGroup } from '@dita-viewer/core';
import { attributeLabel, statusText } from './profileLabels';

export interface ProfilePanelHost {
  /** The attributes and values the page carries, plus the ones turned off by hand. */
  groups(): ProfileGroup[];
  /** Values turned off by hand, as `attribute:value`. */
  hidden(): ReadonlySet<string>;
  /** The .ditaval in force, if it read cleanly. */
  ditaval(): Ditaval | undefined;
  /** Vault path of the chosen .ditaval, and why it is not in force, if it is not. */
  ditavalPath(): string | undefined;
  ditavalError(): string | undefined;
  highlight(): boolean;
  /** How many elements the filter hides right now. */
  hiddenCount(): number;
  setValueHidden(att: string, value: string, hidden: boolean): void;
  showAll(): void;
  setHighlight(on: boolean): void;
  chooseDitaval(): void;
  clearDitaval(): void;
}

export class ProfilePanel {
  private readonly el: HTMLElement;
  private status?: HTMLElement;
  private showAllButton?: HTMLButtonElement;
  private opened = false;
  private readonly onPointerDown = (evt: MouseEvent): void => {
    const target = evt.target as Node | null;
    if (target && (this.el.contains(target) || this.isIgnored(target))) return;
    this.close();
  };
  private readonly onKeyDown = (evt: KeyboardEvent): void => {
    if (evt.key === 'Escape') {
      evt.stopPropagation();
      this.close();
    }
  };

  /**
   * @param parent    the view's container; the panel floats at its top right
   * @param isIgnored clicks on this (the header button) are left to their own handler
   */
  constructor(
    private readonly parent: HTMLElement,
    private readonly host: ProfilePanelHost,
    private readonly isIgnored: (target: Node) => boolean,
    private readonly onClose: () => void,
  ) {
    this.el = parent.createDiv({ cls: 'dita-profile-panel' });
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Conditional processing');
    this.el.hide();
  }

  get isOpen(): boolean {
    return this.opened;
  }

  open(): void {
    if (this.opened) return;
    this.opened = true;
    this.refresh();
    this.el.show();
    const doc = this.el.ownerDocument;
    doc.addEventListener('mousedown', this.onPointerDown, true);
    this.el.addEventListener('keydown', this.onKeyDown);
    // Keyboard users land inside the panel; Escape then closes it.
    this.el.querySelector<HTMLElement>('button, input')?.focus();
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.el.hide();
    this.el.ownerDocument.removeEventListener('mousedown', this.onPointerDown, true);
    this.el.removeEventListener('keydown', this.onKeyDown);
    this.onClose();
  }

  destroy(): void {
    this.close();
    this.el.remove();
  }

  /** Rebuild the contents from the view's current state. */
  refresh(): void {
    if (!this.opened) return;
    const host = this.host;
    this.el.empty();

    this.el.createDiv({ cls: 'dita-profile-title', text: 'Conditional processing' });

    // ── the .ditaval ──
    const file = this.el.createDiv({ cls: 'dita-profile-file' });
    const path = host.ditavalPath();
    file.createSpan({ cls: 'dita-profile-file-label', text: 'DITAVAL' });
    const name = file.createSpan({ cls: 'dita-profile-file-name', text: path ? path.split('/').pop() ?? path : 'None' });
    if (path) name.setAttribute('title', path);
    const choose = file.createEl('button', { cls: 'dita-profile-button', text: path ? 'Change…' : 'Choose…' });
    choose.addEventListener('click', () => host.chooseDitaval());
    if (path) {
      const clear = file.createEl('button', { cls: 'dita-profile-button', text: 'Clear' });
      clear.addEventListener('click', () => host.clearDitaval());
    }
    const error = host.ditavalError();
    if (error) this.el.createDiv({ cls: 'dita-profile-error', text: error });

    // ── the values ──
    const groups = host.groups();
    const hidden = host.hidden();
    const ditaval = host.ditaval();
    const values = this.el.createDiv({ cls: 'dita-profile-values' });
    if (groups.length === 0) {
      values.createDiv({ cls: 'dita-profile-empty', text: 'This page has no profiled content.' });
    }
    for (const group of groups) {
      const section = values.createDiv({ cls: 'dita-profile-group' });
      section.createDiv({ cls: 'dita-profile-group-title', text: attributeLabel(group.att) });
      for (const value of group.values) {
        const byFile = ditavalAction(ditaval, group.att, value) === 'exclude';
        const row = section.createEl('label', { cls: 'dita-profile-row' });
        const box = row.createEl('input', { type: 'checkbox' });
        box.checked = !byFile && !hidden.has(`${group.att}:${value}`);
        row.createSpan({ text: value });
        if (byFile) {
          // The file decides; a tick here could not bring the content back.
          box.disabled = true;
          row.addClass('is-by-file');
          row.setAttribute('title', 'Left out by the DITAVAL file');
        } else {
          box.addEventListener('change', () => host.setValueHidden(group.att, value, !box.checked));
        }
      }
    }

    // ── options ──
    const options = this.el.createDiv({ cls: 'dita-profile-options' });
    const highlight = options.createEl('label', { cls: 'dita-profile-row' });
    const hbox = highlight.createEl('input', { type: 'checkbox' });
    hbox.checked = host.highlight();
    highlight.createSpan({ text: 'Highlight profiled content' });
    hbox.addEventListener('change', () => host.setHighlight(hbox.checked));

    const footer = this.el.createDiv({ cls: 'dita-profile-footer' });
    this.status = footer.createSpan({ cls: 'dita-profile-status', text: statusText(host.hiddenCount()) });
    // Always there, so ticking a box does not rebuild the panel to add it.
    const showAll = footer.createEl('button', { cls: 'dita-profile-button', text: 'Show all' });
    showAll.disabled = hidden.size === 0;
    showAll.addEventListener('click', () => host.showAll());
    this.showAllButton = showAll;
  }

  /** Update only the count and the Show all button, so a click on a box does not rebuild the panel under the pointer. */
  updateStatus(): void {
    if (!this.opened) return;
    this.status?.setText(statusText(this.host.hiddenCount()));
    if (this.showAllButton) this.showAllButton.disabled = this.host.hidden().size === 0;
  }
}
