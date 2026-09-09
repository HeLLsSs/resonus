/**
 * "Made for you" on Home: a shelf of mixes built on the phone (see
 * `lib/mixes`). Tapping a card builds its queue and plays it; nothing is
 * fetched for a card until then, beyond the covers that are on it.
 *
 * Server only, like Discover: the mixes are drawn from what the server can
 * pick at random or by likeness, and offline there is neither.
 */
import {
  useQueries,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';

import {
  coverArtUrl,
  getAlbumList,
  getAlbumsByGenre,
  getGenres,
  type Album,
  COVER,
} from '@/api/data';
import { AlbumCardsSkeleton } from '@/components/AlbumCardsSkeleton';
import { Cover } from '@/components/Cover';
import { useScreenSize } from '@/hooks/useScreenSize';
import { tg, useT } from '@/i18n';
import { greetingHours } from '@/i18n/languages';
import { listPerf } from '@/lib/listPerf';
import {
  allMixes,
  topGenres,
  type Mix,
} from '@/lib/mixes';
import { useAuthStore } from '@/store/auth';
import { useLastPlayed } from '@/store/lastPlayed';
import { usePlayHistory } from '@/store/playHistory';
import { usePlayerStore } from '@/store/player';
import { useSettings } from '@/store/settings';
import { useToast } from '@/store/toast';
import { colors, fontSize, radius, spacing, themed, useTheme } from '@/theme';

/** The same card as the album shelves, so the rows line up (see Home). */
const CARD = 150;
const CARD_WIDE = 190;

/**
 * How many albums are sampled to find out which decades the library has.
 * One request, kept for the session's five minutes like every list; the
 * shelves' own albums are read off the cache on top of it.
 */
const YEAR_SAMPLE = 100;
/** How many covers a genre card gets, which is what its request asks for. */
const GENRE_COVERS = 4;

/**
 * Four covers in a square, or the first one on its own.
 *
 * The corners are taken off the tiles and given to the square: four rounded
 * tiles read as four pictures, and the card is one thing.
 */
function MixArt({ covers, size }: { covers: string[]; size: number }) {
  const uris = covers.map((id) => coverArtUrl(id, COVER.thumb));
  if (uris.length < 4) return <Cover uri={uris[0]} size={size} />;
  const half = size / 2;
  return (
    <View style={[styles.mosaic, { width: size, height: size }]}>
      {uris.slice(0, 4).map((uri, i) => (
        <Cover key={i} uri={uri} size={half} style={styles.tile} />
      ))}
    </View>
  );
}

function MixCard({ mix, width }: { mix: Mix; width: number }) {
  const t = useT();
  const { accent } = useTheme();
  const title = t(mix.title.key, mix.title.vars);
  // The title takes the accent while this mix is what is playing, the way a
  // song's does in a row: the queue was started from here under this name.
  const playing = usePlayerStore((s) => s.queue.length > 0 && s.source === title);
  const [busy, setBusy] = useState(false);

  async function play() {
    if (busy) return;
    setBusy(true);
    try {
      const songs = await mix.load();
      if (songs.length === 0) {
        useToast.getState().show(tg('Nothing to play in this mix yet'));
        return;
      }
      await usePlayerStore.getState().playQueue(songs, 0, title);
    } catch {
      useToast.getState().show(tg("Couldn't load songs."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Pressable
      style={[styles.card, { width }]}
      onPress={() => void play()}
      accessibilityRole="button"
      accessibilityLabel={title}
    >
      <View>
        <MixArt covers={mix.covers} size={width} />
        {/* The spinner is the only sign the tap did something while the
            server picks the songs, same as the shuffle chip. */}
        {busy ? (
          <View style={[styles.veil, { width, height: width }]}>
            <ActivityIndicator color={colors.onArtwork} />
          </View>
        ) : null}
      </View>
      <Text style={[styles.title, playing && { color: accent }]} numberOfLines={1}>
        {title}
      </Text>
      <Text style={styles.subtitle} numberOfLines={1}>
        {t(mix.subtitle.key, mix.subtitle.vars)}
      </Text>
    </Pressable>
  );
}

export function MixesShelf({ title }: { title: string }) {
  useTheme();
  const online = useAuthStore((s) => !!s.auth && !s.offline);
  const { wide } = useScreenSize();
  const card = wide ? CARD_WIDE : CARD;
  const entries = usePlayHistory((s) => s.entries);
  const times = useLastPlayed((s) => s.times);
  const language = useSettings((s) => s.language);
  const queryClient = useQueryClient();

  const { data: sample, isLoading: sampling } = useQuery({
    queryKey: ['mixes', 'albumSample'],
    queryFn: () => getAlbumList('random', YEAR_SAMPLE),
    enabled: online,
  });
  const { data: genres, isLoading: loadingGenres } = useQuery({
    queryKey: ['genres'],
    queryFn: () => getGenres(),
    enabled: online,
  });
  const picked = useMemo(() => topGenres(genres ?? []), [genres]);
  // Genre by genre, as one object the memo below can depend on: `useQueries`
  // shares the combined result structurally, so it only changes when a cover
  // list does. Not the genre cards' own art query: that one asks for two
  // covers and this one for four, and one key cannot hold both answers.
  const combineArt = useCallback(
    (results: UseQueryResult<Album[]>[]): Record<string, Album[] | undefined> =>
      Object.fromEntries(results.map((r, i) => [picked[i]?.value ?? '', r.data])),
    [picked],
  );
  const artByGenre = useQueries({
    queries: picked.map((g) => ({
      queryKey: ['mixes', 'genreArt', g.value],
      queryFn: () => getAlbumsByGenre(g.value, GENRE_COVERS),
      enabled: online,
      staleTime: Infinity,
      retry: false,
    })),
    combine: combineArt,
  });

  // Built again only when one of its inputs changes, and the clock read then:
  // a Home left open across a slot change keeps the old mix until something
  // else repaints it, like the greeting above. State keyed on the inputs and
  // adjusted during render rather than a memo, since the clock and the query
  // cache are read on the way and a memo is expected to be a pure function of
  // what it lists.
  const inputs = [entries, times, language, sample, picked, artByGenre] as const;
  const build = () => {
    const hours = greetingHours(language);
    const now = Date.now();
    // Every album already on screen says which decades the library has: the
    // shelves' lists are in the cache under this key, whatever their type.
    const cached = queryClient
      .getQueriesData<Album[]>({ queryKey: ['albumList'] })
      .flatMap(([, albums]) => albums ?? []);
    return allMixes({
      entries,
      times,
      hours,
      now,
      albums: [...cached, ...(sample ?? [])],
      genres: picked,
      artOf: (genre) => artByGenre[genre],
    });
  };
  const [built, setBuilt] = useState(() => ({ inputs, mixes: build() }));
  if (built.inputs.some((input, i) => !Object.is(input, inputs[i]))) setBuilt({ inputs, mixes: build() });
  const mixes = built.mixes;

  if (!online) return null;
  if (mixes.length === 0) {
    if (!sampling && !loadingGenres) return null;
    return (
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <AlbumCardsSkeleton horizontal width={card} />
      </View>
    );
  }

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <FlatList
        {...listPerf}
        horizontal
        data={mixes}
        keyExtractor={(item: Mix) => item.key}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.rowContent}
        renderItem={({ item }) => <MixCard mix={item} width={card} />}
      />
    </View>
  );
}

const styles = themed((colors) => ({
  section: { marginBottom: spacing.xl },
  sectionTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '700',
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  rowContent: { paddingHorizontal: spacing.lg, gap: spacing.md },
  card: { gap: spacing.xs },
  mosaic: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: colors.surfaceHighlight,
  },
  tile: { borderRadius: 0 },
  veil: {
    position: 'absolute',
    top: 0,
    left: 0,
    borderRadius: radius.md,
    backgroundColor: colors.scrim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '600',
    marginTop: spacing.xs,
  },
  subtitle: { color: colors.textSecondary, fontSize: fontSize.xs },
}));
