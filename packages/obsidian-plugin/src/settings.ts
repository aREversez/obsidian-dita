import { ViewMode, parseViewMode } from './viewMode';

export interface DitaSettings {
  /** Mode a .dita file opens in when the pane has no saved mode of its own. */
  defaultMode: ViewMode;
  /** Milliseconds the live preview waits after the last keystroke before re-rendering. */
  previewDelayMs: number;
}

export const DEFAULT_SETTINGS: Readonly<DitaSettings> = {
  defaultMode: 'reading',
  previewDelayMs: 300,
};

export const PREVIEW_DELAY_RANGE = { min: 100, max: 2000 } as const;

/** Turn whatever data.json held into valid settings, field by field. */
export function normalizeSettings(raw: unknown): DitaSettings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const delay = typeof r.previewDelayMs === 'number' && Number.isFinite(r.previewDelayMs)
    ? Math.round(r.previewDelayMs)
    : DEFAULT_SETTINGS.previewDelayMs;
  return {
    defaultMode: parseViewMode(r.defaultMode, DEFAULT_SETTINGS.defaultMode),
    previewDelayMs: Math.min(PREVIEW_DELAY_RANGE.max, Math.max(PREVIEW_DELAY_RANGE.min, delay)),
  };
}

/** What a view needs from the plugin: the current settings, read at use time so a change applies live. */
export interface SettingsProvider {
  readonly settings: DitaSettings;
}
