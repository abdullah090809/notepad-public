import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  AppState,
  AppStateStatus,
  BackHandler,
  Easing,
  PanResponder,
  Platform,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as ScreenOrientation from 'expo-screen-orientation';
import * as NavigationBar from 'expo-navigation-bar';
import * as ScreenCapture from 'expo-screen-capture';
import { Ionicons } from '@expo/vector-icons';

import { SettingsProvider, useSettings } from './src/settings';
import { AppearanceProvider, useAppearance } from './src/appearance';
import { NavProvider, Route, useNav } from './src/nav';
import { GateContext, singleFlight } from './src/gate';
import { ToastHost } from './src/ui';
import { authState, hasPassword } from './src/security';
import { startupTasks } from './src/backup';

import { HomeScreen } from './src/screens/Home';
import { NoteEditor } from './src/screens/NoteEditor';
import { ListEditor } from './src/screens/ListEditor';
import { RevisionsScreen } from './src/screens/Revisions';
import { LockScreen } from './src/screens/LockScreen';
import { PasswordScreen, SecuritySettings } from './src/screens/SettingsSecurity';
import {
  CustomThemeScreen,
  GeneralSettings,
  CustomisationSettings,
  LocalisationScreen,
  ScreenBehaviourScreen,
  SettingsMain,
  TextFontScreen,
  TextSizeScreen,
  ThemesScreen,
} from './src/screens/SettingsScreens';
import {
  BackupLogScreen,
  BackupSchedulingScreen,
  DataManagement,
  DeletedItemsScreen,
  TransferNotesScreen,
} from './src/screens/SettingsData';
import { SplashScreen } from './src/SplashScreen';

const KEEP_AWAKE_TAG = 'notepad-keep-awake';
const CAPTURE_TAG = 'notepad-hide-content';

function AnimatedScreen({
  index,
  total,
  poppingIndex,
  onPopComplete,
  canSwipeBack,
  onSwipePop,
  children,
}: {
  index: number;
  total: number;
  poppingIndex: number | null;
  onPopComplete: (index: number) => void;
  /** Edge-swipe back is only offered on screens that need no save step before leaving. */
  canSwipeBack: boolean;
  onSwipePop: () => void;
  children: React.ReactNode;
}) {
  const { width } = useWindowDimensions();
  const anim = useRef(new Animated.Value(index === 0 ? 0 : width)).current;
  const isTop = index === total - 1;
  const isPrevious = index === total - 2;
  const isPoppingThis = poppingIndex === index;

  // iOS-style swipe from the left edge to go back; the screen follows the finger.
  const widthRef = useRef(width);
  widthRef.current = width;
  const swipePopRef = useRef(onSwipePop);
  swipePopRef.current = onSwipePop;
  const edge = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e, g) => g.dx > 6 && Math.abs(g.dy) < Math.abs(g.dx),
      onPanResponderMove: (_e, g) => anim.setValue(Math.max(0, Math.min(g.dx, widthRef.current))),
      onPanResponderRelease: (_e, g) => {
        if (g.dx > widthRef.current * 0.33 || g.vx > 0.6) {
          swipePopRef.current();
        } else {
          Animated.timing(anim, { toValue: 0, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
        }
      },
      onPanResponderTerminate: () => {
        Animated.timing(anim, { toValue: 0, duration: 180, useNativeDriver: true }).start();
      },
    })
  ).current;

  useEffect(() => {
    if (index > 0) {
      Animated.timing(anim, {
        toValue: 0,
        duration: 250,
        easing: Easing.bezier(0.22, 1, 0.36, 1),
        useNativeDriver: true,
      }).start();
    }
  }, [index, anim]);

  useEffect(() => {
    if (isPoppingThis) {
      let done = false;
      const doComplete = () => {
        if (!done) {
          done = true;
          onPopComplete(index);
        }
      };

      const animTask = Animated.timing(anim, {
        toValue: width,
        duration: 230,
        easing: Easing.bezier(0.25, 0.1, 0.25, 1),
        useNativeDriver: true,
      });
      animTask.start(({ finished }) => {
        if (finished) {
          doComplete();
        }
      });

      const safetyTimer = setTimeout(doComplete, 300);
      return () => {
        clearTimeout(safetyTimer);
      };
    }
  }, [isPoppingThis, anim, width, onPopComplete, index]);

  // Subtle soft dimming for the screen underneath without dizzying sideways motion
  const cover = useRef(new Animated.Value(isTop ? 0 : 1)).current;
  useEffect(() => {
    Animated.timing(cover, {
      toValue: isTop && !isPoppingThis ? 0 : 1,
      duration: 240,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [isTop, isPoppingThis, cover]);

  const isVisible = isTop || (isPrevious && (isPoppingThis || total > 1));

  return (
    <Animated.View
      style={[
        StyleSheet.absoluteFill,
        {
          transform: [{ translateX: anim }],
          display: isVisible ? 'flex' : 'none',
          shadowColor: '#000',
          shadowOffset: { width: -3, height: 0 },
          shadowOpacity: index > 0 ? 0.15 : 0,
          shadowRadius: 8,
          elevation: index > 0 ? 6 : 0,
        },
      ]}
      pointerEvents={isTop && !isPoppingThis ? 'auto' : 'none'}
    >
      {children}
      {canSwipeBack && isTop && !isPoppingThis ? (
        <View {...edge.panHandlers} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 20 }} />
      ) : null}
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: '#000',
            opacity: cover.interpolate({ inputRange: [0, 1], outputRange: [0, 0.08] }),
          },
        ]}
      />
    </Animated.View>
  );
}

function renderRoute(route: Route, depth: number): React.ReactNode {
  const p = route.params ?? {};
  const key = `${depth}:${route.name}:${p.id ?? p.folderId ?? ''}`;
  switch (route.name) {
    case 'Home':
      return <HomeScreen key={key} folderId={p.folderId ?? null} />;
    case 'Note':
      return <NoteEditor key={key} id={p.id} isNew={!!p.isNew} />;
    case 'List':
      return <ListEditor key={key} id={p.id} isNew={!!p.isNew} />;
    case 'Revisions':
      return <RevisionsScreen key={key} id={p.id} />;
    case 'Settings':
      return <SettingsMain key={key} />;
    case 'SettingsGeneral':
      return <GeneralSettings key={key} />;
    case 'SettingsCustomisation':
      return <CustomisationSettings key={key} />;
    case 'SecuritySettings':
      return <SecuritySettings key={key} />;
    case 'Password':
      return <PasswordScreen key={key} />;
    case 'Themes':
      return <ThemesScreen key={key} />;
    case 'CustomTheme':
      return <CustomThemeScreen key={key} />;
    case 'Localisation':
      return <LocalisationScreen key={key} />;
    case 'ScreenBehaviour':
      return <ScreenBehaviourScreen key={key} />;
    case 'TextFont':
      return <TextFontScreen key={key} />;
    case 'TextSize':
      return <TextSizeScreen key={key} />;
    case 'SettingsData':
      return <DataManagement key={key} />;
    case 'BackupScheduling':
      return <BackupSchedulingScreen key={key} />;
    case 'BackupLog':
      return <BackupLogScreen key={key} />;
    case 'DeletedItems':
      return <DeletedItemsScreen key={key} />;
    case 'Transfer':
      return <TransferNotesScreen key={key} />;
    default:
      return <HomeScreen key={key} folderId={null} />;
  }
}

function Shell() {
  const { s, update, get, hydrated } = useSettings();
  const { theme } = useAppearance();
  const nav = useNav();

  const [ready, setReady] = useState(false);
  const [splashDone, setSplashDone] = useState(false);
  /** Locked at app start: the lock screen covers the notes until the user unlocks. (The start-up housekeeping below
   *  - trash purge and scheduled backup - still reads the database before unlock.) */
  const [launchLocked, setLaunchLocked] = useState(false);
  /** Locked after being away longer than the inactivity timeout. */
  const [relocked, setRelocked] = useState(false);
  /** Privacy cover shown while the app is in the background / app switcher. */
  const [covered, setCovered] = useState(false);
  const [gateOpen, setGateOpen] = useState(false);
  const gateResolve = useRef<((ok: boolean) => void) | null>(null);
  const leftAt = useRef<number | null>(null);

  /* ----- start up ----- */
  useEffect(() => {
    let alive = true;
    hasPassword().then((has) => {
      if (!alive) return;
      setLaunchLocked(has);
      setReady(true);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Housekeeping (trash purge, scheduled backup) needs the user's real settings, not the defaults
     that are in place until they have been read. */
  useEffect(() => {
    if (hydrated) startupTasks(get(), update);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  /* ----- lock when the app was left for too long ----- */
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') {
        setCovered(false);
        const left = leftAt.current;
        leftAt.current = null;
        if (left !== null && Date.now() - left >= get().inactivitySeconds * 1000) {
          hasPassword().then((has) => {
            if (has) setRelocked(true);
          });
        }
        return;
      }
      // Fingerprint prompts, file pickers and the share sheet also background the app.
      if (authState.busy) {
        leftAt.current = null;
        return;
      }
      if (leftAt.current === null) leftAt.current = Date.now();
      if (get().hideInBackground) setCovered(true);
    });
    return () => sub.remove();
  }, [get]);

  /* ----- ask for the password again (e.g. before opening a locked note) ----- */
  // singleFlight: a second call while the prompt is pending shares the first call's answer
  // (it used to overwrite the resolver, so the first caller never continued).
  const gate = useMemo(
    () =>
      singleFlight(async (): Promise<boolean> => {
        if (!(await hasPassword())) return true;
        return new Promise<boolean>((resolve) => {
          gateResolve.current = resolve;
          setGateOpen(true);
        });
      }),
    []
  );

  const finishGate = (ok: boolean) => {
    setGateOpen(false);
    const resolve = gateResolve.current;
    gateResolve.current = null;
    if (resolve) resolve(ok);
  };

  /* ----- settings that act on the device ----- */
  useEffect(() => {
    if (s.keepAwake) {
      activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => { });
    } else {
      Promise.resolve(deactivateKeepAwake(KEEP_AWAKE_TAG)).catch(() => { });
    }
    return () => {
      Promise.resolve(deactivateKeepAwake(KEEP_AWAKE_TAG)).catch(() => { });
    };
  }, [s.keepAwake]);

  useEffect(() => {
    if (s.orientation === 'portrait') {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => { });
    } else if (s.orientation === 'landscape') {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => { });
    } else {
      ScreenOrientation.unlockAsync().catch(() => { });
    }
  }, [s.orientation]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    // The navigation bar API changed between SDK versions, so look the function up at run time.
    // The app draws behind a transparent bar, so "match" means the button colours follow the
    // app theme instead of the phone's own light/dark setting.
    try {
      const nb = NavigationBar as any;
      const setStyle: ((style: string) => void) | undefined =
        nb.setStyle ?? nb.NavigationBar?.setStyle;
      if (typeof setStyle === 'function') {
        setStyle(s.navBarMatch ? (theme.isDark ? 'light' : 'dark') : 'auto');
      }
    } catch {
      // not supported on this Android version: ignore
    }
  }, [theme.isDark, s.navBarMatch]);

  // On Android this also hides the app in the recent-apps list (and blocks screenshots).
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    if (s.hideInBackground) {
      ScreenCapture.preventScreenCaptureAsync(CAPTURE_TAG).catch(() => { });
    } else {
      ScreenCapture.allowScreenCaptureAsync(CAPTURE_TAG).catch(() => { });
    }
  }, [s.hideInBackground]);

  if (!ready && !s.splashAnimation) {
    return <View style={{ flex: 1, backgroundColor: theme.bg }} />;
  }

  const showLock = ready && (launchLocked || relocked);
  const showSplash = s.splashAnimation && !splashDone;

  return (
    <GateContext.Provider value={gate}>
      <View style={{ flex: 1, backgroundColor: theme.bg }}>
        <StatusBar style={theme.isDark ? 'light' : 'dark'} />

        {/* Notes and previous screens stay mounted with smooth native slide transition animations */}
        {ready && !launchLocked
          ? nav.stack.map((route, idx) => {
              const p = route.params ?? {};
              const key = `stack-${idx}-${route.name}-${p.id ?? p.folderId ?? ''}`;
              return (
                <AnimatedScreen
                  key={key}
                  index={idx}
                  total={nav.stack.length}
                  poppingIndex={nav.poppingIndex}
                  onPopComplete={nav.finishPop}
                  canSwipeBack={idx > 0 && route.name !== 'Note' && route.name !== 'List'}
                  onSwipePop={nav.pop}
                >
                  {renderRoute(route, idx)}
                </AnimatedScreen>
              );
            })
          : null}

        {showLock ? (
          <View style={StyleSheet.absoluteFill}>
            <LockScreen
              key="lock-launch"
              mode="launch"
              onSuccess={() => {
                setLaunchLocked(false);
                setRelocked(false);
              }}
              onCancel={() => {
                if (Platform.OS === 'android') BackHandler.exitApp();
              }}
            />
          </View>
        ) : null}

        {gateOpen && !showLock ? (
          <View style={StyleSheet.absoluteFill}>
            <LockScreen
              key="lock-gate"
              mode="gate"
              onSuccess={() => finishGate(true)}
              onCancel={() => finishGate(false)}
            />
          </View>
        ) : null}

        <ToastHost />

        {covered ? (
          <View
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center' },
            ]}
          >
            <Ionicons name="lock-closed" size={64} color={theme.subtext} />
          </View>
        ) : null}

        {/* Opening Animation */}
        {showSplash ? (
          <SplashScreen
            isReady={ready}
            onFinish={() => setSplashDone(true)}
          />
        ) : null}
      </View>
    </GateContext.Provider>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <SettingsProvider>
        <AppearanceProvider>
          <NavProvider>
            <Shell />
          </NavProvider>
        </AppearanceProvider>
      </SettingsProvider>
    </SafeAreaProvider>
  );
}