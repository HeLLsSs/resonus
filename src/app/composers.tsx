/**
 * Every composer the library credits, A-Z, with a box to narrow them.
 *
 * A screen of its own and, `embedded`, the Composers section of the Explore
 * tab. Navidrome only: the list is a credit Subsonic has no word for, and the
 * tab draws the chip only where the server answered for it (see
 * `probeCatalogueExtras`). A row opens the artist screen, which lists what
 * they composed on beside whatever is theirs outright.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, Text, TextInput, View } from 'react-native';

import { canUseNative, listComposers, type Composer } from '@/api/navidrome';
import { ArtistListSkeleton } from '@/components/ArtistListSkeleton';
import { ArtistRow } from '@/components/ArtistRow';
import { BackChevron } from '@/components/BackChevron';
import { BrowseFrame, useSearchBox, type BrowserProps } from '@/components/BrowseFrame';
import { EmptyState } from '@/components/EmptyState';
import { Message } from '@/components/Message';
import { useScreenBottomPadding } from '@/hooks/useScreenBottomPadding';
import { useT } from '@/i18n';
import { listPerf } from '@/lib/listPerf';
import { useAuthStore } from '@/store/auth';
import {
  colors,
  fontSize,
  radius,
  spacing,
  SCREEN_BOTTOM_PADDING,
  themed,
  useTheme,
} from '@/theme';

export default function ComposersScreen() {
  return <ComposersBrowser />;
}

export function ComposersBrowser({ embedded, searchOpen }: BrowserProps) {
  // Repaints on a change of appearance or accent: a stack keeps this screen
  // mounted while you are on another one, out of reach of anything else.
  useTheme();
  const bottomPad = useScreenBottomPadding();
  const t = useT();
  const auth = useAuthStore((s) => s.auth);
  const offline = useAuthStore((s) => s.offline);
  const [query, setQuery] = useState('');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['composers', auth?.serverUrl, auth?.username],
    queryFn: () => (canUseNative(auth) ? listComposers(auth) : Promise.resolve([])),
    enabled: canUseNative(auth) && !offline,
  });

  // Embedded, whether the box is there is the tab's answer.
  const showSearch = useSearchBox(embedded, searchOpen, () => setQuery(''));

  const composers = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? (data ?? []).filter((c) => c.name.toLowerCase().includes(q)) : (data ?? []);
  }, [data, query]);

  return (
    <BrowseFrame embedded={embedded}>
      {embedded ? null : (
        <View style={styles.header}>
          <BackChevron />
          <Text style={styles.title}>{t('Composers')}</Text>
          <View style={{ width: 26 }} />
        </View>
      )}

      {showSearch ? (
        <View style={styles.searchBar}>
          <Ionicons name="search" size={18} color={colors.textMuted} />
          <TextInput
            style={styles.input}
            placeholder={t('Filter composers')}
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            value={query}
            onChangeText={setQuery}
            autoFocus={embedded}
          />
          {query.length > 0 ? (
            <Pressable hitSlop={10} onPress={() => setQuery('')}>
              <Ionicons name="close-circle" size={18} color={colors.textMuted} />
            </Pressable>
          ) : null}
        </View>
      ) : (
        // The gap the box was giving the list; without it the first row sits
        // against the chips above.
        <View style={styles.searchGap} />
      )}

      {isLoading ? (
        <ArtistListSkeleton />
      ) : isError ? (
        <Message text={t("Couldn't load composers.")} onRetry={() => refetch()} />
      ) : (
        <FlatList
          {...listPerf}
          // With the filter box open, a tap opens the row instead of only
          // closing the keyboard.
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          data={composers}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[styles.list, { paddingBottom: bottomPad }]}
          renderItem={({ item }: { item: Composer }) => <ArtistRow artist={item} />}
          ListEmptyComponent={
            query.trim() ? (
              <EmptyState
                icon="search-outline"
                title={t('No results')}
                subtitle={t('No results for “{q}”', { q: query.trim() })}
              />
            ) : (
              <EmptyState
                icon="musical-note-outline"
                title={t('No composers yet')}
                subtitle={t("Composers come from your music's tags.")}
              />
            )
          }
        />
      )}
    </BrowseFrame>
  );
}

const styles = themed((colors) => ({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  title: { color: colors.text, fontSize: fontSize.lg, fontWeight: '600' },
  // The box every section of Explore opens, to the same measurements.
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 44,
    backgroundColor: colors.surfaceHighlight,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
  },
  input: { flex: 1, color: colors.text, fontSize: fontSize.md, paddingVertical: 0 },
  searchGap: { height: spacing.sm },
  // The artist rows' own spacing, so the two lists read as one kind of thing.
  list: {
    paddingHorizontal: spacing.lg,
    paddingBottom: SCREEN_BOTTOM_PADDING,
    gap: spacing.lg,
  },
}));
