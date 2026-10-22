import { FileSystemAdapter, Plugin } from 'obsidian';
import { join } from 'path';
import { DitaView, VIEW_TYPE_DITA } from './DitaView';
import { DEFAULT_SETTINGS, DitaSettings, SettingsProvider, normalizeSettings } from './settings';
import { DitaSettingTab } from './settingsTab';
import { MODE_LABELS, VIEW_MODES, modesFor } from './viewMode';
import { DitaFileSwitcher, SnippetPicker } from './pickers';
import { mapMayAffect } from './mapScope';
import { STRUCTURES, StructureSpec, WRAPS, WrapSpec } from './snippetsData';

export default class DitaViewerPlugin extends Plugin implements SettingsProvider {
  settings: DitaSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());

    this.registerView(VIEW_TYPE_DITA, (leaf) => new DitaView(leaf, this));
    // Makes .dita and .ditamap files visible in the vault and opens them in the DITA view.
    this.registerExtensions(['dita', 'ditamap'], VIEW_TYPE_DITA);
    this.addSettingTab(new DitaSettingTab(this.app, this));

    for (const mode of VIEW_MODES) {
      this.addCommand({
        id: `mode-${mode}`,
        name: MODE_LABELS[mode],
        checkCallback: (checking) => {
          const view = this.app.workspace.getActiveViewOfType(DitaView);
          if (!view || !modesFor(view.isMapFile()).includes(mode)) return false;
          if (!checking) view.setMode(mode);
          return true;
        },
      });
    }
    this.addCommand({
      id: 'toggle-mode',
      name: 'Toggle reading view and source mode',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(DitaView);
        if (!view) return false;
        if (!checking) view.toggleMode();
        return true;
      },
    });
    this.addCommand({
      id: 'wrap-in-element',
      name: 'Wrap selection in an element',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(DitaView);
        // The selection only exists in the editor, so the command is offered
        // where the editor is showing.
        if (!view?.hasSource()) return false;
        if (!checking) {
          new SnippetPicker<WrapSpec>(this.app, WRAPS, 'Wrap in…', (spec) => view.applyWrap(spec)).open();
        }
        return true;
      },
    });
    this.addCommand({
      id: 'insert-structure',
      name: 'Insert a structure',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(DitaView);
        if (!view?.hasSource()) return false;
        if (!checking) {
          new SnippetPicker<StructureSpec>(this.app, STRUCTURES, 'Insert…', (spec) => view.applyStructure(spec)).open();
        }
        return true;
      },
    });
    this.addCommand({
      id: 'quick-switch',
      name: 'Quick switch to a DITA file',
      callback: () => new DitaFileSwitcher(this.app).open(),
    });

    // A theme or light/dark switch changes variable values, which the preview
    // follows on its own; only the scheme flag needs a nudge.
    this.registerEvent(this.app.workspace.on('css-change', () => this.eachView((v) => v.updateScheme())));

    // Re-render and re-check when a file the topic references (conref targets,
    // key maps, ...) or the topic links to changes on disk. The topic itself
    // is not handled here: the view reloads its own file and renders from that.
    // Creation and deletion matter too: "File not found" is fixed by creating
    // the missing file, and a new or removed map changes the key space.
    this.registerEvent(this.app.vault.on('modify', (file) => this.onVaultChange(file.path, isMapPath(file.path))));
    // While Obsidian indexes the vault it fires `create` for every file it
    // already has; those are not changes, so the other three wait for the layout.
    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on('create', (file) => this.onVaultChange(file.path, isMapPath(file.path))));
      this.registerEvent(this.app.vault.on('delete', (file) => this.onVaultChange(file.path, isMapPath(file.path))));
      this.registerEvent(
        this.app.vault.on('rename', (file, oldPath) => {
          const map = isMapPath(file.path) || isMapPath(oldPath);
          this.onVaultChange(oldPath, map);
          this.onVaultChange(file.path, map);
        }),
      );
    });
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private eachView(fn: (view: DitaView) => void): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_DITA)) {
      if (leaf.view instanceof DitaView) fn(leaf.view);
    }
  }

  /**
   * Re-render and re-check the views that read `path`. A .ditamap passes
   * `isMap`: a change there can define or undefine the keys of every topic in
   * or below its folder, and a newly created map was not in any view's
   * dependency list.
   */
  private onVaultChange(path: string, isMap = false): void {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;
    const abs = join(adapter.getBasePath(), path);
    this.eachView((view) => {
      if (view.file?.path === path) return;
      const inScope = isMap && view.file !== null && mapMayAffect(abs, join(adapter.getBasePath(), view.file.path));
      if (inScope || view.dependsOnAbsolutePath(abs)) void view.refresh();
    });
  }
}

function isMapPath(path: string): boolean {
  return /\.ditamap$/i.test(path);
}
