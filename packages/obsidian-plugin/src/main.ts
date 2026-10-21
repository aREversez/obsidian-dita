import { FileSystemAdapter, Plugin, TAbstractFile } from 'obsidian';
import { join } from 'path';
import { DitaView, VIEW_TYPE_DITA } from './DitaView';
import { DEFAULT_SETTINGS, DitaSettings, SettingsProvider, normalizeSettings } from './settings';
import { DitaSettingTab } from './settingsTab';
import { MODE_LABELS, VIEW_MODES } from './viewMode';

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
          if (!view) return false;
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

    // A theme or light/dark switch changes variable values, which the preview
    // follows on its own; only the scheme flag needs a nudge.
    this.registerEvent(this.app.workspace.on('css-change', () => this.eachView((v) => v.updateScheme())));

    // Re-render when a file the topic pulls content from (conref targets, key
    // maps, ...) changes on disk. The topic itself is not handled here: the
    // view reloads its own file and renders from that.
    this.registerEvent(this.app.vault.on('modify', (file) => this.onVaultChange(file)));
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private eachView(fn: (view: DitaView) => void): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_DITA)) {
      if (leaf.view instanceof DitaView) fn(leaf.view);
    }
  }

  private onVaultChange(file: TAbstractFile): void {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;
    const abs = join(adapter.getBasePath(), file.path);
    this.eachView((view) => {
      if (view.file?.path === file.path) return;
      if (view.dependsOnAbsolutePath(abs)) void view.refresh();
    });
  }
}
