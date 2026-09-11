/**
 * The line that says a list is being shown narrowed, and the way out of it.
 *
 * A quick filter is meant to last a minute, and the thing that makes it safe is
 * that it cannot be forgotten: while one is on it is written across the top of
 * the list in the accent colour, with how much it is hiding and an X that puts
 * everything back. A list quietly missing half its songs, with nothing on
 * screen to say so, is the bug report this bar exists to prevent.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text } from 'react-native';

import { useT } from '@/i18n';
import { colors, fontSize, radius, spacing, themed } from '@/theme';

export function ListFilterBar({
  label,
  shown,
  total,
  onClear,
}: {
  /** What is being shown, as a translation key ("Downloaded only"). */
  label: string;
  shown: number;
  total: number;
  onClear: () => void;
}) {
  const t = useT();
  return (
    <Pressable
      style={styles.bar}
      accessibilityRole="button"
      accessibilityLabel={t('Show all')}
      onPress={onClear}
    >
      <Ionicons name="funnel" size={14} color={colors.accent} />
      <Text style={styles.label} numberOfLines={1}>
        {t(label)}
      </Text>
      <Text style={styles.count}>{t('{shown} of {total}', { shown, total })}</Text>
      <Ionicons name="close" size={16} color={colors.accent} style={{ marginLeft: 'auto' }} />
    </Pressable>
  );
}

const styles = themed((colors) => ({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceHighlight,
  },
  label: { color: colors.accent, fontSize: fontSize.sm, fontWeight: '700', flexShrink: 1 },
  count: { color: colors.textSecondary, fontSize: fontSize.sm },
}));
