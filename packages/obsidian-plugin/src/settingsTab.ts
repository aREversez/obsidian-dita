import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';
import type { SettingDefinitionItem } from 'obsidian';
import { DitaSettings, PREVIEW_DELAY_RANGE } from './settings';
import { PREVIEW_DELAY_STEP, SETTING_TEXT, applyControlValue, readControlValue, settingDefinitions } from './settingsControls';
import { MODE_LABELS, TOPIC_MODES } from './viewMode';

interface SettingsHost {
  settings: DitaSettings;
  saveSettings(): Promise<void>;
}

export class DitaSettingTab extends PluginSettingTab {
  // `plugin` and `host` are the same object. `Plugin` has its own `settings`
  // (Obsidian 1.13+), so reads go through the narrower `SettingsHost`.
  constructor(app: App, plugin: Plugin, private readonly host: SettingsHost) {
    super(app, plugin);
  }

  // Obsidian 1.13+ builds the tab from these, and searches them.
  getSettingDefinitions(): SettingDefinitionItem[] {
    return settingDefinitions();
  }

  getControlValue(key: string): unknown {
    return readControlValue(this.host.settings, key);
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (applyControlValue(this.host.settings, key, value)) await this.host.saveSettings();
  }

  // Before 1.13 there is no declarative API: the tab is drawn here.
  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName(SETTING_TEXT.defaultMode.name)
      .setDesc(SETTING_TEXT.defaultMode.desc)
      .addDropdown((dd) => {
        for (const m of TOPIC_MODES) dd.addOption(m, MODE_LABELS[m]);
        dd.setValue(this.host.settings.defaultMode).onChange((value) => this.setControlValue('defaultMode', value));
      });

    new Setting(containerEl)
      .setName(SETTING_TEXT.previewDelayMs.name)
      .setDesc(SETTING_TEXT.previewDelayMs.desc)
      .addSlider((s) =>
        s
          .setLimits(PREVIEW_DELAY_RANGE.min, PREVIEW_DELAY_RANGE.max, PREVIEW_DELAY_STEP)
          .setValue(this.host.settings.previewDelayMs)
          .setDynamicTooltip()
          .onChange((value) => this.setControlValue('previewDelayMs', value)),
      );
  }
}
