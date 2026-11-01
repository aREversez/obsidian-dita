// Conditional processing: the chosen .ditaval, the profiling values switched
// off by hand, the panel that shows them, and the filter applied to the page in
// place.
//
// The state belongs to the pane (it is saved with the view's state), not to the
// file, and it acts on the rendered page: elements carry the profiling values
// they hold (data-profile-keys) and are hidden with a class, so a topic is
// filtered without being rendered again. A map's site and book views are the
// exception: they drop whole topics, which the renderer decides, so those are
// rendered again.
//
// The panel itself is in profilePanel.ts and asks this for everything it shows;
// the view owns the page, the header button and the render, and lends them
// through the host.

import { App, FileSystemAdapter, Notice } from 'obsidian';
import { isExcluded, profileGroups, profileValuesOfKeys } from '@dita-viewer/core';
import type { Ditaval, ProfileFilter, ProfileGroup } from '@dita-viewer/core';
import { DitavalPicker } from './pickers';
import { ProfilePanel } from './profilePanel';
import type { ProfilePanelHost } from './profilePanel';
import {
  DEFAULT_PROFILE_STATE,
  ProfileState,
  buildFilter,
  isDefaultProfileState,
  listDitavalFiles,
  loadDitaval,
  normalizeProfileState,
  resolveDitavalPath,
} from './profileState';
import type { ViewMode } from './viewMode';

export interface ProfileControllerHost {
  readonly app: App;
  /** The rendered page the filter hides elements in. */
  body(): HTMLElement | undefined;
  /** The view's container: the panel floats at its top right. */
  container(): HTMLElement | undefined;
  /** The header button that says what the filter is doing. */
  action(): HTMLElement | undefined;
  /** Clicks on this (the header button) are not clicks away from the panel. */
  isIgnoredClick(target: Node): boolean;
  isMapFile(): boolean;
  mode(): ViewMode;
  /** A file this pane reads, so a change on disk brings it back. */
  addDependency(absPath: string): void;
  removeDependency(absPath: string): void;
  markStale(): void;
  render(): void;
  refreshFind(): void;
  saveLayout(): void;
}

export class ProfileController {
  private profile: ProfileState = { ...DEFAULT_PROFILE_STATE, hidden: [] };
  /** The chosen .ditaval as parsed; undefined when none is chosen or it did not read cleanly. */
  private ditaval?: Ditaval;
  private ditavalAbs?: string;
  private ditavalError?: string;
  /** Elements the filter hides in the page on screen. */
  private filteredCount = 0;
  private panel?: ProfilePanel;

  constructor(private readonly host: ProfileControllerHost) {}

  /** The pane's state, for the view's saved state. */
  get state(): ProfileState {
    return this.profile;
  }

  /** A pane with no filter saves nothing extra. */
  get isDefault(): boolean {
    return isDefaultProfileState(this.profile);
  }

  hasDitaval(): boolean {
    return this.profile.ditaval !== undefined;
  }

  /** The .ditaval file this pane reads, if any: a change to it renders the page again. */
  get dependency(): string | undefined {
    return this.ditavalAbs;
  }

  /** Create the panel. The view calls this once its DOM is up. */
  attach(): void {
    const container = this.host.container();
    if (!container) return;
    this.panel = new ProfilePanel(
      container,
      this.panelHost(),
      (target) => this.host.isIgnoredClick(target),
      () => this.updateAction(),
    );
    this.reload();
    this.updateAction();
  }

  /** A saved pane state is in place: bring the page and the header in line with it. */
  restore(value: unknown): void {
    this.profile = normalizeProfileState(value);
    this.reload();
    if (this.host.body()) this.applyState();
  }

  /** The filter the page is shown with, or undefined when nothing is filtered. */
  filter(): ProfileFilter | undefined {
    return buildFilter(this.ditaval, this.profile.hidden);
  }

  /** Read the chosen .ditaval from disk; an unreadable or malformed one is not applied. */
  reload(): void {
    const previous = this.ditavalAbs;
    this.ditaval = undefined;
    this.ditavalAbs = undefined;
    this.ditavalError = undefined;
    const rel = this.profile.ditaval;
    const adapter = this.host.app?.vault.adapter;
    if (previous) this.host.removeDependency(previous);
    if (!rel || !(adapter instanceof FileSystemAdapter)) return;
    const abs = resolveDitavalPath(adapter.getBasePath(), rel);
    if (!abs) {
      this.ditavalError = 'The DITAVAL path points outside the vault.';
      return;
    }
    // Watched even when it is missing, so creating it brings the filter back.
    this.ditavalAbs = abs;
    this.host.addDependency(abs);
    const loaded = loadDitaval(abs);
    this.ditavalError = loaded.error;
    // A half-read filter would look like it works; say so instead and apply none.
    if (loaded.error === undefined) this.ditaval = loaded.ditaval;
  }

  /** Hide or show every profiled element of the page on screen according to the filter. */
  applyFilter(): void {
    const body = this.host.body();
    if (!body) return;
    body.classList.toggle('hide-profiling', !this.profile.highlight);
    const filter = this.filter();
    const verdicts = new Map<string, boolean>();
    let hidden = 0;
    // Document order: an element is judged after its ancestors, so one inside
    // a hidden block is not counted as well.
    body.querySelectorAll<HTMLElement>('[data-profile-keys]').forEach((el) => {
      const keys = el.getAttribute('data-profile-keys') ?? '';
      let out = verdicts.get(keys);
      if (out === undefined) {
        out = isExcluded(profileValuesOfKeys(keys), filter);
        verdicts.set(keys, out);
      }
      el.classList.toggle('profile-filtered-out', out);
      if (out && !el.parentElement?.closest('.profile-filtered-out')) hidden++;
    });
    this.filteredCount = hidden;
    this.updateAction();
    this.panel?.updateStatus();
  }

  /** Forget what the filter was hiding (the page is gone). */
  reset(): void {
    this.filteredCount = 0;
    this.updateAction();
  }

  /**
   * The preview is showing or not: the header button follows it, and with no
   * preview there is nothing to filter, so the panel closes.
   */
  setVisible(shown: boolean): void {
    const action = this.host.action();
    if (!action) return;
    action.toggleClass('dita-hidden', !shown);
    if (!shown) this.panel?.close();
  }

  togglePanel(): void {
    if (!this.panel) return;
    if (this.panel.isOpen) this.panel.close();
    else this.panel.open();
  }

  /** Rebuild the panel from the page as it is now. */
  refreshPanel(): void {
    this.panel?.refresh();
  }

  destroy(): void {
    this.panel?.destroy();
    this.panel = undefined;
  }

  /** Pick a .ditaval from the vault and apply it to this pane. */
  choose(): void {
    const adapter = this.host.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice('DITA Viewer needs a vault stored on the local file system.');
      return;
    }
    const files = listDitavalFiles(adapter.getBasePath());
    if (files.length === 0) {
      new Notice('No .ditaval files were found in this vault.');
      return;
    }
    new DitavalPicker(this.host.app, files, (path) => this.set(path)).open();
  }

  clear(): void {
    this.set(undefined);
  }

  private set(path: string | undefined): void {
    this.profile = { ...this.profile, ditaval: path };
    if (path === undefined) delete this.profile.ditaval;
    this.reload();
    if (this.ditavalError) new Notice(this.ditavalError);
    this.changed();
    this.panel?.refresh();
  }

  /** A saved or switched state is in place: the page and the header follow it. */
  private applyState(): void {
    this.changed();
    this.panel?.refresh();
  }

  /**
   * The filter changed. Content inside a topic is hidden in place, which is
   * instant; a map's site and book views also drop whole topics, which the
   * renderer decides, so those render again.
   */
  private changed(): void {
    this.host.saveLayout();
    this.applyFilter();
    this.host.refreshFind();
    const mode = this.host.mode();
    if (this.host.isMapFile() && (mode === 'site' || mode === 'book')) {
      this.host.markStale();
      this.host.render();
    }
  }

  /** The header button lights up while a filter is in force, and says what it is doing. */
  private updateAction(): void {
    const action = this.host.action();
    if (!action) return;
    const active = this.filter() !== undefined || this.ditavalError !== undefined;
    action.toggleClass('is-active', active);
    const parts = ['Conditional processing'];
    if (this.profile.ditaval) parts.push(this.profile.ditaval.split('/').pop() ?? this.profile.ditaval);
    if (this.ditavalError) parts.push(this.ditavalError);
    if (this.filteredCount > 0) parts.push(`${this.filteredCount} hidden`);
    action.setAttribute('aria-label', parts.join(' · '));
  }

  private panelHost(): ProfilePanelHost {
    return {
      groups: (): ProfileGroup[] => {
        const sets: ReturnType<typeof profileValuesOfKeys>[] = [];
        const seen = new Set<string>();
        this.host.body()?.querySelectorAll('[data-profile-keys]').forEach((el) => {
          const keys = el.getAttribute('data-profile-keys') ?? '';
          if (seen.has(keys)) return;
          seen.add(keys);
          sets.push(profileValuesOfKeys(keys));
        });
        return profileGroups(sets, this.profile.hidden);
      },
      hidden: () => new Set(this.profile.hidden),
      ditaval: () => this.ditaval,
      ditavalPath: () => this.profile.ditaval,
      ditavalError: () => this.ditavalError,
      highlight: () => this.profile.highlight,
      hiddenCount: () => this.filteredCount,
      setValueHidden: (att, value, hide) => {
        const key = `${att}:${value}`;
        const rest = this.profile.hidden.filter((k) => k !== key);
        this.profile = { ...this.profile, hidden: hide ? [...rest, key] : rest };
        this.changed();
      },
      showAll: () => {
        this.profile = { ...this.profile, hidden: [] };
        this.changed();
        this.panel?.refresh();
      },
      setHighlight: (on) => {
        this.profile = { ...this.profile, highlight: on };
        this.host.body()?.classList.toggle('hide-profiling', !on);
        this.host.saveLayout();
      },
      chooseDitaval: () => this.choose(),
      clearDitaval: () => this.clear(),
    };
  }
}
