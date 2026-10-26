export type ThemeId =
  | 'custom'
  | 'dark'
  | 'default'
  | 'richRed'
  | 'christmas'
  | 'halloween'
  | 'pandaWhite'
  | 'cloudWhite';

export type Theme = {
  id: ThemeId;
  name: string;
  isDark: boolean;
  bg: string;
  surface: string;
  text: string;
  subtext: string;
  border: string;
  accent: string;
  accentText: string;
  danger: string;
};

export type CustomColors = { bg: string; text: string; accent: string };

export const DEFAULT_CUSTOM: CustomColors = {
  bg: '#101820',
  text: '#f2f2f2',
  accent: '#3b82f6',
};

export const THEME_ORDER: ThemeId[] = [
  'custom',
  'dark',
  'default',
  'richRed',
  'christmas',
  'halloween',
  'pandaWhite',
  'cloudWhite',
];

type PresetId = Exclude<ThemeId, 'custom'>;

const PRESETS: Record<PresetId, Theme> = {
  dark: {
    id: 'dark',
    name: 'Dark Mode',
    isDark: true,
    bg: '#000000',
    surface: '#111116',
    text: '#ffffff',
    subtext: '#a0a0ae',
    border: '#2b2b3a',
    accent: '#3b82f6',
    accentText: '#ffffff',
    danger: '#ef4444',
  },
  default: {
    id: 'default',
    name: 'Default Theme',
    isDark: true,
    bg: '#272a36',
    surface: '#303444',
    text: '#ffffff',
    subtext: '#aab0c4',
    border: '#454b60',
    accent: '#3b82f6',
    accentText: '#ffffff',
    danger: '#ef4444',
  },
  richRed: {
    id: 'richRed',
    name: 'Rich Red',
    isDark: true,
    bg: '#7f1626',
    surface: '#8f2335',
    text: '#ffffff',
    subtext: '#f1b9c1',
    border: '#b04656',
    accent: '#ffffff',
    accentText: '#7f1626',
    danger: '#ffcdd2',
  },
  christmas: {
    id: 'christmas',
    name: 'Christmas',
    isDark: true,
    bg: '#16703b',
    surface: '#1c8247',
    text: '#ffffff',
    subtext: '#c5e8d2',
    border: '#3f9c66',
    accent: '#c62828',
    accentText: '#ffffff',
    danger: '#ffcdd2',
  },
  halloween: {
    id: 'halloween',
    name: 'Happy Halloween!',
    isDark: false,
    bg: '#f39a32',
    surface: '#f6ab51',
    text: '#1a1208',
    subtext: '#5b3a0d',
    border: '#c97a14',
    accent: '#2b1b3d',
    accentText: '#ffffff',
    danger: '#b71c1c',
  },
  pandaWhite: {
    id: 'pandaWhite',
    name: 'Panda White',
    isDark: false,
    bg: '#e8e8e8',
    surface: '#f3f3f3',
    text: '#111111',
    subtext: '#5d5d66',
    border: '#c3c3c8',
    accent: '#1e293b',
    accentText: '#ffffff',
    danger: '#dc2626',
  },
  cloudWhite: {
    id: 'cloudWhite',
    name: 'Cloud White',
    isDark: false,
    bg: '#ffffff',
    surface: '#f5f5f8',
    text: '#111111',
    subtext: '#62626c',
    border: '#dcdce2',
    accent: '#2563eb',
    accentText: '#ffffff',
    danger: '#dc2626',
  },
};

export function isHex(c: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(c);
}

function rgb(c: string): [number, number, number] {
  return [
    parseInt(c.slice(1, 3), 16),
    parseInt(c.slice(3, 5), 16),
    parseInt(c.slice(5, 7), 16),
  ];
}

function toHex(n: number): string {
  const v = Math.max(0, Math.min(255, Math.round(n)));
  return (v < 16 ? '0' : '') + v.toString(16);
}

/** Linear mix: t = 0 gives a, t = 1 gives b. */
function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  return (
    '#' +
    toHex(ar + (br - ar) * t) +
    toHex(ag + (bg - ag) * t) +
    toHex(ab + (bb - ab) * t)
  );
}

function luminance(c: string): number {
  const [r, g, b] = rgb(c);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

export function themeName(id: ThemeId): string {
  return id === 'custom' ? 'Custom Theme' : PRESETS[id].name;
}

export function resolveTheme(id: ThemeId, custom: CustomColors): Theme {
  if (id !== 'custom') {
    return PRESETS[id] ?? PRESETS.dark;
  }
  const bg = isHex(custom.bg) ? custom.bg : DEFAULT_CUSTOM.bg;
  const text = isHex(custom.text) ? custom.text : DEFAULT_CUSTOM.text;
  const accent = isHex(custom.accent) ? custom.accent : DEFAULT_CUSTOM.accent;
  return {
    id: 'custom',
    name: 'Custom Theme',
    isDark: luminance(bg) < 0.5,
    bg,
    surface: mix(bg, text, 0.07),
    text,
    subtext: mix(text, bg, 0.4),
    border: mix(bg, text, 0.22),
    accent,
    accentText: luminance(accent) < 0.55 ? '#ffffff' : '#000000',
    danger: '#e53935',
  };
}

/** Background colour shown in the theme list for each theme. */
export function swatchColor(id: ThemeId): string {
  return id === 'custom' ? '#444444' : PRESETS[id].bg;
}

export function swatchTextColor(id: ThemeId): string {
  return id === 'custom' ? '#ffffff' : PRESETS[id].text;
}
