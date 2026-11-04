import React, { useEffect, useState } from 'react';
import { Alert, Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { FONT_OPTIONS, SIZE_LABELS, resolveFont, useAppearance } from '../appearance';
import { deleteAllRevisions } from '../db';
import { useNav } from '../nav';
import { useSettings } from '../settings';
import { useAppLocked } from '../gate';
import {
  DEFAULT_CUSTOM,
  THEME_ORDER,
  ThemeId,
  isHex,
  swatchColor,
  swatchTextColor,
  themeName,
} from '../theme';
import {
  Body,
  Button,
  CheckRow,
  ChoiceModal,
  Header,
  InfoText,
  RadioRow,
  Row,
  Screen,
  SectionTitle,
  T,
  confirm,
  toast,
} from '../ui';

/* ------------------------------------------------------------------ */
/* Settings hub                                                        */
/* ------------------------------------------------------------------ */

function SettingsNavRow({
  icon,
  iconBg,
  title,
  subtitle,
  onPress,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  iconBg: string;
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  const { theme } = useAppearance();
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: theme.border }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 14,
        paddingHorizontal: 16,
        backgroundColor: pressed ? `${theme.border}44` : 'transparent',
      })}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${subtitle}`}
    >
      <View
        pointerEvents="none"
        style={{
          width: 38,
          height: 38,
          borderRadius: 10,
          backgroundColor: iconBg,
          alignItems: 'center',
          justifyContent: 'center',
          marginRight: 14,
        }}
      >
        <Ionicons name={icon} size={20} color="#ffffff" />
      </View>
      <View pointerEvents="none" style={{ flex: 1, paddingRight: 8 }}>
        <T size={16} bold style={{ color: theme.text }}>
          {title}
        </T>
        <T size={12} dim style={{ marginTop: 2, color: theme.subtext }}>
          {subtitle}
        </T>
      </View>
      <Ionicons pointerEvents="none" name="chevron-forward" size={18} color={theme.subtext} />
    </Pressable>
  );
}

export function SettingsMain() {
  const nav = useNav();
  const { theme } = useAppearance();

  return (
    <Screen>
      <Header title="Settings" onBack={nav.pop} backIcon="close" />
      <Body>
        {/* Sleek App Banner */}
        <View
          style={{
            marginHorizontal: 16,
            marginTop: 16,
            marginBottom: 20,
            padding: 16,
            borderRadius: 16,
            backgroundColor: theme.surface,
            borderWidth: 1,
            borderColor: theme.border,
            flexDirection: 'row',
            alignItems: 'center',
          }}
        >
          <Image
            source={require('../../assets/icon.png')}
            style={{
              width: 50,
              height: 50,
              borderRadius: 13,
              marginRight: 14,
            }}
            resizeMode="cover"
          />
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <T bold size={18} style={{ color: theme.text, letterSpacing: 0.5 }}>
                Notepad
              </T>
              <View
                style={{
                  marginLeft: 8,
                  paddingHorizontal: 7,
                  paddingVertical: 2,
                  borderRadius: 6,
                  backgroundColor: `${theme.accent}20`,
                }}
              >
                <T bold size={10} style={{ color: theme.accent }}>
                  v1.0.0
                </T>
              </View>
            </View>
            <T dim size={12} style={{ marginTop: 3 }}>
              Offline • Private • Locked notes encrypted
            </T>
          </View>
          <View
            style={{
              width: 32,
              height: 32,
              borderRadius: 16,
              backgroundColor: '#10b98118',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ionicons name="shield-checkmark" size={17} color="#10b981" />
          </View>
        </View>

        {/* Grouped Category Card */}
        <View
          style={{
            marginHorizontal: 16,
            borderRadius: 16,
            backgroundColor: theme.surface,
            borderWidth: 1,
            borderColor: theme.border,
            overflow: 'hidden',
            marginBottom: 20,
          }}
        >
          <SettingsNavRow
            icon="settings-sharp"
            iconBg="#3b82f6"
            title="General"
            subtitle="Dashboard layout, preview & lists"
            onPress={() => nav.push('SettingsGeneral')}
          />
          <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.border, marginLeft: 68 }} />
          <SettingsNavRow
            icon="color-palette"
            iconBg="#8b5cf6"
            title="App Customisation"
            subtitle="Themes, fonts, display & orientation"
            onPress={() => nav.push('SettingsCustomisation')}
          />
          <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.border, marginLeft: 68 }} />
          <SettingsNavRow
            icon="shield-checkmark"
            iconBg="#10b981"
            title="App Security"
            subtitle="Password, fingerprint & auto-lock"
            onPress={() => nav.push('SecuritySettings')}
          />
          <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.border, marginLeft: 68 }} />
          <SettingsNavRow
            icon="file-tray-full"
            iconBg="#f59e0b"
            title="Data Management"
            subtitle="Backups, export, revisions & trash"
            onPress={() => nav.push('SettingsData')}
          />
        </View>

        {/* Reassuring Architecture Guarantee Card */}
        <View
          style={{
            marginHorizontal: 16,
            padding: 16,
            borderRadius: 16,
            backgroundColor: theme.isDark ? '#0d1117' : '#f8f9fa',
            borderWidth: 1,
            borderColor: theme.border,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
            <Ionicons name="lock-closed" size={15} color={theme.accent} style={{ marginRight: 8 }} />
            <T bold size={13} style={{ color: theme.text }}>
              Local Device Storage
            </T>
          </View>
          <T dim size={12} style={{ lineHeight: 18, color: theme.subtext }}>
            Your notes and revisions are stored solely on this device. No trackers, no accounts, and zero cloud uploads.
          </T>
        </View>
      </Body>
    </Screen>
  );
}

/* ------------------------------------------------------------------ */
/* General                                                             */
/* ------------------------------------------------------------------ */

export function GeneralSettings() {
  const nav = useNav();
  const { s, update } = useSettings();

  const clearRevisions = () => {
    confirm(
      'Delete all saved revisions?',
      'The earlier versions of your notes and lists will be removed. Your current notes are not changed.',
      'Delete',
      async () => {
        try {
          await deleteAllRevisions();
        } catch (e) {
          Alert.alert('Could not delete revisions', String(e instanceof Error ? e.message : e));
          return;
        }
        toast('All saved revisions deleted');
      },
      true
    );
  };

  return (
    <Screen>
      <Header title="General" onBack={nav.pop} />
      <Body>
        <SectionTitle>Dashboard</SectionTitle>
        <CheckRow
          label="Allow the titles of my notes, lists and folders to span multiple lines"
          value={s.multilineTitles}
          onChange={(v) => update({ multilineTitles: v })}
        />
        <CheckRow
          label="Show a small preview of my lists and notes beneath their titles"
          value={s.showPreview}
          onChange={(v) => update({ showPreview: v })}
        />
        <CheckRow
          label="Show the last modified time of items beneath their titles"
          value={s.showModified}
          onChange={(v) => update({ showModified: v })}
        />
        <CheckRow
          label="Include seconds when showing the last modified time of an item on the dashboard"
          value={s.showSeconds}
          onChange={(v) => update({ showSeconds: v })}
        />

        <SectionTitle>Dashboard - Item Icons</SectionTitle>
        <CheckRow
          label="Notes: show icon"
          value={s.iconNotes}
          onChange={(v) => update({ iconNotes: v })}
        />
        <CheckRow
          label="Lists: show icon and progress overview"
          value={s.iconLists}
          onChange={(v) => update({ iconLists: v })}
        />
        <CheckRow
          label="Lists: include coloured progress chips beneath percentages"
          value={s.chipsLists}
          onChange={(v) => update({ chipsLists: v })}
        />
        <CheckRow
          label="Folders: show icon and amount of items inside"
          value={s.iconFolders}
          onChange={(v) => update({ iconFolders: v })}
        />

        <SectionTitle>Dashboard - Item Ordering</SectionTitle>
        <RadioRow
          label="Order my notes, lists and folders alphabetically"
          selected={s.ordering === 'alpha'}
          onPress={() => update({ ordering: 'alpha' })}
        />
        <RadioRow
          label="Allow me to drag & reorder my notes, lists and folders as I wish"
          selected={s.ordering === 'custom'}
          onPress={() => update({ ordering: 'custom' })}
        />

        <SectionTitle>Notes</SectionTitle>
        <CheckRow
          label="Jump to the end of a note when I open it"
          value={s.openAtEnd}
          onChange={(v) => update({ openAtEnd: v })}
        />
        <InfoText>
          There is no limit on how much text a note can hold. You can also jump to the end of any
          note from its menu.
        </InfoText>

        <SectionTitle>Item Revisions</SectionTitle>
        <CheckRow
          label="Save revision copies of my notes/lists when I make changes to them"
          value={s.saveRevisions}
          onChange={(v) => update({ saveRevisions: v })}
        />
        <Row title="Delete all of my saved revisions" onPress={clearRevisions} />

        <SectionTitle>Lists</SectionTitle>
        <CheckRow
          label="Move an item to the bottom of the list when you check it"
          value={s.listCheckedToBottom}
          onChange={(v) => update({ listCheckedToBottom: v })}
        />
        <CheckRow
          label="Move an item to the top of the list when you uncheck it"
          value={s.listUncheckedToTop}
          onChange={(v) => update({ listUncheckedToTop: v })}
        />
        <CheckRow
          label="Display progress indicator above list items"
          value={s.listProgressAbove}
          onChange={(v) => update({ listProgressAbove: v })}
        />

        <SectionTitle>Lists - Progress Bar Type</SectionTitle>
        <RadioRow
          label="Fraction - Example: 7/21"
          selected={s.progressType === 'fraction'}
          onPress={() => update({ progressType: 'fraction' })}
        />
        <RadioRow
          label="Percentage - Example: 33.33%"
          selected={s.progressType === 'percent'}
          onPress={() => update({ progressType: 'percent' })}
        />
        <RadioRow
          label="Both (fraction first) - Example: 7/21 (33.33%)"
          selected={s.progressType === 'fractionFirst'}
          onPress={() => update({ progressType: 'fractionFirst' })}
        />
        <RadioRow
          label="Both (percentage first) - Example: 33.33% (7/21)"
          selected={s.progressType === 'percentFirst'}
          onPress={() => update({ progressType: 'percentFirst' })}
        />

        <SectionTitle>Sharing Text</SectionTitle>
        <CheckRow
          label="When sharing a note or list, include the title in the shared text body"
          value={s.shareIncludeTitle}
          onChange={(v) => update({ shareIncludeTitle: v })}
        />
        <CheckRow
          label="Attempt to set the email subject field to the note/list title when sharing text"
          value={s.shareEmailSubject}
          onChange={(v) => update({ shareEmailSubject: v })}
        />
      </Body>
    </Screen>
  );
}

/* ------------------------------------------------------------------ */
/* App customisation hub                                               */
/* ------------------------------------------------------------------ */

export function CustomisationSettings() {
  const nav = useNav();
  return (
    <Screen>
      <Header title="App Customisation" onBack={nav.pop} />
      <Body>
        <Row title="App Colour Themes" onPress={() => nav.push('Themes')} right="chevron" />
        <Row title="Localisation" onPress={() => nav.push('Localisation')} right="chevron" />
        <Row title="Screen Behaviour" onPress={() => nav.push('ScreenBehaviour')} right="chevron" />
        <Row title="Text Font" onPress={() => nav.push('TextFont')} right="chevron" />
        <Row title="Text Size" onPress={() => nav.push('TextSize')} right="chevron" />
      </Body>
    </Screen>
  );
}

/* ------------------------------------------------------------------ */
/* Colour themes                                                       */
/* ------------------------------------------------------------------ */

const RAINBOW = ['#ffffff', '#f39a32', '#16703b', '#7b3fa0', '#7f1626', '#000000'];

function ThemeRow({
  id,
  selected,
  onPress,
}: {
  id: ThemeId;
  selected: boolean;
  onPress: () => void;
}) {
  const { theme } = useAppearance();
  const isCustom = id === 'custom';
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: 'row',
        height: 88,
        borderBottomWidth: 1,
        borderBottomColor: theme.border,
      }}
    >
      <View
        style={{
          width: '48%',
          backgroundColor: isCustom ? '#444444' : swatchColor(id),
          alignItems: 'center',
          justifyContent: 'center',
          borderRightWidth: 1,
          borderRightColor: theme.border,
          overflow: 'hidden',
        }}
      >
        {isCustom ? (
          <View style={[StyleSheet.absoluteFill, { flexDirection: 'row' }]}>
            {RAINBOW.map((c) => (
              <View key={c} style={{ flex: 1, backgroundColor: c }} />
            ))}
          </View>
        ) : null}
        <Text
          style={{
            color: isCustom ? '#ffffff' : swatchTextColor(id),
            fontWeight: '700',
            fontSize: 17,
            textAlign: 'center',
            paddingHorizontal: 6,
            textShadowColor: isCustom ? 'rgba(0,0,0,0.7)' : 'transparent',
            textShadowRadius: 4,
          }}
        >
          {themeName(id)}
        </Text>
      </View>
      <View
        pointerEvents="none"
        style={{
          flex: 1,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: 8,
        }}
      >
        {selected ? <T size={16}>Currently Selected</T> : null}
        {!selected || isCustom ? (
          <Ionicons
            pointerEvents="none"
            name="chevron-forward"
            size={22}
            color={theme.text}
            style={{ marginLeft: selected ? 8 : 0 }}
          />
        ) : null}
      </View>
    </Pressable>
  );
}

export function ThemesScreen() {
  const nav = useNav();
  const { s, update } = useSettings();
  const { theme } = useAppearance();

  const choose = (id: ThemeId) => {
    update({ themeId: id });
    if (id === 'custom') nav.push('CustomTheme');
  };

  const segment = (label: string, icon: 'moon' | 'sunny', active: boolean, onPress: () => void) => (
    <Pressable
      onPress={onPress}
      style={{
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 14,
        backgroundColor: active ? theme.accent : 'transparent',
      }}
    >
      <Ionicons name={icon} size={20} color={active ? theme.accentText : theme.text} />
      <Text
        style={{
          marginLeft: 8,
          fontWeight: '700',
          fontSize: 16,
          color: active ? theme.accentText : theme.text,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );

  return (
    <Screen>
      <Header title="App Colour Themes" onBack={nav.pop} />
      <Body>
        <View
          style={{
            flexDirection: 'row',
            margin: 16,
            borderWidth: 1,
            borderColor: theme.border,
            borderRadius: 8,
            overflow: 'hidden',
          }}
        >
          {segment('Dark', 'moon', theme.isDark, () => update({ themeId: 'dark' }))}
          {segment('Light', 'sunny', !theme.isDark, () => update({ themeId: 'cloudWhite' }))}
        </View>
        <View style={{ borderTopWidth: 1, borderTopColor: theme.border }}>
          {THEME_ORDER.map((id) => (
            <ThemeRow key={id} id={id} selected={s.themeId === id} onPress={() => choose(id)} />
          ))}
        </View>
      </Body>
    </Screen>
  );
}

const PALETTE = [
  '#000000',
  '#101820',
  '#1a1a2e',
  '#272a36',
  '#16703b',
  '#7f1626',
  '#b71c1c',
  '#795548',
  '#607d8b',
  '#3f51b5',
  '#2196f3',
  '#00bcd4',
  '#4caf50',
  '#8bc34a',
  '#ffeb3b',
  '#f9a825',
  '#ff5722',
  '#f39a32',
  '#e91e63',
  '#9c27b0',
  '#e8e8e8',
  '#f2f2f2',
  '#ffffff',
  '#111111',
];

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
}) {
  const { theme } = useAppearance();
  const appLocked = useAppLocked();
  const [hex, setHex] = useState(value);

  useEffect(() => {
    setHex(value);
  }, [value]);

  return (
    <View>
      <SectionTitle>{label}</SectionTitle>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 12 }}>
        {PALETTE.map((c) => (
          <Pressable
            key={c}
            onPress={() => onChange(c)}
            accessibilityRole="button"
            accessibilityLabel={`Colour ${c}`}
            style={{
              width: 40,
              height: 40,
              margin: 4,
              borderRadius: 20,
              backgroundColor: c,
              borderWidth: c.toLowerCase() === value.toLowerCase() ? 3 : 1,
              borderColor: c.toLowerCase() === value.toLowerCase() ? theme.accent : theme.border,
            }}
          />
        ))}
      </View>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          marginHorizontal: 16,
          marginTop: 8,
        }}
      >
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: 6,
            backgroundColor: isHex(hex) ? hex : value,
            borderWidth: 1,
            borderColor: theme.border,
          }}
        />
        <TextInput
          value={hex}
          onChangeText={(t) => {
            const v = t.startsWith('#') ? t : '#' + t;
            setHex(v);
            if (isHex(v)) onChange(v.toLowerCase());
          }}
          editable={!appLocked}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={7}
          placeholder="#rrggbb"
          placeholderTextColor={theme.subtext}
          style={{
            flex: 1,
            marginLeft: 12,
            borderWidth: 1,
            borderColor: isHex(hex) ? theme.border : theme.danger,
            borderRadius: 6,
            paddingHorizontal: 12,
            paddingVertical: 10,
            color: theme.text,
            fontSize: 16,
          }}
        />
      </View>
    </View>
  );
}

export function CustomThemeScreen() {
  const nav = useNav();
  const { s, update } = useSettings();

  // Editing the colours means you want to use them.
  useEffect(() => {
    if (s.themeId !== 'custom') update({ themeId: 'custom' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Screen>
      <Header title="Custom Theme" onBack={nav.pop} />
      <Body>
        <InfoText>
          Pick the colours for your own theme. The whole app changes as you choose, so you can see
          the result straight away.
        </InfoText>
        <ColorField
          label="Background"
          value={s.custom.bg}
          onChange={(bg) => update({ themeId: 'custom', custom: { ...s.custom, bg } })}
        />
        <ColorField
          label="Text"
          value={s.custom.text}
          onChange={(text) => update({ themeId: 'custom', custom: { ...s.custom, text } })}
        />
        <ColorField
          label="Accent (buttons and ticks)"
          value={s.custom.accent}
          onChange={(accent) => update({ themeId: 'custom', custom: { ...s.custom, accent } })}
        />
        <View style={{ padding: 16, marginTop: 8 }}>
          <Button
            label="RESET TO DEFAULT COLOURS"
            onPress={() => update({ themeId: 'custom', custom: DEFAULT_CUSTOM })}
          />
        </View>
      </Body>
    </Screen>
  );
}

/* ------------------------------------------------------------------ */
/* Localisation                                                        */
/* ------------------------------------------------------------------ */

export function LocalisationScreen() {
  const nav = useNav();
  const { s, update } = useSettings();
  return (
    <Screen>
      <Header title="Localisation" onBack={nav.pop} />
      <Body>
        <SectionTitle>Date Format</SectionTitle>
        <RadioRow
          label="Format dates to DD/MM/YYYY"
          selected={s.dateFormat === 'DMY'}
          onPress={() => update({ dateFormat: 'DMY' })}
        />
        <RadioRow
          label="Format dates to MM/DD/YYYY"
          selected={s.dateFormat === 'MDY'}
          onPress={() => update({ dateFormat: 'MDY' })}
        />
        <RadioRow
          label="Format dates to YYYY/MM/DD"
          selected={s.dateFormat === 'YMD'}
          onPress={() => update({ dateFormat: 'YMD' })}
        />

        <SectionTitle>Title Capitalisation</SectionTitle>
        <RadioRow
          label="Capitalise every new word in title fields"
          selected={s.titleCaps === 'words'}
          onPress={() => update({ titleCaps: 'words' })}
        />
        <RadioRow
          label="Capitalise every new sentence in title fields"
          selected={s.titleCaps === 'sentences'}
          onPress={() => update({ titleCaps: 'sentences' })}
        />
      </Body>
    </Screen>
  );
}

/* ------------------------------------------------------------------ */
/* Screen behaviour                                                    */
/* ------------------------------------------------------------------ */

export function ScreenBehaviourScreen() {
  const nav = useNav();
  const { s, update } = useSettings();

  return (
    <Screen>
      <Header title="Screen Behaviour" onBack={nav.pop} />
      <Body>
        <SectionTitle>Screen Orientation</SectionTitle>
        <RadioRow
          label="Allow this app to rotate orientation with your device"
          selected={s.orientation === 'auto'}
          onPress={() => update({ orientation: 'auto' })}
        />
        <RadioRow
          label="Lock this app to portrait only"
          selected={s.orientation === 'portrait'}
          onPress={() => update({ orientation: 'portrait' })}
        />
        <RadioRow
          label="Lock this app to landscape only"
          selected={s.orientation === 'landscape'}
          onPress={() => update({ orientation: 'landscape' })}
        />

        <SectionTitle>Display</SectionTitle>
        <CheckRow
          label="Prevent my device from locking due to inactivity when this app is open"
          value={s.keepAwake}
          onChange={(v) => update({ keepAwake: v })}
        />
        <CheckRow
          label="Set the navigation bar (back/home/overview button area) to match the app background colour"
          value={s.navBarMatch}
          onChange={(v) => update({ navBarMatch: v })}
        />

        <SectionTitle>App Launch & Animations</SectionTitle>
        <CheckRow
          label="Show smooth animated splash when opening the app"
          value={s.splashAnimation}
          onChange={(v) => update({ splashAnimation: v })}
        />
      </Body>
    </Screen>
  );
}

/* ------------------------------------------------------------------ */
/* Text font and size                                                  */
/* ------------------------------------------------------------------ */

function fontLabel(id: string): string {
  return FONT_OPTIONS.find((f) => f.id === id)?.label ?? 'Device Default';
}

export function TextFontScreen() {
  const nav = useNav();
  const { s, update } = useSettings();
  const [which, setWhich] = useState<'dash' | 'input' | null>(null);

  const options = FONT_OPTIONS.map((f) => ({ label: f.label, value: f.id }));

  return (
    <Screen>
      <Header title="Text Font" onBack={nav.pop} />
      <Body>
        <InfoText>
          You can change the fonts used globally throughout the app here. Changing the fonts will
          not leave any permanent changes to your notes.
        </InfoText>
        <Row
          title="Dashboard Font"
          subtitle={fontLabel(s.dashFont)}
          onPress={() => setWhich('dash')}
          right="chevron"
        />
        <Row
          title="Input Field Font"
          subtitle={fontLabel(s.inputFont)}
          onPress={() => setWhich('input')}
          right="chevron"
        />
        <View style={{ paddingHorizontal: 16, paddingTop: 20 }}>
          <T dim size={14}>
            Preview
          </T>
          <T size={18} style={{ marginTop: 6, fontFamily: resolveFont(s.dashFont) }}>
            Dashboard: The quick brown fox jumps over the lazy dog
          </T>
          <T size={18} style={{ marginTop: 10, fontFamily: resolveFont(s.inputFont) }}>
            Notes: The quick brown fox jumps over the lazy dog
          </T>
        </View>
      </Body>

      <ChoiceModal
        visible={which === 'dash'}
        title="Dashboard Font"
        options={options}
        value={s.dashFont}
        onSelect={(v) => update({ dashFont: v })}
        onClose={() => setWhich(null)}
      />
      <ChoiceModal
        visible={which === 'input'}
        title="Input Field Font"
        options={options}
        value={s.inputFont}
        onSelect={(v) => update({ inputFont: v })}
        onClose={() => setWhich(null)}
      />
    </Screen>
  );
}

export function TextSizeScreen() {
  const nav = useNav();
  const { s, update } = useSettings();
  return (
    <Screen>
      <Header title="Text Size" onBack={nav.pop} />
      <Body>
        <View style={{ height: 8 }} />
        {SIZE_LABELS.map((o) => (
          <RadioRow
            key={o.id}
            label={o.label}
            selected={s.textSize === o.id}
            onPress={() => update({ textSize: o.id })}
          />
        ))}
      </Body>
    </Screen>
  );
}
