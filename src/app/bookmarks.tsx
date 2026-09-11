/**
 * Bookmarks: the positions this account keeps in its songs on the server.
 *
 * A screen of its own and, `embedded`, the Bookmarks section of the Explore
 * tab. The long songs put theirs here on their own (see `lib/bookmarks`), and
 * the rest come from the song menu. A row plays the song from its position;
 * a long press, or the bin, takes the bookmark away.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';

import { COVER, songCoverUrl, type Bookmark } from '@/api/data';
import { BackChevron } from '@/components/BackChevron';
import { BrowseFrame, type BrowserProps } from '@/components/BrowseFrame';
import { Cover } from '@/components/Cover';
import { Dialog } from '@/components/Dialog';
import { EmptyState } from '@/components/EmptyState';
import { Message } from '@/components/Message';
import { useScreenBottomPadding } from '@/hooks/useScreenBottomPadding';
import { useListPadding } from '@/hooks/useScreenSize';
import { useSongSort } from '@/hooks/useSongSort';
import { useT } from '@/i18n';
import {
  loadBookmarks,
  removeBookmark,
  useBookmarks,
  useBookmarksAvailable,
} from '@/lib/bookmarks';
import { formatDuration } from '@/lib/format';
import { haptic } from '@/lib/haptics';
import { listPerf } from '@/lib/listPerf';
import { profileScopeId } from '@/store/auth';
import { usePlayerStore } from '@/store/player';
import { useSettings } from '@/store/settings';
import { useToast } from '@/store/toast';
import { colors, fontSize, spacing, themed, useTheme } from '@/theme';

export default function BookmarksScreen() {
  return <BookmarksBrowser />;
}

export function BookmarksBrowser({ embedded }: BrowserProps) {
  // Repaints on a change of appearance or accent: a stack keeps this screen
  // mounted while you are on another one, out of reach of anything else.
  useTheme();
  const bottomPad = useScreenBottomPadding();
  // Rows stop growing at a reading measure and centre themselves (#131).
  const listPad = useListPadding(spacing.lg);
  const t = useT();
  const lang = useSettings((s) => s.language);
  const showListArtwork = useSettings((s) => s.showListArtwork);
  const available = useBookmarksAvailable();
  const byId = useBookmarks((s) => s.byId);
  const loaded = useBookmarks((s) => s.loadedFor === profileScopeId());
  const playQueue = usePlayerStore((s) => s.playQueue);
  const seekTo = usePlayerStore((s) => s.seekTo);
  const toast = useToast((s) => s.show);
  const [failed, setFailed] = useState(false);
  const [deleting, setDeleting] = useState<Bookmark | null>(null);

  // Fresh each time the list is opened: another device may have moved one.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (available) loadBookmarks(true).catch(() => setFailed(true));
  }, [available, attempt]);

  // Latest first: the one moved a minute ago is the one you came back for.
  const bookmarks = useMemo(
    () => Object.values(byId).sort((a, b) => b.changed.localeCompare(a.changed)),
    [byId],
  );

  /**
   * The same menu the song lists have, over the songs the bookmarks are on. The
   * orders it offers are the ones a bookmark can answer: what the position in a
   * song is has nothing to do with the year it came out or how often it has
   * been played, and offering those here would be offering to sort by nothing.
   */
  const bookmarked = useMemo(() => bookmarks.map((bm) => bm.song), [bookmarks]);
  const { indices, openSort, sortSheet, sortLabel, filter, filterBar, filterEmpty } = useSongSort(
    bookmarked,
    'bookmarks',
    {
      fields: ['recent', 'alpha', 'artist', 'album', 'duration', 'downloaded'],
      labels: { recent: 'Recently bookmarked' },
      filters: ['downloaded', 'favorites'],
    },
  );
  // Back to bookmarks: the rows show a position and a comment, which only the
  // bookmark has, and `indices` is what says which one each song came from.
  const shown = useMemo(() => indices.map((i) => bookmarks[i]), [indices, bookmarks]);

  const play = (bm: Bookmark) => {
    void playQueue([bm.song], 0, t('Bookmarks'), '/bookmarks').then((ok) => {
      if (ok) seekTo(bm.position / 1000);
    });
  };

  const remove = async (bm: Bookmark) => {
    setDeleting(null);
    try {
      await removeBookmark(bm.song.id);
      toast(t('Bookmark removed'));
    } catch {
      toast(t("Couldn't remove the bookmark"));
    }
  };

  /** "at 12:34 of 58:00 · 8 Sept", and the comment on a line of its own. */
  const detail = (bm: Bookmark): string => {
    const when = new Date(bm.changed);
    const date = when.toLocaleDateString(lang, {
      day: 'numeric',
      month: 'short',
      ...(when.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' as const } : {}),
    });
    const at = t('at {position} of {duration}', {
      position: formatDuration(bm.position / 1000),
      duration: formatDuration(bm.song.duration),
    });
    return `${at} · ${date}`;
  };

  return (
    <BrowseFrame embedded={embedded}>
      {embedded ? null : (
        <View style={styles.header}>
          <BackChevron />
          <Text style={styles.title}>{t('Bookmarks')}</Text>
          <View style={{ width: 26 }} />
        </View>
      )}

      {!available ? (
        <View style={styles.center}>
          <EmptyState
            icon="bookmark-outline"
            title={t('Bookmarks live on the server')}
            subtitle={t('Come back online to see them.')}
          />
        </View>
      ) : failed ? (
        <Message
          text={t("Couldn't load bookmarks.")}
          onRetry={() => {
            setFailed(false);
            setAttempt((n) => n + 1);
          }}
        />
      ) : !loaded ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : (
        <>
          {/* The order written out beside the button rather than hidden behind
              it, the way a browse screen does it: this list has no header of its
              own to put it in, and inside the Explore tab it has no header at
              all. */}
          {bookmarks.length > 1 || filter ? (
            <View style={[styles.toolbar, { paddingHorizontal: listPad }]}>
              <Pressable
                style={styles.sort}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('Sort')}
                onPress={openSort}
              >
                <Ionicons name="swap-vertical" size={18} color={colors.textSecondary} />
                <Text style={styles.sortText} numberOfLines={1}>
                  {sortLabel}
                </Text>
              </Pressable>
            </View>
          ) : null}
          {filterBar ? <View style={{ paddingHorizontal: listPad }}>{filterBar}</View> : null}
          <FlatList
            {...listPerf}
            data={shown}
            keyExtractor={(bm) => bm.song.id}
            contentContainerStyle={[
              styles.list,
              { paddingBottom: bottomPad, paddingHorizontal: listPad },
            ]}
            ListEmptyComponent={
              filterEmpty ? (
                <>{filterEmpty}</>
              ) : (
                <EmptyState
                  icon="bookmark-outline"
                  title={t('No bookmarks yet')}
                  subtitle={t(
                    'Long songs keep their place on their own. Any song can be bookmarked from its menu while it plays.',
                  )}
                />
              )
            }
            renderItem={({ item }) => (
              <Pressable
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
                onPress={() => play(item)}
                onLongPress={() => {
                  haptic('medium');
                  setDeleting(item);
                }}
              >
                {showListArtwork ? (
                  <Cover uri={songCoverUrl(item.song, COVER.thumb)} size={48} />
                ) : null}
                <View style={styles.info}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {item.song.title}
                  </Text>
                  {item.song.artist ? (
                    <Text style={styles.rowSub} numberOfLines={1}>
                      {item.song.artist}
                    </Text>
                  ) : null}
                  <Text style={styles.rowSub} numberOfLines={1}>
                    {detail(item)}
                  </Text>
                  {item.comment ? (
                    <Text style={styles.comment} numberOfLines={2}>
                      {item.comment}
                    </Text>
                  ) : null}
                </View>
                <Pressable
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={t('Remove bookmark')}
                  onPress={() => setDeleting(item)}
                  style={({ pressed }) => pressed && { opacity: 0.6 }}
                >
                  <Ionicons name="trash-outline" size={20} color={colors.textSecondary} />
                </Pressable>
              </Pressable>
            )}
          />
        </>
      )}

      {sortSheet}

      <Dialog
        visible={deleting !== null}
        title={t('Remove bookmark')}
        message={deleting ? deleting.song.title : undefined}
        confirmLabel={t('Remove')}
        destructive
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) void remove(deleting);
        }}
      />
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
  center: { flex: 1, justifyContent: 'center' },
  // The same row the browse screens put above their lists, to the same margin.
  toolbar: { flexDirection: 'row', alignItems: 'center', paddingBottom: spacing.xs },
  sort: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, flexShrink: 1 },
  sortText: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '600' },
  list: { flexGrow: 1, paddingTop: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  info: { flex: 1 },
  rowTitle: { color: colors.text, fontSize: fontSize.md },
  rowSub: { color: colors.textSecondary, fontSize: fontSize.xs, marginTop: 2 },
  comment: { color: colors.text, fontSize: fontSize.sm, marginTop: 4, fontStyle: 'italic' },
}));
