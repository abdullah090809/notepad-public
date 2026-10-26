// Minimal react-native fake: host components are plain strings (react-test-renderer renders them),
// imperative APIs are recorders that tests can drive.
import React from 'react';

export const rn = (globalThis.__rn ??= {
  alerts: [],
  appStateHandlers: new Set(),
  backHandlers: [],
  scrolls: [],
  keyboardListeners: new Map(),
  focusedInputs: [],
});

export const Alert = { alert: (title, message, buttons, options) => rn.alerts.push({ title, message, buttons, options }) };
export const AppState = {
  currentState: 'active',
  addEventListener(_t, cb) { rn.appStateHandlers.add(cb); return { remove: () => rn.appStateHandlers.delete(cb) }; },
};
export const BackHandler = {
  addEventListener(_t, cb) { rn.backHandlers.push(cb); return { remove: () => { rn.backHandlers = rn.backHandlers.filter((x) => x !== cb); } }; },
  exitApp() {},
};
export const Dimensions = {
  dims: { width: 400, height: 800 },
  get: () => Dimensions.dims,
};
export const Easing = { bezier: () => () => 0, out: (f) => f, quad: () => 0, ease: () => 0 };
export const Keyboard = {
  addListener(evt, cb) {
    if (!rn.keyboardListeners.has(evt)) rn.keyboardListeners.set(evt, new Set());
    rn.keyboardListeners.get(evt).add(cb);
    return { remove: () => rn.keyboardListeners.get(evt)?.delete(cb) };
  },
  emit(evt, payload) {
    for (const cb of rn.keyboardListeners.get(evt) ?? []) cb(payload);
  },
  dismiss() {},
};
export const LayoutAnimation = { configureNext() {}, Presets: { easeInEaseOut: {} } };
export const PanResponder = { create: (cfg) => ({ panHandlers: cfg }) };
export const PixelRatio = { getFontScale: () => 1 };
export const Platform = { OS: 'android', select: (o) => o.android ?? o.default };
export const Share = { share: async () => ({}) };
export const StyleSheet = { create: (x) => x, absoluteFill: {}, hairlineWidth: 1, flatten: (x) => x };
export const ToastAndroid = { SHORT: 0, LONG: 1, show() {} };
export const AccessibilityInfo = { isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove() {} }) };

class AnimatedValue { constructor(v) { this.v = v; } setValue(v) { this.v = v; } interpolate() { return 0; } }
const anim = () => ({ start: (cb) => cb && cb({ finished: true }), stop() {} });
export const Animated = {
  Value: AnimatedValue,
  timing: anim, spring: anim, parallel: anim, sequence: anim,
  View: (p) => React.createElement('Animated.View', p),
};
function attachRef(ref, handle) {
  if (!ref) return;
  if (typeof ref === 'function') ref(handle);
  else if (typeof ref === 'object') ref.current = handle;
}
const host = (name) => (p) => React.createElement(name, p);
export const View = host('View');
export const Text = host('Text');
export const Switch = host('Switch');
export const TextInput = (p) => {
  attachRef(p.ref, {
    focus() { rn.focusedInputs.push(p); },
    blur() {},
  });
  return React.createElement('TextInput', p);
};
export const Pressable = host('Pressable');
export const Image = host('Image'); // added for the audit regression tests
export const ScrollView = (p) => {
  attachRef(p.ref, {
    scrollTo(opts) { rn.scrolls.push(opts); },
  });
  return React.createElement('ScrollView', p);
};
export const KeyboardAvoidingView = host('KeyboardAvoidingView');
export const Modal = host('Modal');
export const FlatList = (p) =>
  React.createElement(
    'FlatList',
    p,
    p.ListHeaderComponent ? React.createElement('View', null, p.ListHeaderComponent) : null,
    p.data?.map((item, index) =>
      React.createElement(React.Fragment, { key: p.keyExtractor ? p.keyExtractor(item, index) : index }, p.renderItem({ item, index }))
    ),
    p.ListFooterComponent ? React.createElement('View', null, p.ListFooterComponent) : null
  );
export default {};
