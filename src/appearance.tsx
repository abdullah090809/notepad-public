import React, { createContext, useContext, useMemo } from 'react';
import { Platform } from 'react-native';
import { useSettings, TextSize } from './settings';
import { resolveTheme, Theme } from './theme';

export const SIZE_SCALE: Record<TextSize, number> = {
  xs: 0.8,
  s: 0.9,
  m: 1,
  l: 1.15,
  xl: 1.3,
  xxl: 1.5,
};

export const SIZE_LABELS: { id: TextSize; label: string }[] = [
  { id: 'xs', label: 'X Small' },
  { id: 's', label: 'Small' },
  { id: 'm', label: 'Regular (default)' },
  { id: 'l', label: 'Large' },
  { id: 'xl', label: 'X Large' },
  { id: 'xxl', label: 'XX Large' },
];

export const FONT_OPTIONS: { id: string; label: string }[] = [
  { id: 'default', label: 'Device Default' },
  { id: 'serif', label: 'Serif' },
  { id: 'mono', label: 'Monospace' },
  { id: 'condensed', label: 'Condensed' },
  { id: 'light', label: 'Light' },
  { id: 'casual', label: 'Casual' },
  { id: 'cursive', label: 'Cursive' },
];

const ANDROID_FONTS: Record<string, string> = {
  serif: 'serif',
  mono: 'monospace',
  condensed: 'sans-serif-condensed',
  light: 'sans-serif-light',
  casual: 'casual',
  cursive: 'cursive',
};

const IOS_FONTS: Record<string, string> = {
  serif: 'Georgia',
  mono: 'Menlo',
  condensed: 'AvenirNextCondensed-Regular',
  light: 'HelveticaNeue-Light',
  casual: 'MarkerFelt-Thin',
  cursive: 'SnellRoundhand',
};

export function resolveFont(id: string): string | undefined {
  if (id === 'default') return undefined;
  const table = Platform.OS === 'android' ? ANDROID_FONTS : IOS_FONTS;
  return table[id];
}

type Appearance = {
  theme: Theme;
  scale: number;
  dashFont: string | undefined;
  inputFont: string | undefined;
};

const AppearanceContext = createContext<Appearance | null>(null);

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const { s } = useSettings();
  const value = useMemo<Appearance>(
    () => ({
      theme: resolveTheme(s.themeId, s.custom),
      scale: SIZE_SCALE[s.textSize] ?? 1,
      dashFont: resolveFont(s.dashFont),
      inputFont: resolveFont(s.inputFont),
    }),
    [s.themeId, s.custom, s.textSize, s.dashFont, s.inputFont]
  );
  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): Appearance {
  const c = useContext(AppearanceContext);
  if (!c) throw new Error('useAppearance must be used inside AppearanceProvider');
  return c;
}
