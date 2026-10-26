import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Alert,
  Animated,
  Easing,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleProp,
  Text,
  TextInput,
  TextProps,
  TextStyle,
  ToastAndroid,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppearance } from './appearance';

export type IconName = React.ComponentProps<typeof Ionicons>['name'];

type ToastAction = { label: string; onPress: () => void };
type ToastListener = (message: string, action?: ToastAction) => void;
let toastListener: ToastListener | null = null;

export function toast(message: string, action?: ToastAction): void {
  if (toastListener) toastListener(message, action);
  else if (Platform.OS === 'android') ToastAndroid.show(message, ToastAndroid.SHORT);
}

/** Render once near the root of the app: shows toasts as a small pill that slides up and fades. */
export function ToastHost() {
  const { theme } = useAppearance();
  const insets = useSafeAreaInsets();
  const reduce = useReduceMotion();
  const [msg, setMsg] = useState<string | null>(null);
  const [action, setAction] = useState<ToastAction | undefined>(undefined);
  const v = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    toastListener = (m, a) => {
      setMsg(m);
      setAction(a);
      if (timer.current) clearTimeout(timer.current);
      Animated.timing(v, {
        toValue: 1,
        duration: reduce ? 0 : 200,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
      timer.current = setTimeout(() => {  // longer when there is an Undo to tap
        Animated.timing(v, { toValue: 0, duration: reduce ? 0 : 220, useNativeDriver: true }).start(
          ({ finished }) => finished && setMsg(null)
        );
      }, a ? 5000 : 2200);
    };
    return () => {
      toastListener = null;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [v, reduce]);

  if (!msg) return null;
  return (
    <Animated.View
      pointerEvents="box-none"
      accessibilityLiveRegion="polite"
      style={{
        position: 'absolute',
        left: 24,
        right: 24,
        bottom: insets.bottom + 100,
        alignItems: 'center',
        opacity: v,
        transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }],
      }}
    >
      <View
        style={{
          backgroundColor: theme.isDark ? '#f2f2f2' : '#262626',
          borderRadius: 22,
          paddingHorizontal: 18,
          paddingVertical: 11,
          maxWidth: '100%',
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={{ color: theme.isDark ? '#111' : '#fff', fontSize: 15, fontWeight: '600' }}>{msg}</Text>
          {action ? (
            <Pressable
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              onPress={() => {
                const run = action.onPress;
                setMsg(null);
                run();
              }}
              style={{ marginLeft: 16 }}
            >
              <Text style={{ color: theme.isDark ? '#1a73e8' : '#8ab4f8', fontSize: 15, fontWeight: '700' }}>
                {action.label}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </Animated.View>
  );
}

export function confirm(
  title: string,
  message: string,
  okLabel: string,
  onOk: () => void,
  destructive = false,
  onCancel?: () => void
): void {
  Alert.alert(
    title,
    message,
    [
      { text: 'Cancel', style: 'cancel', onPress: onCancel },
      { text: okLabel, style: destructive ? 'destructive' : 'default', onPress: onOk },
    ],
    { cancelable: true, onDismiss: onCancel }
  );
}

/* ---------- motion ---------- */

/** True when the phone's "remove animations" setting is on. Animations shorten to nothing then. */
export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => alive && setReduce(v)).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduce;
}

/** Fades and lifts its children in once, optionally after a delay (used for list rows and menus). */
export function FadeIn({
  children,
  delay = 0,
  distance = 0,
  duration = 180,
  style,
}: {
  children: React.ReactNode;
  delay?: number;
  distance?: number;
  duration?: number;
  style?: StyleProp<import('react-native').ViewStyle>;
}) {
  const reduce = useReduceMotion();
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.timing(v, {
      toValue: 1,
      duration: reduce ? 0 : duration,
      delay: reduce ? 0 : delay,
      easing: Easing.bezier(0.25, 0.1, 0.25, 1),
      useNativeDriver: true,
    });
    a.start();
    return () => a.stop();
  }, [v, reduce, delay, duration]);
  return (
    <Animated.View
      style={[
        style,
        {
          opacity: v,
          ...(distance > 0
            ? {
                transform: [
                  {
                    translateY: v.interpolate({
                      inputRange: [0, 1],
                      outputRange: [distance, 0],
                    }),
                  },
                ],
              }
            : {}),
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

/** A Pressable that subtly scales while held with smooth natural easing. */
export function PressableScale({
  children,
  scaleTo = 0.975,
  style,
  ...rest
}: React.ComponentProps<typeof Pressable> & { scaleTo?: number }) {
  const v = useRef(new Animated.Value(1)).current;
  const to = (n: number) =>
    Animated.timing(v, {
      toValue: n,
      duration: 100,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  return (
    <Pressable
      {...rest}
      onPressIn={(e) => {
        to(scaleTo);
        rest.onPressIn?.(e);
      }}
      onPressOut={(e) => {
        to(1);
        rest.onPressOut?.(e);
      }}
    >
      {(state) => (
        <Animated.View style={[typeof style === 'function' ? style(state) : style, { transform: [{ scale: v }] }]}>
          {typeof children === 'function' ? children(state) : children}
        </Animated.View>
      )}
    </Pressable>
  );
}

/* ---------- text ---------- */

type TProps = TextProps & {
  size?: number;
  bold?: boolean;
  dim?: boolean;
  style?: StyleProp<TextStyle>;
};

export function T({ size = 16, bold, dim, style, children, ...rest }: TProps) {
  const { theme, scale, dashFont } = useAppearance();
  return (
    <Text
      maxFontSizeMultiplier={1.6}
      {...rest}
      style={[
        {
          color: dim ? theme.subtext : theme.text,
          fontSize: size * scale,
          fontFamily: dashFont,
          fontWeight: bold ? '700' : '400',
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

/* ---------- layout ---------- */

export function Screen({ children }: { children: React.ReactNode }) {
  const { theme } = useAppearance();
  return <View style={{ flex: 1, backgroundColor: theme.bg }}>{children}</View>;
}

export function Body({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

export function IconBtn({
  name,
  onPress,
  onLongPress,
  size = 24,
  disabled,
  delayLongPress = 380,
  repeatPress = false,
  repeatDelay = 210,
  repeatInterval = 42,
  color,
  accessibilityLabel,
  accessibilityHint,
}: {
  name: IconName;
  onPress?: () => void | boolean;
  onLongPress?: () => void;
  delayLongPress?: number;
  repeatPress?: boolean;
  repeatDelay?: number;
  repeatInterval?: number;
  size?: number;
  disabled?: boolean;
  color?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}) {
  const { theme } = useAppearance();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const firedInRef = useRef(false);
  const onPressRef = useRef(onPress);
  onPressRef.current = onPress;

  const clearRepeat = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (disabled) {
      clearRepeat();
    }
  }, [disabled, clearRepeat]);

  useEffect(() => {
    return () => clearRepeat();
  }, [clearRepeat]);

  const handlePressIn = useCallback(() => {
    if (disabled) return;
    if (repeatPress) {
      firedInRef.current = true;
      const res = onPressRef.current?.();
      if (res === false) return;

      clearRepeat();
      let stepCount = 0;
      const scheduleNext = (delayMs: number) => {
        timerRef.current = setTimeout(() => {
          const stillRunning = onPressRef.current?.();
          if (stillRunning === false) {
            clearRepeat();
            return;
          }
          stepCount += 1;
          const nextInterval =
            stepCount > 16
              ? Math.max(16, Math.floor(repeatInterval * 0.38))
              : stepCount > 6
              ? Math.max(24, Math.floor(repeatInterval * 0.6))
              : repeatInterval;
          scheduleNext(nextInterval);
        }, delayMs);
      };
      scheduleNext(repeatDelay);
    }
  }, [disabled, repeatPress, repeatDelay, repeatInterval, clearRepeat]);

  const handlePressOut = useCallback(() => {
    if (repeatPress) {
      clearRepeat();
    }
  }, [repeatPress, clearRepeat]);

  const handlePress = useCallback(() => {
    if (disabled) return;
    if (repeatPress) {
      if (firedInRef.current) {
        firedInRef.current = false;
        return;
      }
    }
    onPressRef.current?.();
  }, [disabled, repeatPress]);

  return (
    <Pressable
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onLongPress={onLongPress}
      delayLongPress={delayLongPress}
      disabled={disabled}
      hitSlop={8}
      android_ripple={{ borderless: true, radius: 22, color: theme.border }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.35 : pressed ? 0.55 : 1,
      })}
    >
      <Ionicons pointerEvents="none" name={name} size={size} color={color ?? theme.text} />
    </Pressable>
  );
}

export function Header({
  title,
  onBack,
  backIcon = 'arrow-back',
  right,
  center = true,
  children,
}: {
  title?: string;
  onBack?: () => void;
  backIcon?: IconName;
  right?: React.ReactNode;
  center?: boolean;
  children?: React.ReactNode;
}) {
  const { theme } = useAppearance();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        paddingTop: insets.top,
        backgroundColor: theme.bg,
        borderBottomWidth: 1,
        borderBottomColor: theme.border,
      }}
    >
      <View style={{ minHeight: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4 }}>
        {onBack ? (
          <IconBtn
            name={backIcon}
            onPress={onBack}
            accessibilityLabel="Back"
          />
        ) : (
          <View style={{ width: 8 }} />
        )}
        <View
          style={{
            flex: 1,
            alignItems: center ? 'center' : 'flex-start',
            justifyContent: 'center',
            paddingHorizontal: 8,
          }}
        >
          {children ?? (
            <T size={20} bold numberOfLines={1}>
              {title}
            </T>
          )}
        </View>
        {right ? (
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>{right}</View>
        ) : (
          <View style={{ width: center && onBack ? 44 : 8 }} />
        )}
      </View>
    </View>
  );
}

export function ReadOnlyBanner({ onDisable }: { onDisable?: () => void }) {
  const { theme } = useAppearance();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.isDark ? '#232014' : '#fff9db',
        borderBottomWidth: 1,
        borderBottomColor: theme.isDark ? '#594a1b' : '#f59f00',
        paddingVertical: 8,
        paddingHorizontal: 14,
      }}
    >
      <Ionicons name="eye" size={18} color={theme.isDark ? '#fcc419' : '#e67700'} />
      <T
        size={14}
        bold
        style={{
          flex: 1,
          marginLeft: 8,
          color: theme.isDark ? '#fcc419' : '#d9480f',
        }}
      >
        Read-Only Mode Active
      </T>
      {onDisable ? (
        <Pressable
          onPress={onDisable}
          hitSlop={6}
          style={{
            paddingHorizontal: 10,
            paddingVertical: 4,
            borderRadius: 6,
            backgroundColor: theme.isDark ? '#594a1b' : '#ffe066',
          }}
        >
          <T size={12} bold style={{ color: theme.isDark ? '#ffffff' : '#495057' }}>
            DISABLE
          </T>
        </Pressable>
      ) : null}
    </View>
  );
}

/* ---------- settings rows ---------- */

export function Row({
  title,
  subtitle,
  onPress,
  right,
}: {
  title: string;
  subtitle?: string;
  onPress?: () => void;
  right?: React.ReactNode;
}) {
  const { theme } = useAppearance();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      android_ripple={{ color: theme.border }}
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      style={({ pressed }) => ({
        minHeight: 56,
        opacity: pressed ? 0.7 : 1,
        paddingVertical: 16,
        paddingHorizontal: 16,
        borderBottomWidth: 1,
        borderBottomColor: theme.border,
        flexDirection: 'row',
        alignItems: 'center',
      })}
    >
      <View pointerEvents="none" style={{ flex: 1, paddingRight: 8 }}>
        <T size={17} bold>
          {title}
        </T>
        {subtitle ? (
          <T size={15} dim style={{ marginTop: 4 }}>
            {subtitle}
          </T>
        ) : null}
      </View>
      {right === 'chevron' ? (
        <Ionicons pointerEvents="none" name="chevron-forward" size={22} color={theme.text} />
      ) : (
        right ?? null
      )}
    </Pressable>
  );
}

export function SectionTitle({ children }: { children: string }) {
  return (
    <T size={17} bold style={{ paddingHorizontal: 16, paddingTop: 24, paddingBottom: 8 }}>
      {children}
    </T>
  );
}

export function InfoText({ children }: { children: React.ReactNode }) {
  return (
    <T size={15} dim style={{ paddingHorizontal: 16, paddingVertical: 12, lineHeight: 22 * 1 }}>
      {children}
    </T>
  );
}

export function CheckRow({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const { theme } = useAppearance();
  return (
    <Pressable
      onPress={() => !disabled && onChange(!value)}
      disabled={disabled}
      android_ripple={{ color: theme.border }}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: value, disabled }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 12,
        paddingHorizontal: 16,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Ionicons
        pointerEvents="none"
        name={value ? 'checkbox' : 'square-outline'}
        size={26}
        color={value ? theme.accent : theme.text}
      />
      <T size={16} pointerEvents="none" style={{ flex: 1, marginLeft: 14 }}>
        {label}
      </T>
    </Pressable>
  );
}

export function RadioRow({
  label,
  selected,
  onPress,
  fontFamily,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  fontFamily?: string;
}) {
  const { theme } = useAppearance();
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: theme.border }}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 16 }}
    >
      <Ionicons
        pointerEvents="none"
        name={selected ? 'radio-button-on' : 'radio-button-off'}
        size={26}
        color={selected ? theme.accent : theme.text}
      />
      <T size={16} pointerEvents="none" style={[{ flex: 1, marginLeft: 14 }, fontFamily ? { fontFamily } : null]}>
        {label}
      </T>
    </Pressable>
  );
}

export function Button({
  label,
  onPress,
  danger,
  disabled,
}: {
  label: string;
  onPress: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  const { theme } = useAppearance();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => ({
        backgroundColor: danger ? theme.danger : theme.accent,
        paddingVertical: 14,
        paddingHorizontal: 22,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.45 : pressed ? 0.82 : 1,
        shadowColor: danger ? theme.danger : theme.accent,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.18,
        shadowRadius: 4,
        elevation: 2,
      })}
    >
      <Text
        style={{
          color: danger ? '#ffffff' : theme.accentText,
          fontWeight: '700',
          fontSize: 15,
          letterSpacing: 0.6,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/* ---------- dialogs ---------- */

export function ChoiceModal<V extends string | number>({
  visible,
  title,
  options,
  value,
  onSelect,
  onClose,
}: {
  visible: boolean;
  title: string;
  options: { label: string; value: V }[];
  value: V;
  onSelect: (v: V) => void;
  onClose: () => void;
}) {
  const { theme } = useAppearance();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 }}
        onPress={onClose}
      >
        <Pressable
          style={{
            backgroundColor: theme.surface,
            borderRadius: 12,
            paddingVertical: 8,
            borderWidth: 1,
            borderColor: theme.border,
          }}
        >
          <T size={18} bold style={{ padding: 16 }}>
            {title}
          </T>
          {options.map((o) => (
            <RadioRow
              key={String(o.value)}
              label={o.label}
              selected={o.value === value}
              onPress={() => {
                onSelect(o.value);
                onClose();
              }}
            />
          ))}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export function PickerModal({
  visible,
  title,
  options,
  onSelect,
  onClose,
}: {
  visible: boolean;
  title: string;
  options: { label: string; value: string | null; depth?: number }[];
  onSelect: (v: string | null) => void;
  onClose: () => void;
}) {
  const { theme } = useAppearance();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 }}
        onPress={onClose}
      >
        <Pressable
          style={{
            backgroundColor: theme.surface,
            borderRadius: 12,
            paddingVertical: 8,
            borderWidth: 1,
            borderColor: theme.border,
            maxHeight: '80%',
          }}
        >
          <T size={18} bold style={{ padding: 16 }}>
            {title}
          </T>
          <ScrollView>
            {options.map((o) => (
              <Pressable
                key={String(o.value)}
                onPress={() => {
                  onSelect(o.value);
                  onClose();
                }}
                style={{ paddingVertical: 14, paddingHorizontal: 16, paddingLeft: 16 + (o.depth ?? 0) * 18 }}
              >
                <T size={16}>{o.label}</T>
              </Pressable>
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export function PromptModal({
  visible,
  title,
  placeholder,
  initial = '',
  okLabel = 'OK',
  onSubmit,
  onClose,
}: {
  visible: boolean;
  title: string;
  placeholder?: string;
  initial?: string;
  okLabel?: string;
  onSubmit: (text: string) => void;
  onClose: () => void;
}) {
  const { theme, inputFont } = useAppearance();
  const [text, setText] = useState(initial);
  useEffect(() => {
    if (visible) setText(initial);
  }, [visible, initial]);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 }}
        onPress={onClose}
      >
        <Pressable
          style={{
            backgroundColor: theme.surface,
            borderRadius: 12,
            padding: 16,
            borderWidth: 1,
            borderColor: theme.border,
          }}
        >
          <T size={18} bold>
            {title}
          </T>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={placeholder}
            placeholderTextColor={theme.subtext}
            autoFocus
            autoCapitalize="words"
            onSubmitEditing={() => {
              onSubmit(text);
              onClose();
            }}
            style={{
              marginTop: 14,
              borderWidth: 1,
              borderColor: theme.border,
              borderRadius: 8,
              paddingHorizontal: 12,
              paddingVertical: 10,
              color: theme.text,
              fontFamily: inputFont,
              fontSize: 16,
            }}
          />
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 16 }}>
            <Pressable onPress={onClose} style={{ padding: 10 }}>
              <T bold>CANCEL</T>
            </Pressable>
            <Pressable
              onPress={() => {
                onSubmit(text);
                onClose();
              }}
              style={{ padding: 10, marginLeft: 8 }}
            >
              <T bold style={{ color: theme.accent }}>
                {okLabel.toUpperCase()}
              </T>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
