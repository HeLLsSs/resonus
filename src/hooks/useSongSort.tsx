/**
 * Reusable arrangement of a song list the screen already holds: what it is
 * ordered by, which way round, and — where the screen asks for them — a quick
 * filter that narrows it for as long as you are looking at it.
 *
 * Returns the already-arranged list, the mapping to original indices (for
 * actions like "remove from list"), a trigger to open the menu, and the menu
 * itself as a node to render. With `persistKey` the chosen sort is saved to
 * disk and remembered across visits; the filter never is (see below).
 *
 * What each order does to the list lives in `lib/songSort`, which is plain
 * functions and is where the tests are.
 */
import { type ReactNode, useMemo, useRef, useState } from 'react';

import { type Song } from '@/api/subsonic';
import { EmptyState } from '@/components/EmptyState';
import { ListFilterBar } from '@/components/ListFilterBar';
import { SortSheet } from '@/components/SortSheet';
import { useFavoriteIds } from '@/hooks/useFavoriteIds';
import { useT } from '@/i18n';
import {
  arrangeSongs,
  naturalSongDir,
  type SongFilter,
  type SongSortField,
} from '@/lib/songSort';
import { useDownloads } from '@/store/downloads';
import { useSortPrefs, type SortDir } from '@/store/sortPrefs';

/**
 * `recent` is the order the list arrived in, which is what "Default" says
 * everywhere else in the app. It is not "Recent": that word is taken, and it
 * means what you played or opened last. Screens where the order it arrived in
 * has a name of its own give it one (see `labels`).
 *
 * `added` and `date` are two different questions and both are worth asking.
 * `added` is a position in this list, which a playlist the server appends to
 * encodes and nothing else does; `date` is when the file itself arrived, which
 * every song carries and which is what "Date added" means in the smart playlist
 * rules. Only the playlist offers the first one.
 */
const SORT_LABEL: Record<SongSortField, string> = {
  recent: 'Default',
  added: 'Recently added',
  date: 'Date added',
  alpha: 'Alphabetical',
  artist: 'Artist',
  album: 'Album',
  year: 'Year',
  duration: 'Duration',
  plays: 'Most played',
  rating: 'Rating',
  downloaded: 'Downloaded',
};

/** The chips in the menu, and what the bar over a narrowed list says. */
const FILTER_LABEL: Record<SongFilter, string> = {
  downloaded: 'Downloaded',
  favorites: 'Favorites',
};
const FILTER_BAR_LABEL: Record<SongFilter, string> = {
  downloaded: 'Downloaded only',
  favorites: 'Favorites only',
};
const FILTER_EMPTY: Record<SongFilter, { icon: 'arrow-down-circle-outline' | 'heart-outline'; title: string }> = {
  downloaded: { icon: 'arrow-down-circle-outline', title: 'Nothing here is downloaded' },
  favorites: { icon: 'heart-outline', title: 'Nothing here is a favorite' },
};

/** What a list of songs offers unless it says otherwise: 'recent' = the order
 *  it came in, then the orders every song can answer for. */
const DEFAULT_FIELDS: SongSortField[] = [
  'recent',
  'date',
  'alpha',
  'artist',
  'album',
  'year',
  'duration',
  'plays',
  'rating',
  'downloaded',
];

/** A sort this hook can hand to `arrangeSongs`: the stored one is wider,
 *  because one store keeps the choice made on album lists too. */
interface SongSortPref {
  field: SongSortField;
  dir: SortDir;
}

const DEFAULT_SORT: SongSortPref = { field: 'recent', dir: 'asc' };

interface SortOptions {
  /** Which fields to offer and in which order (the first is equivalent to "unsorted"). */
  fields?: SongSortField[];
  /** Custom labels per field (e.g. 'recent' → "Album order" on an album). */
  labels?: Partial<Record<SongSortField, string>>;
  /** Default sort if the user hasn't chosen one. */
  defaultSort?: SongSortPref;
  /** Which quick filters to offer, if any. None by default. */
  filters?: SongFilter[];
}

interface SortResult {
  /** Songs in the visible order, and only the visible ones. */
  songs: Song[];
  /** Original index (on the server) of each visible song. */
  indices: number[];
  /** Opens the sort menu. */
  openSort: () => void;
  /** The sort menu, to render in the tree. */
  sortSheet: ReactNode;
  /** Current sort preference (field + direction). */
  sort: SongSortPref;
  /** What the current order is called, translated, for a screen that writes it
   *  next to the button instead of hiding it behind one (see `BrowseToolbar`). */
  sortLabel: string;
  /** Changes the sort preference (e.g. force manual order). */
  setSort: (pref: SongSortPref) => void;
  /** The quick filter in force, or null. Screens read it to tell an empty
   *  list from a list emptied by the filter. */
  filter: SongFilter | null;
  /** The bar that says one is on, to render above the rows. Null when none is. */
  filterBar: ReactNode;
  /** What to show in place of the rows when the filter hid every one of them,
   *  which is not the same story as an empty list. Null otherwise. */
  filterEmpty: ReactNode;
}

/** Stable stand-in for the downloads map when nothing on screen looks at it: a
 *  fresh `{}` each time would defeat the whole point. */
const NO_FILES: Record<string, string> = {};

export function useSongSort(
  source: Song[],
  persistKey?: string,
  options?: SortOptions,
): SortResult {
  const t = useT();
  const fields = options?.fields ?? DEFAULT_FIELDS;
  const offered = options?.filters ?? [];
  const fallback = options?.defaultSort ?? DEFAULT_SORT;
  const stored = useSortPrefs((s) => (persistKey ? s.prefs[persistKey] : undefined));
  const setPref = useSortPrefs((s) => s.setPref);
  const [local, setLocal] = useState<SongSortPref>(fallback);
  /**
   * The filter is deliberately not remembered, where the sort deliberately is.
   * An order is how you like to read a list; a filter is a question you asked
   * once, and coming back tomorrow to a list still hiding half of itself
   * because of it is the surprise this whole thing has to avoid. Leaving the
   * screen forgets it, which is the same promise the search box makes.
   */
  const [filter, setFilter] = useState<SongFilter | null>(null);
  const openRef = useRef<() => void>(() => {});

  const saved = persistKey ? (stored ?? fallback) : local;
  // A choice saved while the screen offered another set of orders — an older
  // version of it, or another screen sharing the key — would otherwise leave
  // the list sorted by something this menu can neither show nor undo.
  const kept = fields.includes(saved.field as SongSortField);
  const field = (kept ? saved.field : fallback.field) as SongSortField;
  const dir = kept ? saved.dir : fallback.dir;
  // For the 'downloaded' sort (group downloaded songs together) and its filter,
  // and ONLY for those. The map is replaced with every song that finishes
  // downloading, and it feeds the memo below, so subscribing to it always meant
  // re-mapping and re-sorting the whole list on each one, on every screen that
  // sorts, plus new array identities for the FlatList to chew on. On a long
  // list with auto-download on that is thousands of full sorts (#50). Sorting
  // BY downloads does have to follow them, and there the re-sort is the point.
  const watchFiles = field === 'downloaded' || filter === 'downloaded';
  const files = useDownloads((s) => (watchFiles ? s.files : NO_FILES));
  // Only fetched while the favorites filter is on; the query is the shared one
  // every heart in the app already reads.
  const favoriteIds = useFavoriteIds(filter === 'favorites');

  function update(next: SongSortPref) {
    if (persistKey) setPref(persistKey, next, fallback);
    else setLocal(next);
  }

  // Memoized: arranging on every render is noticeable in large lists.
  const ordered = useMemo(
    () => arrangeSongs(source, { field, dir }, filter, { files, favoriteIds }),
    [source, field, dir, filter, files, favoriteIds],
  );

  const sortSheet = (
    <SortSheet
      options={fields.map((f) => ({ key: f, label: options?.labels?.[f] ?? SORT_LABEL[f] }))}
      field={field}
      dir={dir}
      onPick={(next, d) => {
        const picked = next as SongSortField;
        // A different order arrives the way it is meant to be read; the
        // direction carries over only when the direction is what was picked.
        update(picked === field ? { field, dir: d } : { field: picked, dir: naturalSongDir(picked) });
      }}
      filters={offered.map((f) => ({ key: f, label: FILTER_LABEL[f] }))}
      filter={filter}
      onFilter={(next) => setFilter(next as SongFilter | null)}
      openRef={openRef}
    />
  );

  // Stable identity so the FlatList that receives them doesn't re-evaluate rows.
  const songs = useMemo(() => ordered.map((o) => o.song), [ordered]);
  const indices = useMemo(() => ordered.map((o) => o.index), [ordered]);

  const empty = filter ? FILTER_EMPTY[filter] : null;
  return {
    songs,
    indices,
    openSort: () => openRef.current(),
    sortSheet,
    sort: { field, dir },
    sortLabel: t(options?.labels?.[field] ?? SORT_LABEL[field]),
    setSort: update,
    filter,
    filterBar: filter ? (
      <ListFilterBar
        label={FILTER_BAR_LABEL[filter]}
        shown={songs.length}
        total={source.length}
        onClear={() => setFilter(null)}
      />
    ) : null,
    filterEmpty:
      empty && songs.length === 0 && source.length > 0 ? (
        <EmptyState
          icon={empty.icon}
          title={t(empty.title)}
          action={{ label: t('Show all'), onPress: () => setFilter(null) }}
        />
      ) : null,
  };
}
