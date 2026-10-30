import type { SettingDefinitionControl } from 'obsidian';
import { DitaSettings, PREVIEW_DELAY_RANGE, normalizeSettings } from './settings';
import { MODE_LABELS, TOPIC_MODES } from './viewMode';

/** The copy both the declarative (1.13+) and the imperative settings tab show. */
export const SETTING_TEXT = {
  defaultMode: {
    name: 'Default view mode',
    desc: 'How a DITA file opens the first time. Each pane then remembers the mode you last chose for it.',
  },
  previewDelayMs: {
    name: 'Live preview delay',
    desc: 'How long to wait after you stop typing before the side-by-side preview updates, in milliseconds.',
  },
} as const;

export const PREVIEW_DELAY_STEP = 50;

/**
 * The settings as Obsidian 1.13's declarative API wants them, which also puts
 * them in the settings search. Older versions never call this and use the
 * tab's display() instead.
 */
export function settingDefinitions(): SettingDefinitionControl<keyof DitaSettings>[] {
  const options: Record<string, string> = {};
  for (const m of TOPIC_MODES) options[m] = MODE_LABELS[m];
  return [
    {
      ...SETTING_TEXT.defaultMode,
      control: { type: 'dropdown', key: 'defaultMode', options },
    },
    {
      ...SETTING_TEXT.previewDelayMs,
      control: {
        type: 'slider',
        key: 'previewDelayMs',
        min: PREVIEW_DELAY_RANGE.min,
        max: PREVIEW_DELAY_RANGE.max,
        step: PREVIEW_DELAY_STEP,
      },
    },
  ];
}

export function readControlValue(settings: DitaSettings, key: string): unknown {
  return key === 'defaultMode' || key === 'previewDelayMs' ? settings[key] : undefined;
}

/**
 * Set one setting from a control's value. A value the setting does not accept
 * (a mode a topic has no view for, text where a number belongs) leaves the
 * settings as they were; an out-of-range delay is clamped. Returns whether the
 * settings changed hands, so the caller knows to save.
 */
export function applyControlValue(settings: DitaSettings, key: string, value: unknown): boolean {
  if (key !== 'defaultMode' && key !== 'previewDelayMs') return false;
  if (key === 'defaultMode' && !(TOPIC_MODES as readonly unknown[]).includes(value)) return false;
  if (key === 'previewDelayMs' && !(typeof value === 'number' && Number.isFinite(value))) return false;
  Object.assign(settings, normalizeSettings({ ...settings, [key]: value }));
  return true;
}
