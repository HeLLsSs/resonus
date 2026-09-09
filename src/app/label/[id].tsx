/**
 * A record label: its albums, as a grid or a list, a page at a time.
 *
 * Navidrome only, reached from the Labels list. The albums are the ones the
 * server files under the tag (see `listAlbumsFiltered`), newest first, which
 * is how a label's catalogue reads. How they are drawn is the genre's
 * preference: both are somebody else's list of records, and a second setting
 * for the same choice is one more thing to keep in step.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Dimensions, FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { canUseNative, listAlbumsFiltered } from '@/api/navidrome';
import { AlbumCard } from '@/components/AlbumCard';
import { AlbumCardsSkeleton } from '@/components/AlbumCardsSkeleton';
import { AlbumRow } from '@/components/AlbumRow';
import { AlbumRowsSkeleton } from '@/components/AlbumRowsSkeleton';
import { BackChevron } from '@/components/BackChevron';
import { EmptyState } from '@/components/EmptyState';
import { Message } from '@/components/Message';
import { useGridColumns } from '@/hooks/useGridColumns';
import { useScreenBottomPadding } from '@/hooks/useScreenBottomPadding';
import { useT } from '@/i18n';
import { listPerf } from '@/lib/listPerf';
import { useAuthStore } from '@/store/auth';
import { enabledFolderIds } from '@/store/libraries';
import { useSettings } from '@/store/settings';
import {
  colors,
  fontSize,
  spacing,
  SCREEN_BOTTOM_PADDING,
  themed,
  useTheme,
} from '@/theme';

const PAGE = 30;
const GAP = spacing.sm;

/** Card width at a given density (#109). */
function cardWidth(columns: number): number {
  return (Dimensions.get('window').width - spacing.lg * 2 - GAP * (columns - 1)) / columns;
}

export default function LabelScreen() {
  // Repaints on a change of appearance or accent: a stack keeps this screen
  // mounted while you are on another one, out of reach of anything else.
  useTheme();
  const bottomPad = useScreenBottomPadding();
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const t = useT();
  const auth = useAuthStore((s) => s.auth);
  const offline = useAuthStore((s) => s.offline);
  const layout = useSettings((s) => s.genreLayout);
  const setLayout = useSettings((s) => s.setGenreLayout);
  const grid = layout === 'grid';
  // Rows or cards, and how many across, in one menu (#109).
  const { columns, openGridMenu, gridSheet } = useGridColumns('genre', {
    value: layout,
    set: setLayout,
  });
  const card = cardWidth(columns);

  const albumsQuery = useInfiniteQuery({
    queryKey: ['labelAlbums', id],
    queryFn: ({ pageParam }) =>
      canUseNative(auth) && id
        ? listAlbumsFiltered(
            auth,
            { labelId: id },
            'max_year',
            PAGE,
            pageParam,
            enabledFolderIds(auth),
          )
        : Promise.resolve([]),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.length === PAGE ? pages.length * PAGE : undefined),
    enabled: !!id && !offline && canUseNative(auth),
  });
  const albums = albumsQuery.data?.pages.flat() ?? [];

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <BackChevron />
        <Text style={styles.title} numberOfLines={1}>
          {name ?? ''}
        </Text>
        <Pressable
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={t('View')}
          onPress={openGridMenu}
        >
          {/* Shows what you are looking at, not what one more tap would give
              you: it opens a menu, and a menu is opened from a thing that says
              where you are. */}
          <Ionicons name={grid ? 'grid-outline' : 'list'} size={22} color={colors.textSecondary} />
        </Pressable>
      </View>

      {/* What this is, under the name: a label's name alone can read as an
          artist's. */}
      <Text style={styles.meta}>{t('Record label')}</Text>

      {albumsQuery.isLoading ? (
        grid ? (
          <AlbumCardsSkeleton width={card} count={8} />
        ) : (
          <AlbumRowsSkeleton />
        )
      ) : albumsQuery.isError ? (
        <Message text={t("Couldn't load albums.")} onRetry={() => albumsQuery.refetch()} />
      ) : (
        <FlatList
          {...listPerf}
          data={albums}
          // Remount on layout change: FlatList reuses rows and gets stuck with
          // stale ones, and `numColumns` can't be hot-swapped either.
          key={`${layout}-${columns}`}
          keyExtractor={(item, i) => `${item.id}-${i}`}
          {...(grid
            ? {
                numColumns: columns,
                columnWrapperStyle: { gap: GAP },
                contentContainerStyle: [styles.list, { paddingBottom: bottomPad }],
              }
            : { contentContainerStyle: [styles.rowList, { paddingBottom: bottomPad }] })}
          renderItem={({ item }) =>
            grid ? <AlbumCard album={item} width={card} /> : <AlbumRow album={item} />
          }
          onEndReached={() => albumsQuery.hasNextPage && albumsQuery.fetchNextPage()}
          onEndReachedThreshold={0.5}
          ListFooterComponent={
            albumsQuery.isFetchingNextPage ? (
              <ActivityIndicator style={{ marginVertical: spacing.lg }} color={colors.accent} />
            ) : null
          }
          ListEmptyComponent={
            <EmptyState
              icon="disc-outline"
              title={t('No albums on this label')}
              subtitle={t('Try another label.')}
            />
          }
        />
      )}
      {gridSheet}
    </SafeAreaView>
  );
}

const styles = themed((colors) => ({
  safe: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  title: { flex: 1, color: colors.text, fontSize: fontSize.lg, fontWeight: '600' },
  // Under the title and to the same margin, like the meta line of a genre.
  meta: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
  },
  list: { paddingHorizontal: spacing.lg, paddingBottom: SCREEN_BOTTOM_PADDING, gap: GAP },
  rowList: {
    paddingHorizontal: spacing.lg,
    paddingBottom: SCREEN_BOTTOM_PADDING,
    gap: spacing.lg,
  },
}));
