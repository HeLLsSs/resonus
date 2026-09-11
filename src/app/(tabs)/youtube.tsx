/**
 * YouTube: the account the Navifind proxy is signed in to, as a tab.
 *
 * The proxy that answers searches with tracks it can fetch from the web can
 * also be signed in to YouTube Music on the account holder's behalf. What that
 * gives is everything YouTube already knows about them — the shelves it would
 * put on their home page, their playlists, what they liked, what they keep —
 * and none of it was reachable from here: the only way in was to paste a link
 * into Settings and wait.
 *
 * **A tap plays, and the song lands in the library by itself.** Every track
 * here carries a `yt_` id, which is the id the player streams through the
 * proxy and the id the proxy files the song under once it has been listened to
 * for ten seconds. So there is no download button in this tab and no sync: it
 * is the ordinary online track the search results have always had, with a
 * better way of finding one.
 *
 * The shape borrows from both neighbours rather than inventing a third: the
 * chips at the top are Explore's, one section mounted at a time so the proxy is
 * only asked about what is being looked at, and inside "For you" the shelves
 * are Home's, tiles and song cards in rows that scroll sideways.
 *
 * Two refusals must not read alike. An account nobody ever configured (101) and
 * a session that has run out (100) both look exactly like an empty library, and
 * both are now somebody's to fix from here: each one opens the screen where a
 * cookie is pasted (Settings › Navifind › YouTube), which is a paste and a tap
 * rather than a trip to the proxy's own web page. Either way the anonymous home
 * takes over below it, so the tab is still worth opening with no account at all.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Redirect, useRouter } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from 'react-native';
// gesture-handler's list, so the swipe on a song row and the scroll do not
// fight each other (see `TrackRow`).
import { FlatList as GHFlatList } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  getSong,
  switchYoutubeAccount,
  youtubeAccounts,
  youtubeHome,
  youtubeLibrary,
  youtubeLiked,
  youtubeMyPlaylists,
  type YoutubeCard,
  type YoutubeShelf,
} from '@/api/subsonic';
import { AlbumCardsSkeleton } from '@/components/AlbumCardsSkeleton';
import { Cover } from '@/components/Cover';
import { EmptyState } from '@/components/EmptyState';
import { Message } from '@/components/Message';
import { OfflineIndicator } from '@/components/OfflineIndicator';
import { SongCard } from '@/components/SongCard';
import { TrackListSkeleton } from '@/components/TrackListSkeleton';
import { TrackRow } from '@/components/TrackRow';
import { useAccent } from '@/hooks/useAccent';
import { useScreenBottomPadding } from '@/hooks/useScreenBottomPadding';
import { columnsFor, useScreenSize } from '@/hooks/useScreenSize';
import { useT } from '@/i18n';
import { haptic } from '@/lib/haptics';
import { listPerf } from '@/lib/listPerf';
import { accountRefusal, cardTarget, openableShelves } from '@/lib/youtube';
import { useAuthStore } from '@/store/auth';
import { currentSong, usePlayerStore } from '@/store/player';
import { useSettings } from '@/store/settings';
import { useSongMenu } from '@/store/songMenu';
import { useToast } from '@/store/toast';
import { colors, fontSize, radius, spacing, themed, useTheme } from '@/theme';

/** How much of each list is worth asking for. Generous, because one request
 *  answers a whole section and nothing here is paged. */
const PLAYLISTS = 50;
const LIKED = 100;
const LIBRARY = 50;

/** How big a shelf card is, as on Home, and how wide a tile wants to be in the
 *  grids below (the same measurement the genre grid makes). */
const SHELF_CARD = 150;
const SHELF_CARD_WIDE = 190;
const TILE_IDEAL = 220;

/** Which of the four is on screen. Only "For you" exists without an account. */
type Section = 'foryou' | 'playlists' | 'liked' | 'library';

const LABEL: Record<Section, string> = {
  foryou: 'For you',
  playlists: 'Playlists',
  liked: 'Liked songs',
  library: 'Your library',
};

/** One tile: a playlist, a record, a video. Drawn like a card on Home, with
 *  the picture coming from YouTube's own hosts rather than from the server. */
function Tile({
  card,
  width,
  onPress,
}: {
  card: YoutubeCard;
  width: number;
  onPress: () => void;
}) {
  return (
    <Pressable style={[styles.tile, { width }]} onPress={onPress}>
      <Cover uri={card.thumbnail ?? undefined} size={width} />
      <Text style={styles.tileTitle} numberOfLines={1}>
        {card.title}
      </Text>
      {card.subtitle ? (
        <Text style={styles.tileSub} numberOfLines={1}>
          {card.subtitle}
        </Text>
      ) : null}
    </Pressable>
  );
}

export default function YoutubeScreen() {
  // Repaints on a change of appearance or accent: a tab stays mounted while
  // you are on another one, out of reach of anything else.
  useTheme();
  const t = useT();
  const accent = useAccent();
  const router = useRouter();
  const toast = useToast((s) => s.show);
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const bottomPad = useScreenBottomPadding();
  const { width, wide } = useScreenSize();
  const auth = useAuthStore((s) => s.auth);
  const offline = useAuthStore((s) => s.offline);
  const navifind = useSettings((s) => s.navifind);
  const showListArtwork = useSettings((s) => s.showListArtwork);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const playing = usePlayerStore(currentSong);
  const openSongMenu = useSongMenu((s) => s.open);
  const [section, setSection] = useState<Section>('foryou');
  const card = wide ? SHELF_CARD_WIDE : SHELF_CARD;
  const columns = columnsFor(width, TILE_IDEAL);
  const tile = (width - spacing.lg * 2 - spacing.md * (columns - 1)) / columns;
  const canAsk = navifind && !!auth && !offline;
  const [switching, setSwitching] = useState(false);
  // The same key the settings screen fills, so whichever of the two was opened
  // first pays for it and the other reads it from the cache.
  const accounts = useQuery({
    queryKey: ['youtube', 'accounts'],
    queryFn: () => youtubeAccounts(auth!),
    enabled: canAsk,
    staleTime: 5 * 60_000,
  });

  /**
   * The account, asked about once and then never again by the other three:
   * whether there is one to read is this one question, and its answer is what
   * says whether the rest of the tab exists.
   */
  const home = useQuery({
    queryKey: ['youtube', 'me', 'home'],
    queryFn: () => youtubeHome(auth!, true),
    enabled: canAsk,
    retry: false,
  });
  const refusal = accountRefusal(home.error);
  const anonymous = useQuery({
    queryKey: ['youtube', 'home'],
    queryFn: () => youtubeHome(auth!, false),
    enabled: canAsk && refusal !== null,
    retry: false,
  });
  const playlists = useQuery({
    queryKey: ['youtube', 'me', 'playlists'],
    queryFn: () => youtubeMyPlaylists(auth!, PLAYLISTS),
    enabled: canAsk && home.isSuccess && section === 'playlists',
  });
  const liked = useQuery({
    queryKey: ['youtube', 'me', 'liked'],
    queryFn: () => youtubeLiked(auth!, LIKED),
    enabled: canAsk && home.isSuccess && section === 'liked',
  });
  const library = useQuery({
    queryKey: ['youtube', 'me', 'library'],
    queryFn: () => youtubeLibrary(auth!, LIBRARY),
    enabled: canAsk && home.isSuccess && section === 'library',
  });

  // The switch turned off, or a profile that never had it: the tab is gone
  // from both bars, and this is the one left standing on it (or arriving by a
  // link). Home is where anybody can carry on from.
  if (!navifind || !auth) return <Redirect href="/" />;

  const shelves = openableShelves(home.data ?? anonymous.data ?? []);
  const songs = liked.data ?? [];
  // The chips go with the account, and so does whichever one was pressed: a
  // session that runs out while the liked songs are on screen leaves nothing
  // to show there.
  const current = home.isSuccess ? section : 'foryou';

  /**
   * Moves to the next account the session opens, and reloads the tab under it.
   *
   * A step rather than a menu: the whole point is one tap, and with two
   * accounts — which is what anybody who signs a second one in has — a step is
   * the shortest thing that works. It wraps, so a third is still reachable.
   */
  async function nextAccount() {
    const list = accounts.data ?? [];
    if (switching || list.length < 2) return;
    const at = list.findIndex((a) => a.active);
    const target = list[(at + 1) % list.length];
    setSwitching(true);
    try {
      await switchYoutubeAccount(auth!, target.index);
      // Everything on this tab belongs to whoever was being read.
      await queryClient.invalidateQueries({ queryKey: ['youtube'] });
    } catch {
      // Out of reach, or a session that has died since: the pill stays on the
      // account it was on, which is still the one being read.
    } finally {
      setSwitching(false);
    }
  }

  /** A tile pressed: a list opens, a single track plays. Nothing else can be
   *  pressed, because nothing else is drawn (see `lib/youtube.ts`). */
  async function open(item: YoutubeCard) {
    const target = cardTarget(item);
    if (!target) return;
    if (target.kind === 'playlist') {
      router.push(`/youtube/${encodeURIComponent(target.id)}`);
      return;
    }
    const song = await getSong(auth!, target.id).catch(() => null);
    if (!song) {
      toast(t("Couldn't play the song"));
      return;
    }
    void playQueue([song], 0, item.title);
  }

  function shelfOf(shelf: YoutubeShelf, index: number) {
    return (
      <View key={`${shelf.title}-${index}`} style={styles.section}>
        <Text style={styles.sectionTitle}>{shelf.title}</Text>
        {shelf.songs.length > 0 ? (
          <FlatList
            {...listPerf}
            horizontal
            data={shelf.songs}
            keyExtractor={(item) => item.id}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.rowContent}
            renderItem={({ item, index: i }) => (
              <SongCard
                song={item}
                width={card}
                accent={accent}
                isCurrent={item.id === playing?.id}
                // The shelf goes into the queue, not the song on its own: a row
                // of songs is a list to listen through, as on Home.
                onPress={() => void playQueue(shelf.songs, i, shelf.title)}
                // And holding one opens the menu every other song has, which is
                // where "add to my library" lives for a track the proxy found.
                onLongPress={() => {
                  haptic('light');
                  openSongMenu(item);
                }}
              />
            )}
          />
        ) : (
          <FlatList
            {...listPerf}
            horizontal
            data={shelf.items}
            keyExtractor={(item, i) => `${item.browseId ?? item.videoId ?? ''}-${i}`}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.rowContent}
            renderItem={({ item }) => (
              <Tile card={item} width={card} onPress={() => void open(item)} />
            )}
          />
        )}
      </View>
    );
  }

  function grid(cards: YoutubeCard[], loading: boolean) {
    if (loading) return <AlbumCardsSkeleton />;
    if (cards.length === 0) return <Message text={t('Nothing here yet')} />;
    return (
      <FlatList
        {...listPerf}
        // A change of width is a change of column count, and the list only
        // re-lays itself out for that if it is told it is a different list.
        key={columns}
        data={cards}
        numColumns={columns}
        keyExtractor={(item, i) => `${item.browseId ?? item.playlistId ?? ''}-${i}`}
        columnWrapperStyle={columns > 1 ? styles.gridRow : undefined}
        contentContainerStyle={[styles.grid, { paddingBottom: bottomPad }]}
        renderItem={({ item }) => (
          <Tile card={item} width={tile} onPress={() => void open(item)} />
        )}
      />
    );
  }

  return (
    <View style={[styles.safe, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.heading}>YouTube</Text>
        <View style={styles.headerRight}>
          {/* Only with somewhere to go: one account is a button that would do
              nothing, and the settings screen is where the list belongs. */}
          {(accounts.data?.length ?? 0) > 1 ? (
            <Pressable
              style={styles.account}
              accessibilityRole="button"
              accessibilityLabel={t('Switch account')}
              disabled={switching}
              onPress={() => void nextAccount()}
            >
              {switching ? (
                <ActivityIndicator size="small" color={colors.textSecondary} />
              ) : (
                <Ionicons name="swap-horizontal" size={16} color={colors.textSecondary} />
              )}
              <Text style={styles.accountName} numberOfLines={1}>
                {accounts.data?.find((a) => a.active)?.name ?? ''}
              </Text>
            </Pressable>
          ) : null}
          <OfflineIndicator />
        </View>
      </View>

      {/* Chips only once there is an account: the other three sections are
          somebody's own lists, and without one there are none to show. */}
      {home.isSuccess ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.segments}
          contentContainerStyle={styles.segmentsContent}
        >
          {(Object.keys(LABEL) as Section[]).map((key) => {
            const active = key === current;
            return (
              <Pressable
                key={key}
                style={[styles.segment, active && { backgroundColor: accent }]}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => setSection(key)}
              >
                <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                  {t(LABEL[key])}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      <View style={styles.body}>
        {offline ? (
          <Message text={t('Offline: nothing to ask.')} />
        ) : current === 'liked' ? (
          liked.isLoading ? (
            <TrackListSkeleton />
          ) : songs.length === 0 ? (
            <Message text={t('Nothing here yet')} />
          ) : (
            <GHFlatList
              {...listPerf}
              data={songs}
              keyExtractor={(song) => song.id}
              contentContainerStyle={{ paddingBottom: bottomPad }}
              renderItem={({ item, index: i }) => (
                <TrackRow
                  song={item}
                  isCurrent={playing?.id === item.id}
                  showArtwork={showListArtwork}
                  onPress={() => void playQueue(songs, i, t('Liked songs'))}
                />
              )}
            />
          )
        ) : current === 'playlists' ? (
          grid(playlists.data ?? [], playlists.isLoading)
        ) : current === 'library' ? (
          grid(library.data ?? [], library.isLoading)
        ) : (
          <ScrollView
            contentContainerStyle={{ paddingBottom: bottomPad }}
            refreshControl={
              <RefreshControl
                refreshing={home.isFetching || anonymous.isFetching}
                onRefresh={() => void queryClient.invalidateQueries({ queryKey: ['youtube'] })}
                tintColor={colors.accent}
              />
            }
          >
            {/* Said before anything else on the page, because it is the answer
                to "why is none of my music here". */}
            {refusal === 'none' ? (
              <EmptyState
                icon="logo-youtube"
                title={t('No YouTube account on the proxy')}
                subtitle={t(
                  'Navifind is not signed in to YouTube, so there is nothing of yours to show. What everyone else is listening to is below.',
                )}
                action={{
                  label: t('Sign in an account'),
                  // Nothing here needs the proxy's own web page any more: the
                  // account is a cookie, and the cookie is pasted from here.
                  onPress: () => router.push('/settings/youtube'),
                }}
              />
            ) : refusal === 'expired' ? (
              <EmptyState
                icon="time-outline"
                title={t('Your YouTube session has expired')}
                subtitle={t(
                  'Navifind can no longer read your account and needs a fresh sign-in. Everything of yours comes back once it has one.',
                )}
                action={{
                  label: t('Sign in again'),
                  // The screen that takes a cookie, rather than the proxy's own
                  // web page: the sign-in is a paste from this phone now, and
                  // that page was never anything to do here but a detour.
                  onPress: () => router.push('/settings/youtube'),
                }}
              />
            ) : home.isError ? (
              <Message
                text={t("The server did not answer as Navifind would. Check the address, or turn this off.")}
                onRetry={() => void home.refetch()}
              />
            ) : null}
            {home.isSuccess && shelves.length === 0 ? (
              <Message text={t('Nothing here yet')} />
            ) : null}
            {home.isLoading ? (
              <View style={styles.section}>
                <AlbumCardsSkeleton horizontal />
              </View>
            ) : (
              shelves.map(shelfOf)
            )}
          </ScrollView>
        )}
      </View>
    </View>
  );
}

const styles = themed((colors) => ({
  safe: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  // The heading Explore and "Your library" wear: this is a third tab of the
  // same kind, and a different size would read as a different kind of screen.
  heading: { color: colors.text, fontSize: fontSize.xxl, fontWeight: '600' },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 1 },
  account: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceHighlight,
    flexShrink: 1,
  },
  // Capped so a long account name cannot push the offline badge off the edge.
  accountName: { color: colors.textSecondary, fontSize: fontSize.xs, maxWidth: 120 },
  segments: { flexGrow: 0, paddingBottom: spacing.md },
  segmentsContent: { gap: spacing.sm, paddingHorizontal: spacing.lg },
  segment: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceHighlight,
  },
  segmentText: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '600' },
  segmentTextActive: { color: colors.onAccent },
  body: { flex: 1 },
  section: { marginBottom: spacing.xl },
  sectionTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '700',
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  rowContent: { paddingHorizontal: spacing.lg, gap: spacing.md },
  grid: { paddingHorizontal: spacing.lg, paddingTop: spacing.xs },
  gridRow: { gap: spacing.md, marginBottom: spacing.md },
  tile: { gap: spacing.xs },
  tileTitle: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '600',
    marginTop: spacing.xs,
  },
  tileSub: { color: colors.textSecondary, fontSize: fontSize.xs },
}));
