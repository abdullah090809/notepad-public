import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, BackHandler, Pressable, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppearance } from '../appearance';
import { useSettings } from '../settings';
import {
  authenticateBiometric,
  biometricAvailable,
  cancelReset,
  getResetStartedAt,
  removePassword,
  startReset,
  verifyPassword,
} from '../security';
import { formatRemaining } from '../format';
import { Header, IconBtn, Screen, T } from '../ui';

type Props = {
  mode: 'launch' | 'gate';
  onSuccess: () => void;
  onCancel: () => void;
};

export function LockScreen({ onSuccess, onCancel }: Props) {
  const { theme, inputFont } = useAppearance();
  const { s, update } = useSettings();
  const insets = useSafeAreaInsets();
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [bioReady, setBioReady] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const autoTried = useRef(false);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onCancel();
      return true;
    });
    return () => sub.remove();
  }, [onCancel]);

  const tryFingerprint = useCallback(async () => {
    if (!s.fingerprint) return;
    if (!(await biometricAvailable())) return;
    const ok = await authenticateBiometric('Unlock your notes');
    if (ok) onSuccess();
  }, [s.fingerprint, onSuccess]);

  useEffect(() => {
    let alive = true;
    if (s.fingerprint) {
      biometricAvailable().then((ok) => {
        if (alive) setBioReady(ok);
      });
    }
    if (!autoTried.current) {
      autoTried.current = true;
      tryFingerprint();
    }
    return () => {
      alive = false;
    };
  }, [s.fingerprint, tryFingerprint]);

  const submit = async () => {
    if (!password || verifying) return;
    setVerifying(true);
    try {
      const ok = await verifyPassword(password);
      if (ok) {
        onSuccess();
      } else {
        setError('Incorrect password. Please try again.');
        setPassword('');
      }
    } catch {
      setError('Could not verify password. Please try again.');
    } finally {
      setVerifying(false);
    }
  };

  const forgot = async () => {
    const started = await getResetStartedAt();
    const waitMs = s.resetHours * 3600000;
    if (started === null) {
      Alert.alert(
        'Forgotten your password?',
        `For safety you have to wait ${s.resetHours} hour${s.resetHours === 1 ? '' : 's'} before the password can be removed. Your notes are not deleted. Start the timer now?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Start timer',
            onPress: async () => {
              await startReset();
              Alert.alert(
                'Timer started',
                `Come back in ${s.resetHours} hour${s.resetHours === 1 ? '' : 's'} and tap "Forgotten your password?" again.`
              );
            },
          },
        ]
      );
      return;
    }
    const left = started + waitMs - Date.now();
    if (left > 0) {
      Alert.alert(
        'Please wait',
        `You can remove the password in ${formatRemaining(left)}.`,
        [
          { text: 'OK' },
          {
            text: 'Cancel reset',
            style: 'destructive',
            onPress: () => {
              cancelReset();
            },
          },
        ]
      );
      return;
    }
    Alert.alert(
      'Remove password?',
      'The waiting time is over. The password and fingerprint lock will be removed. Your notes are kept.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove password',
          style: 'destructive',
          onPress: async () => {
            await removePassword();
            update({ fingerprint: false });
            onSuccess();
          },
        },
      ]
    );
  };

  const isBioActive = s.fingerprint && bioReady && !showPassword;

  return (
    <Screen>
      <Header
        title="Authentication"
        onBack={onCancel}
        backIcon="close"
      />

      {isBioActive ? (
        <View style={{ flex: 1, justifyContent: 'space-between' }}>
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 }}>
            <Pressable
              onPress={tryFingerprint}
              accessibilityRole="button"
              accessibilityLabel="Scan fingerprint again"
              style={({ pressed }) => ({
                alignItems: 'center',
                opacity: pressed ? 0.75 : 1,
              })}
            >
              <View
                style={{
                  width: 110,
                  height: 110,
                  borderRadius: 55,
                  backgroundColor: theme.surface,
                  borderWidth: 2,
                  borderColor: theme.accent,
                  alignItems: 'center',
                  justifyContent: 'center',
                  shadowColor: theme.accent,
                  shadowOffset: { width: 0, height: 4 },
                  shadowOpacity: 0.35,
                  shadowRadius: 12,
                  elevation: 6,
                }}
              >
                <Ionicons name="finger-print" size={68} color={theme.accent} />
              </View>
              <T bold size={20} style={{ marginTop: 28, textAlign: 'center' }}>
                Touch the Fingerprint Sensor
              </T>
              <T size={15} dim style={{ marginTop: 8, textAlign: 'center', maxWidth: 280 }}>
                Tap the sensor or icon to authenticate
              </T>
            </Pressable>
          </View>

          <View style={{ paddingHorizontal: 24, paddingBottom: 24 + insets.bottom }}>
            <Pressable
              onPress={() => setShowPassword(true)}
              style={({ pressed }) => ({
                paddingVertical: 14,
                paddingHorizontal: 20,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: theme.border,
                alignItems: 'center',
                backgroundColor: theme.surface,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <T bold size={15} style={{ color: theme.text }}>
                USE PASSWORD INSTEAD
              </T>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={{ flex: 1, justifyContent: 'space-between' }}>
          <View style={{ paddingHorizontal: 24, paddingTop: 24 }}>
            <T size={17} style={{ textAlign: 'center' }}>
              Please enter your password to continue
            </T>

            <View
              style={{
                marginTop: 28,
                flexDirection: 'row',
                alignItems: 'center',
                borderWidth: 1,
                borderColor: theme.border,
                borderRadius: 6,
                paddingLeft: 14,
                backgroundColor: theme.surface,
              }}
            >
              <TextInput
                value={password}
                onChangeText={(t) => {
                  setPassword(t);
                  if (error) setError('');
                }}
                placeholder="Password"
                placeholderTextColor={theme.subtext}
                secureTextEntry={!show}
                autoCapitalize="none"
                autoCorrect={false}
                onSubmitEditing={submit}
                autoFocus
                style={{
                  flex: 1,
                  color: theme.text,
                  fontFamily: inputFont,
                  fontSize: 18,
                  paddingVertical: 14,
                }}
              />
              <IconBtn name={show ? 'eye' : 'eye-off'} onPress={() => setShow((v) => !v)} accessibilityLabel={show ? 'Hide password' : 'Show password'} />
            </View>

            {error ? (
              <T size={15} style={{ color: theme.danger, marginTop: 10, textAlign: 'center' }}>
                {error}
              </T>
            ) : null}

            <Pressable onPress={forgot} style={{ alignSelf: 'center', padding: 14, marginTop: 6 }}>
              <T size={16}>Forgotten your password?</T>
            </Pressable>

            {s.fingerprint && bioReady ? (
              <Pressable
                onPress={() => {
                  setShowPassword(false);
                  tryFingerprint();
                }}
                style={({ pressed }) => ({
                  alignSelf: 'center',
                  paddingVertical: 12,
                  paddingHorizontal: 16,
                  marginTop: 16,
                  flexDirection: 'row',
                  alignItems: 'center',
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <Ionicons name="finger-print" size={20} color={theme.accent} style={{ marginRight: 8 }} />
                <T bold size={15} style={{ color: theme.accent }}>
                  Unlock with Fingerprint
                </T>
              </Pressable>
            ) : null}
          </View>

          <Pressable
            onPress={submit}
            disabled={verifying}
            style={{
              backgroundColor: theme.accent,
              paddingVertical: 18,
              paddingBottom: 18 + insets.bottom,
              alignItems: 'center',
              opacity: verifying ? 0.6 : 1,
            }}
          >
            <T bold size={17} style={{ color: theme.accentText, letterSpacing: 1 }}>
              {verifying ? 'CHECKING...' : 'CONTINUE'}
            </T>
          </Pressable>
        </View>
      )}
    </Screen>
  );
}
