/**
 * Settings › Theme: the appearance (dark, light, or the phone's own) and the
 * accent colour of whichever one is on screen — each keeps its own. All of it
 * applies the moment it is chosen.
 *
 * The light one carries "(experimental)" in its own label rather than a warning
 * off to one side. It is a whole second palette across every screen in the app,
 * and the odds are that somewhere a corner of it still wants adjusting: the word
 * belongs where the choice is made, so nobody picks it and then wonders whether
 * what they are looking at is on purpose.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { SelectList, SettingsPage, settingsStyles, SwitchList } from '@/components/SettingsUI';
import { useT } from '@/i18n';
import { systemAccentAvailable } from '@/lib/materialYou';
import { ACCENT_OPTIONS, useSettings } from '@/store/settings';
import {
  colors,
  fontSize,
  onColor,
  radius,
  spacing,
  themed,
  type ThemePreference,
  useThemeMode,
} from '@/theme';

/** `#RRGGBB` out of whatever was typed, or null. Six digits only: the settings
 *  store refuses anything else when it reads the accent back from disk. */
function parseHex(text: string): string | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(text.trim());
  return m ? `#${m[1].toUpperCase()}` : null;
}

/** The row of colours. Which appearance it is picking for is the one on screen;
 *  see the note where it is used. `disabled` while the device's own accent is
 *  in force: the tick still says what would come back, but none of it applies. */
function Swatches({
  value,
  disabled,
  onPick,
}: {
  value: string;
  disabled: boolean;
  onPick: (hex: string) => void;
}) {
  const t = useT();
  const isActive = (hex: string) => hex.toLowerCase() === value.toLowerCase();
  // A colour typed in below is not one of the twelve, and a row where nothing
  // is ticked would say the setting is unset. It gets a swatch of its own at
  // the end, for as long as it is the one in force.
  const custom = ACCENT_OPTIONS.some((opt) => isActive(opt.color)) ? null : value;
  const swatch = (hex: string, label: string) => (
    <Pressable
      key={hex}
      onPress={() => onPick(hex)}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected: isActive(hex) }}
      style={[styles.swatch, { backgroundColor: hex }, isActive(hex) && styles.swatchActive]}
    >
      {/* The swatches are the colours as named — the vivid ones — in both
          appearances, and the tick is whichever of black and white reads on
          each: black on all twelve, either on a typed-in colour. What the light
          theme paints with is a darkened version of whichever one is picked
          (see `readableOn` in the theme): the same colour, taken down to where
          it can be read on white. */}
      {isActive(hex) ? <Ionicons name="checkmark" size={24} color={onColor(hex)} /> : null}
    </Pressable>
  );
  return (
    <View style={[styles.swatches, disabled && styles.dimmed]}>
      {ACCENT_OPTIONS.map((opt) => swatch(opt.color, t(opt.name)))}
      {custom ? swatch(custom, t('Custom color')) : null}
    </View>
  );
}

/**
 * Any colour at all, typed as hex. Applied on the button and not on every
 * keystroke: the accent repaints the whole app, and a half-typed `#1D` is not a
 * colour anybody asked for. The dot beside the label previews what has been
 * typed so far, the moment it is a colour.
 */
function CustomColor({
  value,
  disabled,
  onApply,
}: {
  value: string;
  disabled: boolean;
  onApply: (hex: string) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(value);
  const parsed = parseHex(draft);
  const canApply = !disabled && parsed !== null && parsed.toLowerCase() !== value.toLowerCase();
  return (
    <View style={[settingsStyles.cardBox, settingsStyles.textRow, disabled && styles.dimmed]}>
      <View style={settingsStyles.textRowTop}>
        <View style={settingsStyles.rowLabelBox}>
          <Text style={settingsStyles.rowLabel}>{t('Custom color')}</Text>
        </View>
        <View style={[styles.preview, { backgroundColor: parsed ?? colors.surfaceHighlight }]} />
      </View>
      <View style={styles.customRow}>
        <TextInput
          style={[settingsStyles.textInput, styles.customInput]}
          value={draft}
          onChangeText={setDraft}
          editable={!disabled}
          onSubmitEditing={() => parsed && canApply && onApply(parsed)}
          placeholder="#RRGGBB"
          placeholderTextColor={colors.textMuted}
          maxLength={7}
          autoCapitalize="characters"
          autoCorrect={false}
          returnKeyType="done"
          accessibilityLabel={t('Custom color')}
        />
        <Pressable
          onPress={() => parsed && onApply(parsed)}
          disabled={!canApply}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canApply }}
          style={[
            styles.applyButton,
            { backgroundColor: canApply ? colors.accent : colors.surfaceHighlight },
          ]}
        >
          <Text style={[styles.applyText, { color: canApply ? colors.onAccent : colors.textMuted }]}>
            {t('Apply')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function ThemeSettings() {
  // Repaints on a change of appearance or accent: a stack keeps this screen
  // mounted while you are on another one, out of reach of anything else. The
  // appearance is also read, since it is the one being given a colour.
  const mode = useThemeMode();
  const t = useT();
  const accentColor = useSettings((s) => s.accentColor);
  const accentColorLight = useSettings((s) => s.accentColorLight);
  const setAccentColor = useSettings((s) => s.setAccentColor);
  const systemAccent = useSettings((s) => s.systemAccent);
  const setSystemAccent = useSettings((s) => s.setSystemAccent);
  const themeMode = useSettings((s) => s.themeMode);
  const setThemeMode = useSettings((s) => s.setThemeMode);
  const pureBlack = useSettings((s) => s.pureBlack);
  const setPureBlack = useSettings((s) => s.setPureBlack);
  const accent = mode === 'light' ? accentColorLight : accentColor;
  // Whether the device's accent is the one on screen. The swatches then go
  // grey rather than away: they are the choice kept underneath, for when the
  // switch goes back off.
  const usingSystem = systemAccentAvailable && systemAccent;

  return (
    <SettingsPage title={t('Theme')}>
      <ScrollView contentContainerStyle={settingsStyles.content} keyboardShouldPersistTaps="handled">
        {/* "Mode" and not "Appearance": Appearance is the screen this one hangs
            off, and two headings with the same word one level apart read as a
            mistake. */}
        <Text style={styles.label}>{t('Mode')}</Text>
        <SelectList<ThemePreference>
          collapsible={false}
          value={themeMode}
          onChange={setThemeMode}
          options={[
            { value: 'system', label: t('Follow system') },
            { value: 'dark', label: t('Dark (default)') },
            { value: 'light', label: t('Light (experimental)') },
          ]}
        />
        {/* Greyed under the light appearance rather than hidden: the setting
            stays where it is, and it is the appearance on screen that decides,
            so on `system` it comes and goes with the device. */}
        <View style={styles.afterList}>
          <SwitchList
            options={[
              {
                label: t('Pure black backgrounds'),
                description: t('For OLED screens. Only in the dark appearance.'),
                value: pureBlack,
                onChange: setPureBlack,
                disabled: mode === 'light',
              },
            ]}
          />
        </View>

        {/* One row, and it belongs to the appearance you are looking at: each
            keeps its own colour, so switching mode brings back the one chosen
            there rather than repainting it with the other's. Nothing has to say
            so on screen — the ticked swatch is already the answer. */}
        <Text style={[styles.label, styles.secondLabel]}>{t('Accent color')}</Text>
        {/* Only where there is a system accent to take (Android 12 and up): a
            switch that can do nothing is a question with no answer. */}
        {systemAccentAvailable ? (
          <View style={styles.customBox}>
            <SwitchList
              options={[
                {
                  label: t('Use the system colors'),
                  description: t('The accent Android takes from the wallpaper'),
                  value: systemAccent,
                  onChange: setSystemAccent,
                },
              ]}
            />
          </View>
        ) : null}
        <Swatches
          value={accent}
          disabled={usingSystem}
          onPick={(hex) => setAccentColor(hex, mode)}
        />
        {/* Keyed on the appearance: its draft starts from that appearance's own
            colour, and switching mode should show the other one's rather than
            carry a draft over. */}
        <View style={styles.customBox}>
          <CustomColor
            key={mode}
            value={accent}
            disabled={usingSystem}
            onApply={(hex) => setAccentColor(hex, mode)}
          />
        </View>
      </ScrollView>
    </SettingsPage>
  );
}

const styles = themed((colors) => ({
  label: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '700',
    marginBottom: spacing.md,
  },
  secondLabel: { marginTop: spacing.xl },
  afterList: { marginTop: spacing.md },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg },
  // The same fade `SwitchList` gives a row that has nothing to do.
  dimmed: { opacity: 0.5 },
  swatch: {
    width: 56,
    height: 56,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatchActive: { borderWidth: 3, borderColor: colors.text },
  customBox: { marginTop: spacing.xl },
  customRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  customInput: { flex: 1, fontVariant: ['tabular-nums'] },
  preview: {
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  applyButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.pill,
  },
  applyText: { fontSize: fontSize.sm, fontWeight: '700' },
}));
