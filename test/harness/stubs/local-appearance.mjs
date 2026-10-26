const theme = new Proxy({ isDark: false }, { get: (t, k) => (k in t ? t[k] : '#000') });
export function useAppearance() { return { theme, scale: 1, inputFont: undefined }; }
// Added for the audit regression tests (SettingsScreens imports these).
export const SIZE_LABELS = [];
export const FONT_OPTIONS = [];
export function resolveFont() { return undefined; }
