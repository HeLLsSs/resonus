/**
 * The menu for arranging a list: what to order it by, which way round, and —
 * where the screen offers them — which of a couple of narrowings to put it
 * under for the moment.
 *
 * One component for the two hooks that ask the question, `useSongSort` (which
 * reorders a list the screen already holds) and `useServerSort` (which puts the
 * order into the request). Where the answer goes is their business; what it
 * looks like is one thing, and it stays one thing by there being one of it.
 *
 * In its own component, and memoized, because it holds its own visibility:
 * opening or closing it re-renders the modal rather than the screen and the
 * long list inside it, which was a visible delay on pressing "Sort".
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { type SortDirection } from '@/api/subsonic';
import { SheetModal } from '@/components/SheetModal';
import { useT } from '@/i18n';
import { colors, fontSize, radius, spacing, themed, useTheme } from '@/theme';

export type { SortDirection } from '@/api/subsonic';

/** Past this many orders the menu is taller than a small phone, and the sheet
 *  it sits in starts scrolling rather than running off the top. */
const SCROLLS_ABOVE = 6;

export const SortSheet = memo(function SortSheet({
  options,
  field,
  dir,
  onPick,
  filters,
  filter,
  onFilter,
  openRef,
}: {
  /** In the order they should be shown; the label is a translation key. */
  options: { key: string; label: string }[];
  field: string;
  /** Left out by the lists whose orders carry their own direction ("Recently
   *  added", "A-Z"): there is nothing to turn round, so the half of the menu
   *  that would ask goes with it. */
  dir?: SortDirection;
  onPick: (field: string, dir: SortDirection) => void;
  /**
   * The narrowings this list offers, if any. They live here rather than in a
   * row of their own above the list because a filter that is always on screen
   * is a permanent control for something meant to last a minute; what says one
   * is on is the bar over the list, which only exists while it is.
   */
  filters?: { key: string; label: string }[];
  /** Which one is on, if any. */
  filter?: string | null;
  /** Picking the one already on turns it off. */
  onFilter?: (filter: string | null) => void;
  openRef: React.MutableRefObject<() => void>;
}) {
  const t = useT();
  // Memoized, so the screen repainting is not enough to bring this one along.
  useTheme();
  return (
    <SheetModal openRef={openRef} scrolls={options.length > SCROLLS_ABOVE}>
      {/* Choosing closes it. Both halves are a finished answer on their own, and
          leaving it up afterwards asked for a second gesture to dismiss what had
          already been decided. Changing the field AND the direction takes two
          openings now, which is the rarer errand of the two. */}
      {(close) => (
        <>
          <Text style={styles.sheetTitle}>{t('Sort by')}</Text>
          {options.map((o) => {
            const active = field === o.key;
            return (
              <Pressable
                key={o.key}
                style={({ pressed }) => [styles.action, pressed && { opacity: 0.6 }]}
                onPress={() => {
                  onPick(o.key, dir ?? 'asc');
                  close();
                }}
              >
                <Text style={[styles.actionText, active && { color: colors.accent }]}>
                  {t(o.label)}
                </Text>
                {active ? (
                  <Ionicons
                    name="checkmark"
                    size={20}
                    color={colors.accent}
                    style={{ marginLeft: 'auto' }}
                  />
                ) : null}
              </Pressable>
            );
          })}

          {filters && filters.length > 0 && onFilter ? (
            <>
              <View style={styles.divider} />
              <Text style={styles.sheetTitle}>{t('Show only')}</Text>
              <View style={styles.dirRow}>
                {filters.map((f) => {
                  const active = filter === f.key;
                  return (
                    <Pressable
                      key={f.key}
                      style={[styles.dirChip, active && { backgroundColor: colors.accent }]}
                      onPress={() => {
                        onFilter(active ? null : f.key);
                        close();
                      }}
                    >
                      <Ionicons
                        name={active ? 'checkmark' : 'funnel-outline'}
                        size={16}
                        color={active ? colors.onAccent : colors.text}
                      />
                      <Text style={[styles.dirChipText, active && { color: colors.onAccent }]}>
                        {t(f.label)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </>
          ) : null}

          {dir === undefined ? null : (
            <>
          <View style={styles.divider} />
          <Text style={styles.sheetTitle}>{t('Direction')}</Text>
          <View style={styles.dirRow}>
            {(['asc', 'desc'] as SortDirection[]).map((d) => {
              const active = dir === d;
              return (
                <Pressable
                  key={d}
                  style={[styles.dirChip, active && { backgroundColor: colors.accent }]}
                  onPress={() => {
                    onPick(field, d);
                    close();
                  }}
                >
                  <Ionicons
                    name={d === 'asc' ? 'arrow-up' : 'arrow-down'}
                    size={16}
                    color={active ? colors.onAccent : colors.text}
                  />
                  <Text style={[styles.dirChipText, active && { color: colors.onAccent }]}>
                    {d === 'asc' ? t('Ascending') : t('Descending')}
                  </Text>
                </Pressable>
              );
            })}
          </View>
            </>
          )}
        </>
      )}
    </SheetModal>
  );
});

const styles = themed((colors) => ({
  sheetTitle: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    paddingVertical: spacing.md,
  },
  actionText: { color: colors.text, fontSize: fontSize.md },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: spacing.md,
  },
  dirRow: { flexDirection: 'row', gap: spacing.sm },
  dirChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceHighlight,
  },
  dirChipText: { color: colors.text, fontSize: fontSize.sm, fontWeight: '600' },
}));
