import React from 'react';
import { Image, ImageStyle, StyleSheet, View, ViewStyle } from 'react-native';
import { useAppearance } from './appearance';
import { T } from './ui';

export type LogoSize = 'sm' | 'md' | 'lg' | 'hero';

const SIZES: Record<LogoSize, { icon: number; radius: number; title: number; subtitle: number }> = {
  sm: { icon: 32, radius: 8, title: 15, subtitle: 10 },
  md: { icon: 48, radius: 12, title: 18, subtitle: 11 },
  lg: { icon: 80, radius: 20, title: 22, subtitle: 12 },
  hero: { icon: 110, radius: 26, title: 28, subtitle: 13 },
};

interface AppLogoProps {
  size?: LogoSize;
  showText?: boolean;
  withGlow?: boolean;
  style?: ViewStyle;
  iconStyle?: ImageStyle;
}

export const AppLogo = React.memo(function AppLogo({
  size = 'md',
  showText = false,
  withGlow = false,
  style,
  iconStyle,
}: AppLogoProps) {
  const { theme } = useAppearance();
  const cfg = SIZES[size];

  return (
    <View style={[styles.container, style]}>
      <View
        style={[
          styles.iconContainer,
          {
            width: cfg.icon,
            height: cfg.icon,
            borderRadius: cfg.radius,
            shadowColor: withGlow ? theme.accent : '#000',
            shadowOpacity: withGlow ? 0.45 : 0.25,
            shadowRadius: withGlow ? 16 : 8,
            elevation: withGlow ? 10 : 5,
          },
        ]}
      >
        <Image
          source={require('../assets/icon.png')}
          style={[
            styles.image,
            {
              width: cfg.icon,
              height: cfg.icon,
              borderRadius: cfg.radius,
            },
            iconStyle,
          ]}
          resizeMode="cover"
        />
        {withGlow && (
          <View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              {
                borderRadius: cfg.radius,
                borderWidth: 1.5,
                borderColor: `${theme.accent}66`,
              },
            ]}
          />
        )}
      </View>

      {showText && (
        <View style={styles.textContainer}>
          <T bold size={cfg.title} style={[styles.title, { color: theme.text }]}>
            Notepad
          </T>
          <T dim size={cfg.subtitle} style={styles.subtitle}>
            Private • Offline • Locked notes encrypted
          </T>
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconContainer: {
    shadowOffset: { width: 0, height: 4 },
  },
  image: {
    backgroundColor: '#0F172A',
  },
  textContainer: {
    marginTop: 10,
    alignItems: 'center',
  },
  title: {
    letterSpacing: 1.5,
  },
  subtitle: {
    letterSpacing: 1,
    marginTop: 3,
    textTransform: 'uppercase',
  },
});
