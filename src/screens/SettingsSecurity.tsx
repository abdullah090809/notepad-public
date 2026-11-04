import React, { useEffect, useState } from 'react';
import { Alert, Modal, Pressable, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppearance } from '../appearance';
import { useNav } from '../nav';
import { useSettings } from '../settings';
import { useAppLocked } from '../gate';
import {
  authenticateBiometric,
  biometricAvailable,
  hasPassword,
  removePassword,
  setPassword,
  subscribeSecurityChange,
  verifyPassword,
} from '../security';
import { Body, Button, CheckRow, ChoiceModal, Header, IconBtn, Row, Screen, T, toast } from '../ui';

const TIMEOUT_OPTIONS = [
  { label: 'Immediately', value: 0 },
  { label: '5 seconds', value: 5 },
  { label: '15 seconds', value: 15 },
  { label: '30 seconds', value: 30 },
  { label: '1 minute', value: 60 },
  { label: '5 minutes', value: 300 },
];

const RESET_OPTIONS = [
  { label: '1 hour', value: 1 },
  { label: '6 hours', value: 6 },
  { label: '12 hours', value: 12 },
  { label: '24 hours', value: 24 },
  { label: '48 hours', value: 48 },
];

function timeoutLabel(sec: number): string {
  if (sec === 0) return 'immediately';
  if (sec < 60) return `${sec} second${sec === 1 ? '' : 's'}`;
  return `${sec / 60} minute${sec === 60 ? '' : 's'}`;
}

export function SecuritySettings() {
  const nav = useNav();
  const { theme, inputFont } = useAppearance();
  const { s, update } = useSettings();
  const [pw, setPw] = useState<boolean | null>(null);
  const [timeoutOpen, setTimeoutOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  // Authentication gate state before opening PasswordScreen
  const [gateOpen, setGateOpen] = useState(false);
  const appLocked = useAppLocked();
  const [currentPwInput, setCurrentPwInput] = useState('');
  const [showCurrentPw, setShowCurrentPw] = useState(false);
  const [gateError, setGateError] = useState('');
  const [gateVerifying, setGateVerifying] = useState(false);
  const [bioReady, setBioReady] = useState(false);

  const refreshPw = React.useCallback(() => {
    hasPassword().then(setPw);
    biometricAvailable().then(setBioReady);
  }, []);

  useEffect(() => {
    refreshPw();
    const unsub = subscribeSecurityChange((has) => {
      setPw(has);
    });
    return unsub;
  }, [refreshPw]);

  // Re-check whenever route or stack changes (e.g. popping back from PasswordScreen)
  useEffect(() => {
    if (nav.route.name === 'SecuritySettings') {
      refreshPw();
    }
  }, [nav.route.name, nav.stack.length, refreshPw]);

  const onPasswordRowPress = async () => {
    const currentHasPw = await hasPassword();
    setPw(currentHasPw);
    if (currentHasPw) {
      setCurrentPwInput('');
      setGateError('');
      setGateOpen(true);
    } else {
      nav.push('Password');
    }
  };

  const handleVerifyCurrent = async () => {
    if (!currentPwInput || gateVerifying) return;
    setGateVerifying(true);
    setGateError('');
    try {
      const ok = await verifyPassword(currentPwInput);
      if (ok) {
        setGateOpen(false);
        setCurrentPwInput('');
        nav.push('Password');
      } else {
        setGateError('Incorrect password. Please try again.');
      }
    } catch {
      setGateError('Verification failed. Please try again.');
    } finally {
      setGateVerifying(false);
    }
  };

  const handleGateBio = async () => {
    const ok = await authenticateBiometric('Confirm fingerprint to change password');
    if (ok) {
      setGateOpen(false);
      setCurrentPwInput('');
      nav.push('Password');
    }
  };

  const toggleFingerprint = async () => {
    if (s.fingerprint) {
      update({ fingerprint: false });
      return;
    }
    const currentHasPw = await hasPassword();
    setPw(currentHasPw);
    if (!currentHasPw) {
      Alert.alert(
        'Set a password first',
        'Fingerprint unlocking works together with a security password. Set a password, then turn fingerprint on.'
      );
      return;
    }
    if (!(await biometricAvailable())) {
      Alert.alert(
        'Fingerprint not available',
        'This device has no fingerprint sensor, or no fingerprint is set up in your phone settings.'
      );
      return;
    }
    const ok = await authenticateBiometric('Confirm your fingerprint to turn this on');
    if (ok) {
      update({ fingerprint: true });
      toast('Fingerprint unlocking is on');
    }
  };

  return (
    <Screen>
      <Header title="App Security" onBack={nav.pop} />
      <Body>
        <Row
          title="Security Password"
          subtitle={
            pw === null
              ? ' '
              : pw
              ? 'You currently have a password set for this app. Tap to change or remove it.'
              : 'No password is set. Tap to set one.'
          }
          onPress={onPasswordRowPress}
          right="chevron"
        />
        <Row
          title="Inactivity Timeout Length"
          subtitle={`The app locks when you leave it for more than this. Currently ${timeoutLabel(
            s.inactivitySeconds
          )}.`}
          onPress={() => setTimeoutOpen(true)}
          right="chevron"
        />
        <Row
          title="Password Reset Timer"
          subtitle={`If you forget your password, you must wait this long before it can be removed. Currently ${s.resetHours} hours.`}
          onPress={() => setResetOpen(true)}
          right="chevron"
        />
        <Row
          title="Fingerprint Unlocking"
          subtitle={
            s.fingerprint
              ? 'You currently have fingerprint unlocking enabled. Tap to remove it.'
              : 'Fingerprint unlocking is off. Tap to turn it on.'
          }
          onPress={toggleFingerprint}
          right="chevron"
        />
        <View style={{ height: 8 }} />
        <CheckRow
          label="Hide app content when backgrounded"
          value={s.hideInBackground}
          onChange={(v) => update({ hideInBackground: v })}
        />
      </Body>

      <ChoiceModal
        visible={timeoutOpen}
        title="Inactivity timeout"
        options={TIMEOUT_OPTIONS}
        value={s.inactivitySeconds}
        onSelect={(v) => update({ inactivitySeconds: v })}
        onClose={() => setTimeoutOpen(false)}
      />
      <ChoiceModal
        visible={resetOpen}
        title="Password reset timer"
        options={RESET_OPTIONS}
        value={s.resetHours}
        onSelect={(v) => update({ resetHours: v })}
        onClose={() => setResetOpen(false)}
      />

      {/* Verify Current Password Gate Modal */}
      <Modal
        visible={gateOpen && !appLocked}
        transparent
        animationType="fade"
        onRequestClose={() => setGateOpen(false)}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 }}
          onPress={() => setGateOpen(false)}
        >
          <Pressable
            style={{
              backgroundColor: theme.surface,
              borderRadius: 14,
              padding: 20,
              borderWidth: 1,
              borderColor: theme.border,
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 6 },
              shadowOpacity: 0.35,
              shadowRadius: 10,
              elevation: 10,
            }}
          >
            <T size={19} bold style={{ marginBottom: 6 }}>
              Current Password Required
            </T>
            <T size={14} dim style={{ marginBottom: 16 }}>
              Enter your current password to change or remove security settings.
            </T>

            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                borderWidth: 1,
                borderColor: theme.border,
                borderRadius: 8,
                paddingLeft: 12,
                backgroundColor: theme.bg,
              }}
            >
              <TextInput
                value={currentPwInput}
                onChangeText={(t) => {
                  setCurrentPwInput(t);
                  if (gateError) setGateError('');
                }}
                placeholder="Current password"
                placeholderTextColor={theme.subtext}
                secureTextEntry={!showCurrentPw}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                onSubmitEditing={handleVerifyCurrent}
                style={{
                  flex: 1,
                  paddingVertical: 12,
                  color: theme.text,
                  fontFamily: inputFont,
                  fontSize: 16,
                }}
              />
              <IconBtn
                name={showCurrentPw ? 'eye' : 'eye-off'}
                onPress={() => setShowCurrentPw((v) => !v)}
                accessibilityLabel={showCurrentPw ? 'Hide password' : 'Show password'}
              />
            </View>

            {gateError ? (
              <T size={14} style={{ color: theme.danger, marginTop: 8 }}>
                {gateError}
              </T>
            ) : null}

            {s.fingerprint && bioReady ? (
              <Pressable
                onPress={handleGateBio}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  alignSelf: 'center',
                  paddingVertical: 12,
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <Ionicons name="finger-print" size={20} color={theme.accent} style={{ marginRight: 6 }} />
                <T size={14} bold style={{ color: theme.accent }}>
                  Authenticate with Fingerprint
                </T>
              </Pressable>
            ) : null}

            <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 18 }}>
              <Pressable
                onPress={() => setGateOpen(false)}
                style={{ paddingVertical: 10, paddingHorizontal: 16 }}
              >
                <T bold style={{ color: theme.subtext }}>
                  CANCEL
                </T>
              </Pressable>
              <Pressable
                onPress={handleVerifyCurrent}
                disabled={gateVerifying}
                style={{
                  backgroundColor: theme.accent,
                  paddingVertical: 10,
                  paddingHorizontal: 18,
                  borderRadius: 6,
                  opacity: gateVerifying ? 0.6 : 1,
                }}
              >
                <T bold style={{ color: theme.accentText }}>
                  {gateVerifying ? 'VERIFYING...' : 'CONFIRM'}
                </T>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </Screen>
  );
}

function PasswordField({
  label,
  value,
  onChange,
  placeholder,
  show,
  onToggleShow,
}: {
  label: string;
  value: string;
  onChange: (t: string) => void;
  placeholder?: string;
  show: boolean;
  onToggleShow: () => void;
}) {
  const { theme, inputFont } = useAppearance();
  const appLocked = useAppLocked();
  return (
    <View style={{ marginBottom: 18 }}>
      <T size={14} bold style={{ marginBottom: 8, color: theme.text }}>
        {label}
      </T>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          borderWidth: 1,
          borderColor: theme.border,
          borderRadius: 12,
          backgroundColor: theme.surface,
          paddingLeft: 14,
          paddingRight: 6,
        }}
      >
        <Ionicons name="key-outline" size={20} color={theme.subtext} style={{ marginRight: 10 }} />
        <TextInput
          value={value}
          onChangeText={onChange}
          secureTextEntry={!show}
          editable={!appLocked}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={placeholder}
          placeholderTextColor={theme.subtext}
          style={{
            flex: 1,
            paddingVertical: 14,
            color: theme.text,
            fontFamily: inputFont,
            fontSize: 16,
          }}
        />
        <IconBtn
          name={show ? 'eye' : 'eye-off'}
          size={20}
          color={theme.subtext}
          onPress={onToggleShow}
          accessibilityLabel={show ? 'Hide password' : 'Show password'}
        />
      </View>
    </View>
  );
}

export function PasswordScreen() {
  const nav = useNav();
  const { theme } = useAppearance();
  const { update } = useSettings();
  const [pw, setPw] = useState<boolean | null>(null);
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showNext, setShowNext] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    hasPassword().then(setPw);
  }, []);

  if (pw === null) {
    return (
      <Screen>
        <Header title="Security Password" onBack={nav.pop} />
      </Screen>
    );
  }

  const save = async () => {
    if (saving) return;
    setError('');
    if (next.length < 4) {
      setError('Password must be at least 4 characters.');
      return;
    }
    if (next !== confirm) {
      setError('The passwords do not match. Please check again.');
      return;
    }
    setSaving(true);
    try {
      await setPassword(next);
      toast(pw ? 'Password updated' : 'Password set');
      nav.pop();
    } catch {
      setError('Failed to save password. Please try again.');
      setSaving(false);
    }
  };

  const handleRemovePress = () => {
    Alert.alert(
      'Remove Security Password?',
      'Your notes will no longer be protected by a password or fingerprint unlock.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            setSaving(true);
            try {
              await removePassword();
              update({ fingerprint: false });
              toast('Password removed');
              nav.pop();
            } catch {
              setError('Failed to remove password.');
              setSaving(false);
            }
          },
        },
      ]
    );
  };

  const isMatching = next.length > 0 && confirm.length > 0 && next === confirm;
  const isMismatch = next.length > 0 && confirm.length > 0 && next !== confirm;

  return (
    <Screen>
      <Header title={pw ? 'Change Password' : 'Set Password'} onBack={nav.pop} />
      <Body>
        <View style={{ paddingHorizontal: 20, paddingBottom: 32 }}>
          {/* Hero Header Icon & Summary */}
          <View style={{ alignItems: 'center', paddingVertical: 24 }}>
            <View
              style={{
                width: 76,
                height: 76,
                borderRadius: 38,
                backgroundColor: theme.surface,
                borderWidth: 2,
                borderColor: theme.accent,
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 16,
                shadowColor: theme.accent,
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.25,
                shadowRadius: 10,
                elevation: 4,
              }}
            >
              <Ionicons name="shield-checkmark" size={40} color={theme.accent} />
            </View>
            <T bold size={21} style={{ textAlign: 'center', marginBottom: 6 }}>
              {pw ? 'Change Security Password' : 'Set Security Password'}
            </T>
            <T size={14} dim style={{ textAlign: 'center', maxWidth: 300, lineHeight: 20 }}>
              {pw
                ? 'Enter your new password below to update your security lock.'
                : 'Choose a password of at least 4 characters to protect your notes and private lists.'}
            </T>
          </View>

          {/* Form Fields */}
          <PasswordField
            label="New Password"
            value={next}
            onChange={(t) => {
              setNext(t);
              if (error) setError('');
            }}
            placeholder="At least 4 characters"
            show={showNext}
            onToggleShow={() => setShowNext((v) => !v)}
          />

          <PasswordField
            label="Confirm New Password"
            value={confirm}
            onChange={(t) => {
              setConfirm(t);
              if (error) setError('');
            }}
            placeholder="Re-enter password"
            show={showConfirm}
            onToggleShow={() => setShowConfirm((v) => !v)}
          />

          {/* Real-time match hint */}
          {isMatching ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16, paddingLeft: 4 }}>
              <Ionicons name="checkmark-circle" size={17} color="#10b981" style={{ marginRight: 6 }} />
              <T size={13} bold style={{ color: '#10b981' }}>
                Passwords match
              </T>
            </View>
          ) : isMismatch ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16, paddingLeft: 4 }}>
              <Ionicons name="alert-circle" size={17} color="#fa5252" style={{ marginRight: 6 }} />
              <T size={13} style={{ color: '#fa5252' }}>
                Passwords do not match yet
              </T>
            </View>
          ) : null}

          {error ? (
            <T size={14} bold style={{ color: theme.danger, marginBottom: 14, textAlign: 'center' }}>
              {error}
            </T>
          ) : null}

          <Button
            label={saving ? 'SAVING...' : pw ? 'UPDATE PASSWORD' : 'SET PASSWORD'}
            onPress={save}
            disabled={saving}
          />

          {pw ? (
            <View
              style={{
                marginTop: 36,
                paddingTop: 24,
                borderTopWidth: 1,
                borderTopColor: theme.border,
              }}
            >
              <T size={14} dim style={{ textAlign: 'center', marginBottom: 14 }}>
                Want to disable password protection?
              </T>
              <Button
                label={saving ? 'REMOVING...' : 'REMOVE PASSWORD'}
                onPress={handleRemovePress}
                danger
                disabled={saving}
              />
            </View>
          ) : null}
        </View>
      </Body>
    </Screen>
  );
}
