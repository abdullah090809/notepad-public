import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  Image,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { useAppearance } from './appearance';
import { T } from './ui';

interface SplashScreenProps {
  onFinish: () => void;
  /** Whether the underlying app has finished its initial data loading */
  isReady?: boolean;
  /** If true, this is a manual preview from settings */
  isPreview?: boolean;
}

export const SplashScreen: React.FC<SplashScreenProps> = ({
  onFinish,
  isReady = true,
  isPreview = false,
}) => {
  const { theme } = useAppearance();

  // Animations
  const logoScale = useRef(new Animated.Value(0.72)).current;
  const logoOpacity = useRef(new Animated.Value(0)).current;
  const glowScale = useRef(new Animated.Value(0.8)).current;
  const glowOpacity = useRef(new Animated.Value(0)).current;
  const textOpacity = useRef(new Animated.Value(0)).current;
  const textTranslateY = useRef(new Animated.Value(14)).current;
  const badgeOpacity = useRef(new Animated.Value(0)).current;
  const barWidth = useRef(new Animated.Value(0)).current;

  // Exit animation
  const containerOpacity = useRef(new Animated.Value(1)).current;
  const containerScale = useRef(new Animated.Value(1)).current;

  const isExiting = useRef(false);

  const triggerExit = () => {
    if (isExiting.current) return;
    isExiting.current = true;

    Animated.parallel([
      Animated.timing(containerOpacity, {
        toValue: 0,
        duration: 280,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(containerScale, {
        toValue: 1.05,
        duration: 280,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start(() => {
      onFinish();
    });
  };

  useEffect(() => {
    // 1. Logo pop-in + ambient glow
    Animated.parallel([
      Animated.spring(logoScale, {
        toValue: 1,
        friction: 6,
        tension: 40,
        useNativeDriver: true,
      }),
      Animated.timing(logoOpacity, {
        toValue: 1,
        duration: 350,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(glowOpacity, {
        toValue: 0.7,
        duration: 500,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(glowScale, {
        toValue: 1.35,
        duration: 700,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();

    // 2. Staggered Title & Badges
    const textTimer = setTimeout(() => {
      Animated.parallel([
        Animated.timing(textOpacity, {
          toValue: 1,
          duration: 380,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(textTranslateY, {
          toValue: 0,
          duration: 380,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(badgeOpacity, {
          toValue: 1,
          duration: 450,
          delay: 100,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(barWidth, {
          toValue: 1,
          duration: 500,
          delay: 150,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: false,
        }),
      ]).start();
    }, 200);

    // 3. Minimum display time before exiting (1200ms) once ready
    let exitTimer: ReturnType<typeof setTimeout> | null = null;
    const minTime = isPreview ? 1800 : 1200;

    exitTimer = setTimeout(() => {
      if (isReady || isPreview) {
        triggerExit();
      }
    }, minTime);

    return () => {
      clearTimeout(textTimer);
      if (exitTimer) clearTimeout(exitTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady]);

  return (
    <Animated.View
      style={[
        StyleSheet.absoluteFill,
        styles.root,
        {
          backgroundColor: theme.bg,
          opacity: containerOpacity,
          transform: [{ scale: containerScale }],
        },
      ]}
    >
      <Pressable style={styles.pressable} onPress={triggerExit} accessibilityRole="button" accessibilityLabel="Skip intro">
        {/* Ambient Glowing Halo */}
        <Animated.View
          pointerEvents="none"
          style={[
            styles.glowHalo,
            {
              backgroundColor: theme.accent,
              opacity: glowOpacity,
              transform: [{ scale: glowScale }],
            },
          ]}
        />

        {/* Central Logo Box */}
        <Animated.View
          style={[
            styles.iconWrapper,
            {
              opacity: logoOpacity,
              transform: [{ scale: logoScale }],
              shadowColor: theme.accent,
            },
          ]}
        >
          <Image
            source={require('../assets/icon.png')}
            style={styles.logoImage}
            resizeMode="cover"
          />
        </Animated.View>

        {/* Title & Brand Name */}
        <Animated.View
          style={[
            styles.textSection,
            {
              opacity: textOpacity,
              transform: [{ translateY: textTranslateY }],
            },
          ]}
        >
          <T bold size={30} style={[styles.title, { color: theme.text }]}>
            NOTEPAD
          </T>

          {/* Accent Line Indicator */}
          <View style={styles.barTrack}>
            <Animated.View
              style={[
                styles.barFill,
                {
                  backgroundColor: theme.accent,
                  width: barWidth.interpolate({
                    inputRange: [0, 1],
                    outputRange: ['0%', '100%'],
                  }),
                },
              ]}
            />
          </View>

          {/* Tagline / Subtitle */}
          <Animated.View style={{ opacity: badgeOpacity }}>
            <T dim size={12} style={styles.subtitle}>
              PRIVATE • OFFLINE • ENCRYPTED
            </T>
          </Animated.View>
        </Animated.View>

        {/* Bottom subtle note */}
        <Animated.View style={[styles.footer, { opacity: badgeOpacity }]}>
          <T dim size={11} style={styles.footerText}>
            Tap anywhere to start
          </T>
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  root: {
    zIndex: 99999,
  },
  pressable: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glowHalo: {
    position: 'absolute',
    width: 140,
    height: 140,
    borderRadius: 70,
    filter: 'blur(35px)' as any,
  },
  iconWrapper: {
    width: 120,
    height: 120,
    borderRadius: 28,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.5,
    shadowRadius: 24,
    elevation: 12,
  },
  logoImage: {
    width: 120,
    height: 120,
    borderRadius: 28,
  },
  textSection: {
    marginTop: 24,
    alignItems: 'center',
  },
  title: {
    letterSpacing: 4,
    fontWeight: '800',
  },
  barTrack: {
    width: 56,
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 2,
    marginTop: 10,
    marginBottom: 12,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    borderRadius: 2,
  },
  subtitle: {
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  footer: {
    position: 'absolute',
    bottom: 48,
  },
  footerText: {
    letterSpacing: 1,
    opacity: 0.6,
  },
});
