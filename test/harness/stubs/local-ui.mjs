// Test double for src/ui.tsx. confirm() records the dialog and its OK callback; the real one has no Cancel callback.
import React from 'react';
export const ui = (globalThis.__ui ??= { toasts: [], confirms: [] });
export function toast(m) { ui.toasts.push(m); }
export function confirm(title, message, okLabel, onOk, destructive = false, onCancel) {
  ui.confirms.push({ title, message, okLabel, onOk, destructive, onCancel });
}
const host = (name) => (p) => React.createElement(name, p, p.children);
export const T = host('T');
export const Header = (p) => React.createElement('Header', p, p.children, p.right);
export const IconBtn = (p) => React.createElement('IconBtn', p);
export const Screen = host('Screen');
export const Body = host('Body');
export const FadeIn = host('FadeIn');
export const PressableScale = host('PressableScale');
export const PickerModal = host('PickerModal');
export const PromptModal = host('PromptModal');
export const Divider = host('Divider');
export const SectionHeader = host('SectionHeader');
export const Row = (p) => React.createElement('Row', p, p.children, p.right);
export const SwitchRow = host('SwitchRow');
// Added for the audit regression tests (screens that import more primitives than the earlier tests needed).
export const Button = host('Button');
export const CheckRow = host('CheckRow');
export const ChoiceModal = host('ChoiceModal');
export const InfoText = host('InfoText');
export const RadioRow = host('RadioRow');
export const SectionTitle = host('SectionTitle');
