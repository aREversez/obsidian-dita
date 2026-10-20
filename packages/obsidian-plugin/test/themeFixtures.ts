// Obsidian variable sets for a spread of theme "archetypes".
//
// These are NOT copies of real community themes (they could not be fetched in
// the build sandbox). Each one reproduces the shape of a family of themes: the
// values Obsidian's own default light/dark use, and stress cases that real
// themes approach -- warm paper backgrounds, low-saturation Solarized-style
// palettes, a pure-black AMOLED page, over-saturated neon accents, pastel
// palettes whose "yellow" is almost white. A theme that behaves like one of
// these behaves like its archetype.

export interface ThemeFixture {
  name: string;
  scheme: 'light' | 'dark';
  vars: Record<string, string>;
}

type Palette = { red: string; orange: string; yellow: string; green: string; blue: string; purple: string };

function theme(
  name: string,
  scheme: 'light' | 'dark',
  base: { bg: string; bg2: string; text: string; muted: string; border: string; accent: string },
  p: Palette,
): ThemeFixture {
  return {
    name,
    scheme,
    vars: {
      '--background-primary': base.bg,
      '--background-secondary': base.bg2,
      '--background-modifier-border': base.border,
      '--background-modifier-hover': base.bg2,
      '--text-normal': base.text,
      '--text-muted': base.muted,
      '--text-accent': base.accent,
      '--interactive-accent': base.accent,
      '--text-on-accent': scheme === 'dark' ? '#ffffff' : '#ffffff',
      '--code-background': base.bg2,
      '--color-red': p.red,
      '--color-orange': p.orange,
      '--color-yellow': p.yellow,
      '--color-green': p.green,
      '--color-blue': p.blue,
      '--color-purple': p.purple,
    },
  };
}

const OBSIDIAN_LIGHT: Palette = { red: '#e93147', orange: '#ec7500', yellow: '#e0ac00', green: '#08b94e', blue: '#086ddd', purple: '#7852ee' };
const OBSIDIAN_DARK: Palette = { red: '#fb464c', orange: '#e9973f', yellow: '#e0de71', green: '#44cf6e', blue: '#027aff', purple: '#a882ff' };

export const THEMES: ThemeFixture[] = [
  theme('obsidian-default-light', 'light', { bg: '#ffffff', bg2: '#f6f6f6', text: '#222222', muted: '#5c5c5c', border: '#e0e0e0', accent: '#705dcf' }, OBSIDIAN_LIGHT),
  theme('obsidian-default-dark', 'dark', { bg: '#1e1e1e', bg2: '#262626', text: '#dadada', muted: '#b3b3b3', border: '#363636', accent: '#7f6df2' }, OBSIDIAN_DARK),
  theme('warm-paper-light', 'light', { bg: '#f4ecd8', bg2: '#ebe1c8', text: '#433422', muted: '#6b5844', border: '#d9ccab', accent: '#9a4d1a' }, OBSIDIAN_LIGHT),
  theme('solarized-dark', 'dark', { bg: '#002b36', bg2: '#073642', text: '#93a1a1', muted: '#839496', border: '#0f4a58', accent: '#268bd2' },
    { red: '#dc322f', orange: '#cb4b16', yellow: '#b58900', green: '#859900', blue: '#268bd2', purple: '#6c71c4' }),
  theme('solarized-light', 'light', { bg: '#fdf6e3', bg2: '#eee8d5', text: '#4f6269', muted: '#657b83', border: '#d8d1bb', accent: '#268bd2' },
    { red: '#dc322f', orange: '#cb4b16', yellow: '#b58900', green: '#859900', blue: '#268bd2', purple: '#6c71c4' }),
  theme('amoled-black', 'dark', { bg: '#000000', bg2: '#0b0b0b', text: '#ffffff', muted: '#a0a0a0', border: '#2a2a2a', accent: '#bd93f9' },
    { red: '#ff5555', orange: '#ffb86c', yellow: '#f1fa8c', green: '#50fa7b', blue: '#6272a4', purple: '#bd93f9' }),
  theme('neon-dark', 'dark', { bg: '#0d0221', bg2: '#1a0b3b', text: '#f5f5f5', muted: '#b8a9d9', border: '#33206b', accent: '#ff2a6d' },
    { red: '#ff2a6d', orange: '#ff9a00', yellow: '#ffee00', green: '#05ffa1', blue: '#0000ff', purple: '#b967ff' }),
  theme('pastel-light', 'light', { bg: '#fffaf0', bg2: '#f7efe0', text: '#4a4a4a', muted: '#6a6a6a', border: '#e6dcc6', accent: '#d47ba6' },
    { red: '#ff9aa2', orange: '#ffb347', yellow: '#ffe066', green: '#9be3a9', blue: '#8ec5ff', purple: '#c3a6ff' }),
  theme('high-contrast-light', 'light', { bg: '#ffffff', bg2: '#f0f0f0', text: '#000000', muted: '#333333', border: '#000000', accent: '#0000cc' },
    { red: '#b00020', orange: '#a04000', yellow: '#806000', green: '#006b2d', blue: '#0033cc', purple: '#5a1fb5' }),
];
