import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { DitaSettings, PREVIEW_DELAY_RANGE } from './settings';
import { MODE_LABELS, VIEW_MODES, parseViewMode } from './viewMode';

interface SettingsHost {
  settings: DitaSettings;
  saveSettings(): Promise<void>;
}

export class DitaSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly host: Plugin & SettingsHost) {
    super(app, host);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Default view mode')
      .setDesc('How a DITA file opens the first time. Each pane then remembers the mode you last chose for it.')
      .addDropdown((dd) => {
        for (const m of VIEW_MODES) dd.addOption(m, MODE_LABELS[m]);
        dd.setValue(this.host.settings.defaultMode).onChange(async (value) => {
          this.host.settings.defaultMode = parseViewMode(value, this.host.settings.defaultMode);
          await this.host.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Live preview delay')
      .setDesc('How long to wait after you stop typing before the side-by-side preview updates, in milliseconds.')
      .addSlider((s) =>
        s
          .setLimits(PREVIEW_DELAY_RANGE.min, PREVIEW_DELAY_RANGE.max, 50)
          .setValue(this.host.settings.previewDelayMs)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.host.settings.previewDelayMs = value;
            await this.host.saveSettings();
          }),
      );
  }
}
