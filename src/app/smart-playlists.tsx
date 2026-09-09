/** The smart playlists of this profile, and the way to write a new one. */
import Ionicons from '@expo/vector-icons/Ionicons';
import { Link, useRouter } from 'expo-router';
import { FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { EmptyState } from '@/components/EmptyState';
import { BackChevron } from '@/components/BackChevron';
import { useScreenBottomPadding } from '@/hooks/useScreenBottomPadding';
import { useT } from '@/i18n';
import type { SmartPlaylist } from '@/lib/smartPlaylists';
import { useSmartPlaylists } from '@/store/smartPlaylists';
import { colors, fontSize, radius, spacing, themed, useTheme } from '@/theme';

/** The tile a smart playlist wears instead of a cover: it has no picture of
 *  its own, since what it holds changes every time it is opened. */
export function SmartPlaylistArt({ size }: { size: number }) {
  return (
    <View style={[styles.art, { width: size, height: size, borderRadius: size >= 100 ? radius.lg : radius.sm }]}>
      <Ionicons name="sparkles" size={Math.round(size * 0.45)} color={colors.accent} />
    </View>
  );
}

/** "3 rules · by rating", what a row says under its name. */
export function rulesLabel(list: SmartPlaylist, t: (s: string, v?: Record<string, number>) => string): string {
  const n = list.rules.length;
  return n === 1 ? t('1 rule') : t('{n} rules', { n });
}

export default function SmartPlaylistsScreen() {
  // Repaints on a change of appearance or accent: a stack keeps this screen
  // mounted while you are on another one, out of reach of anything else.
  useTheme();
  const t = useT();
  const router = useRouter();
  const bottomPad = useScreenBottomPadding();
  const lists = useSmartPlaylists((s) => s.lists);

  const newOne = () => router.push('/smart-playlist/edit');

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.bar}>
        <BackChevron size={28} />
        <Text style={styles.barTitle}>{t('Smart playlists')}</Text>
        <Pressable hitSlop={10} accessibilityRole="button" accessibilityLabel={t('New smart playlist')} onPress={newOne}>
          <Ionicons name="add" size={28} color={colors.text} />
        </Pressable>
      </View>
      <FlatList
        data={lists}
        keyExtractor={(l) => l.id}
        contentContainerStyle={[styles.list, { paddingBottom: bottomPad }]}
        ListEmptyComponent={
          <EmptyState
            icon="sparkles-outline"
            title={t('No smart playlists yet')}
            subtitle={t('A smart playlist is a set of rules: the songs that fit them, whenever you open it.')}
            action={{ label: t('New smart playlist'), onPress: newOne }}
          />
        }
        renderItem={({ item }) => (
          <Link href={`/smart-playlist/${item.id}`} asChild>
            <Pressable style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}>
              <SmartPlaylistArt size={56} />
              <View style={styles.rowInfo}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={styles.rowSub}>{rulesLabel(item, t)}</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
            </Pressable>
          </Link>
        )}
      />
    </SafeAreaView>
  );
}

const styles = themed((colors) => ({
  safe: { flex: 1, backgroundColor: colors.background },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  barTitle: { color: colors.text, fontSize: fontSize.lg, fontWeight: '600' },
  list: { paddingHorizontal: spacing.lg, gap: spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  rowInfo: { flex: 1 },
  rowTitle: { color: colors.text, fontSize: fontSize.md, fontWeight: '600' },
  rowSub: { color: colors.textSecondary, fontSize: fontSize.xs, marginTop: 2 },
  art: {
    backgroundColor: colors.surfaceHighlight,
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
