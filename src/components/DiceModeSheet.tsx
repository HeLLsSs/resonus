/**
 * The die's modes, behind a long press on any die (Home's Shuffle chip, the
 * YouTube tab's die, the ride screen's): the four ways it can deal, the
 * default marked. Picking one plays it this once; with "Always use this" on,
 * it also becomes what a plain tap, the widget and the car play.
 *
 * Mounted once in the root layout and opened from anywhere through
 * `useDiceModeSheet`, like the song menu. From the ride screen it opens big:
 * rows a gloved thumb can hit.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useRef, useState } from 'react';
import { Pressable, Switch, Text, View } from 'react-native';
import { create } from 'zustand';

import { SheetModal } from '@/components/SheetModal';
import { useAccent } from '@/hooks/useAccent';
import { useT } from '@/i18n';
import { DICE_MODES, type DiceMode } from '@/lib/diceModes';
import { haptic } from '@/lib/haptics';
import { diceModeHint, diceModeName, playShuffle } from '@/lib/playShuffle';
import { useSettings } from '@/store/settings';
import { colors, fontSize, radius, spacing, themed } from '@/theme';

interface DiceModeSheetState {
  /** Bumped by every `open`, which is what the sheet listens to. */
  requests: number;
  big: boolean;
  open: (opts?: { big?: boolean }) => void;
}

export const useDiceModeSheet = create<DiceModeSheetState>((set) => ({
  requests: 0,
  big: false,
  open: (opts) => set((s) => ({ requests: s.requests + 1, big: !!opts?.big })),
}));

const ICONS: Record<DiceMode, keyof typeof Ionicons.glyphMap> = {
  mix: 'shuffle',
  library: 'library',
  youtube: 'logo-youtube',
  discover: 'sparkles',
};

export function DiceModeSheet() {
  const t = useT();
  const accent = useAccent();
  const big = useDiceModeSheet((s) => s.big);
  const diceMode = useSettings((s) => s.diceMode);
  const setDiceMode = useSettings((s) => s.setDiceMode);
  const [always, setAlways] = useState(false);
  const openRef = useRef<() => void>(() => {});

  useEffect(
    () =>
      useDiceModeSheet.subscribe((state, prev) => {
        if (state.requests === prev.requests) return;
        setAlways(false);
        openRef.current();
      }),
    [],
  );

  const iconSize = big ? 36 : 24;
  return (
    <SheetModal openRef={openRef}>
      {(close) => (
        <>
          <Text style={[styles.title, big && styles.titleBig]}>{t('Die')}</Text>
          {DICE_MODES.map((mode) => (
            <Pressable
              key={mode}
              style={({ pressed }) => [styles.row, big && styles.rowBig, pressed && { opacity: 0.6 }]}
              accessibilityRole="button"
              accessibilityState={{ selected: mode === diceMode }}
              onPress={() => {
                close();
                if (always) setDiceMode(mode);
                haptic('medium');
                void playShuffle(undefined, mode);
              }}
            >
              <Ionicons name={ICONS[mode]} size={iconSize} color={colors.text} />
              <View style={styles.texts}>
                <Text style={[styles.name, big && styles.nameBig]}>{diceModeName(mode)}</Text>
                {big ? null : <Text style={styles.hint}>{diceModeHint(mode)}</Text>}
              </View>
              {mode === diceMode ? (
                <Text style={[styles.badge, { color: accent }, big && styles.hintBig]}>{t('Default')}</Text>
              ) : null}
            </Pressable>
          ))}
          <Pressable
            style={({ pressed }) => [styles.row, big && styles.rowBig, pressed && { opacity: 0.6 }]}
            accessibilityRole="switch"
            accessibilityState={{ checked: always }}
            onPress={() => setAlways(!always)}
          >
            <Text style={[styles.name, styles.texts, big && styles.nameBig]}>{t('Always use this')}</Text>
            <Switch
              value={always}
              onValueChange={setAlways}
              trackColor={{ false: colors.control, true: accent }}
              thumbColor={colors.knob}
            />
          </Pressable>
        </>
      )}
    </SheetModal>
  );
}

const styles = themed((colors) => ({
  title: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  titleBig: { fontSize: fontSize.lg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  },
  rowBig: { paddingVertical: spacing.lg, minHeight: 72 },
  texts: { flex: 1 },
  name: { color: colors.text, fontSize: fontSize.md, fontWeight: '600' },
  nameBig: { fontSize: fontSize.xl },
  hint: { color: colors.textSecondary, fontSize: fontSize.sm, marginTop: 2 },
  hintBig: { fontSize: fontSize.md },
  badge: { fontSize: fontSize.sm, fontWeight: '700' },
}));
