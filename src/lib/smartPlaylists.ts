/**
 * Smart playlists: a list that is a set of rules rather than a set of songs.
 *
 * Nothing here talks to a server. A smart playlist is run over the songs the
 * profile can see (`data.getAllSongs`) and comes out as a plain list, which
 * is then played, queued or, on request, written to the server as an ordinary
 * playlist. The rules read what the song already carries: the fields below
 * are the ones every backend fills in, or leaves empty in a way a rule can
 * reason about.
 */
import type { Song } from '@/api/subsonic';

/** What a rule looks at. */
export type RuleField =
  | 'rating'
  | 'playCount'
  | 'year'
  | 'duration'
  | 'added'
  | 'lastPlayed'
  | 'genre'
  | 'format'
  | 'artist'
  | 'album'
  | 'title'
  | 'starred';

/** How a rule compares. Which ones apply depends on the field's kind. */
export type RuleOp =
  | 'gte'
  | 'lte'
  | 'eq'
  | 'within'
  | 'notWithin'
  | 'is'
  | 'isNot'
  | 'contains'
  | 'notContains';

export interface Rule {
  field: RuleField;
  op: RuleOp;
  /** A number for the numeric kinds (days for the two about time), text for
   *  the text kinds, unused for `starred`. */
  value: string;
}

export type SortField =
  | 'title'
  | 'artist'
  | 'album'
  | 'year'
  | 'added'
  | 'playCount'
  | 'rating'
  | 'duration'
  | 'random';

export interface SmartPlaylist {
  id: string;
  name: string;
  /** Every rule, or any one of them. */
  match: 'all' | 'any';
  rules: Rule[];
  sort: SortField;
  dir: 'asc' | 'desc';
  /** At most this many songs, after sorting; nothing means all of them. */
  limit?: number;
  createdAt: number;
}

export type RuleKind = 'number' | 'days' | 'text' | 'flag';

/** How each field is compared, which decides its operators and its input. */
export const RULE_KIND: Record<RuleField, RuleKind> = {
  rating: 'number',
  playCount: 'number',
  year: 'number',
  duration: 'number',
  added: 'days',
  lastPlayed: 'days',
  genre: 'text',
  format: 'text',
  artist: 'text',
  album: 'text',
  title: 'text',
  starred: 'flag',
};

export const OPS_FOR_KIND: Record<RuleKind, RuleOp[]> = {
  number: ['gte', 'lte', 'eq'],
  days: ['within', 'notWithin'],
  text: ['is', 'isNot', 'contains', 'notContains'],
  flag: ['is', 'isNot'],
};

export const RULE_FIELDS: RuleField[] = [
  'rating',
  'starred',
  'genre',
  'year',
  'playCount',
  'lastPlayed',
  'added',
  'duration',
  'format',
  'artist',
  'album',
  'title',
];

export const SORT_FIELDS: SortField[] = [
  'title',
  'artist',
  'album',
  'year',
  'added',
  'playCount',
  'rating',
  'duration',
  'random',
];

/** The first operator of the field's kind: what a fresh rule starts on. */
export function defaultOp(field: RuleField): RuleOp {
  return OPS_FOR_KIND[RULE_KIND[field]][0];
}

const DAY_MS = 86_400_000;

/** A server's date string or the phone's own millisecond stamp, as a time. */
function whenMs(v: string | number | undefined): number | null {
  if (v == null) return null;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) && t > 0 ? t : null;
}

function fold(s: string | undefined): string {
  return (s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

/** Every genre the song carries, folded, since `genre` holds only the first. */
function genresOf(song: Song): string[] {
  const all = [song.genre, ...(song.genres ?? []).map((g) => g.name)];
  return all.map(fold).filter(Boolean);
}

function compareNumber(actual: number, op: RuleOp, wanted: number): boolean {
  if (op === 'gte') return actual >= wanted;
  if (op === 'lte') return actual <= wanted;
  return actual === wanted;
}

function compareText(actual: string, op: RuleOp, wanted: string): boolean {
  if (op === 'is') return actual === wanted;
  if (op === 'isNot') return actual !== wanted;
  if (op === 'contains') return wanted !== '' && actual.includes(wanted);
  return wanted === '' || !actual.includes(wanted);
}

/** Whether a song satisfies one rule. */
export function ruleMatches(song: Song, rule: Rule, now = Date.now()): boolean {
  switch (rule.field) {
    case 'rating':
      return compareNumber(song.userRating ?? 0, rule.op, Number(rule.value) || 0);
    case 'playCount':
      return compareNumber(song.playCount ?? 0, rule.op, Number(rule.value) || 0);
    case 'year': {
      // A song with no year is not "before 1990"; it is unknown, and unknown
      // matches nothing.
      if (!song.year) return false;
      return compareNumber(song.year, rule.op, Number(rule.value) || 0);
    }
    case 'duration':
      return compareNumber(song.duration ?? 0, rule.op, Number(rule.value) || 0);
    case 'added':
    case 'lastPlayed': {
      const at = whenMs(rule.field === 'added' ? (song.created ?? song.addedAt) : song.played);
      const days = Number(rule.value) || 0;
      const within = at != null && now - at <= days * DAY_MS;
      // "Not played in the last 90 days" includes never played: that is the
      // song the rule is looking for.
      return rule.op === 'within' ? within : !within;
    }
    case 'genre': {
      const wanted = fold(rule.value);
      const genres = genresOf(song);
      if (rule.op === 'is') return genres.includes(wanted);
      if (rule.op === 'isNot') return !genres.includes(wanted);
      const hit = genres.some((g) => g.includes(wanted));
      return rule.op === 'contains' ? wanted !== '' && hit : !hit;
    }
    case 'format':
      return compareText(fold(song.suffix), rule.op, fold(rule.value).replace(/^\./, ''));
    case 'artist':
      return compareText(fold(song.artist), rule.op, fold(rule.value));
    case 'album':
      return compareText(fold(song.album), rule.op, fold(rule.value));
    case 'title':
      return compareText(fold(song.title), rule.op, fold(rule.value));
    case 'starred':
      return rule.op === 'is' ? !!song.starred : !song.starred;
  }
}

/** Whether a song satisfies the playlist's rules under its all/any. An empty
 *  rule set matches everything: a list with no rules is the whole library. */
export function songMatches(song: Song, list: SmartPlaylist, now = Date.now()): boolean {
  if (list.rules.length === 0) return true;
  return list.match === 'all'
    ? list.rules.every((r) => ruleMatches(song, r, now))
    : list.rules.some((r) => ruleMatches(song, r, now));
}

function sortKey(song: Song, field: SortField): string | number {
  switch (field) {
    case 'title':
      return fold(song.title);
    case 'artist':
      return fold(song.artist);
    case 'album':
      return fold(song.album);
    case 'year':
      return song.year ?? 0;
    case 'added':
      return whenMs(song.created ?? song.addedAt) ?? 0;
    case 'playCount':
      return song.playCount ?? 0;
    case 'rating':
      return song.userRating ?? 0;
    case 'duration':
      return song.duration ?? 0;
    case 'random':
      return 0;
  }
}

/** Fisher-Yates on a copy. */
function shuffled<T>(items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * The songs the playlist stands for, out of the whole library: sifted,
 * ordered and cut to its limit. Random is dealt afresh on every call, which is
 * what makes a "50 random songs I have not played this year" list worth
 * opening twice.
 */
export function resolveSmartPlaylist(songs: Song[], list: SmartPlaylist): Song[] {
  const now = Date.now();
  const kept = songs.filter((s) => songMatches(s, list, now));
  let ordered: Song[];
  if (list.sort === 'random') {
    ordered = shuffled(kept);
  } else {
    const sign = list.dir === 'desc' ? -1 : 1;
    ordered = kept
      .map((song, i) => ({ song, i, key: sortKey(song, list.sort) }))
      .sort((a, b) => {
        const ak = a.key;
        const bk = b.key;
        const cmp =
          typeof ak === 'number' && typeof bk === 'number'
            ? ak - bk
            : String(ak).localeCompare(String(bk));
        return cmp !== 0 ? sign * cmp : a.i - b.i;
      })
      .map((x) => x.song);
  }
  return list.limit && list.limit > 0 ? ordered.slice(0, list.limit) : ordered;
}

/** The way round a sort reads before anybody flips it: newest and most first,
 *  the alphabetical ones forwards. */
export function naturalDir(field: SortField): 'asc' | 'desc' {
  return field === 'added' || field === 'playCount' || field === 'rating' || field === 'year'
    ? 'desc'
    : 'asc';
}
