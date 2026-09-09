/**
 * "Playing elsewhere", at the top of Home: what another player on this
 * account is listening to right now, and a button to pick it up here.
 *
 * Two things the server keeps make it possible. `getNowPlaying` says which
 * song each player announced and how long ago; `getPlayQueue` holds the queue
 * whichever player saved it last, with the song it was on and how far into it.
 * Put together: the other player's queue, started here from the same song and
 * wound to where that player last said it was, which is as exact as its last
 * save (most players save every few seconds while playing).
 *
 * What it cannot do is stop the other player. Subsonic has no way to tell a
 * player anything, so both keep going unless somebody pauses the other one by
 * hand. The card says "play here" rather than "move here" for that reason.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import { useIsFocused } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, Text, View } from 'react-native';

import { getPlayQueue } from '@/api/backend';
import { COVER, getNowPlaying, songCoverUrl, type NowPlayingEntry } from '@/api/data';
import { Cover } from '@/components/Cover';
import { useT } from '@/i18n';
import { useAuthStore } from '@/store/auth';
import { usePlayerStore } from '@/store/player';
import { colors, fontSize, radius, spacing, themed, useTheme } from '@/theme';

/**
 * How often the server is asked while Home is on screen. The entries it hands
 * back are minutes old by its own account, so asking more often than this
 * would not learn anything new; less often and a song that started on the
 * computer is over before the card shows it.
 */
const POLL_MS = 30_000;

/**
 * Starts the other player's song here, inside its queue when the server still
 * has that queue, on its own otherwise.
 *
 * The saved position is only trusted when the saved queue was on this very
 * song: a queue saved three songs ago carries the clock of a song that is no
 * longer playing, and winding into the wrong one is worse than starting over.
 */
async function playHere(entry: NowPlayingEntry, source: string): Promise<void> {
  const { auth } = useAuthStore.getState();
  if (!auth) return;
  const player = usePlayerStore.getState();
  let saved = null;
  try {
    saved = await getPlayQueue(auth);
  } catch {
    // Without the queue there is still the song.
  }
  const at = saved ? saved.entries.findIndex((s) => s.id === entry.song.id) : -1;
  if (!saved || at < 0) {
    await player.playQueue([entry.song], 0, source);
    return;
  }
  const ok = await player.playQueue(saved.entries, at, source);
  if (ok && saved.current === entry.song.id && saved.position > 0) {
    player.seekTo(saved.position / 1000);
  }
}

export function PlayingElsewhereCard() {
  useTheme();
  const t = useT();
  const online = useAuthStore((s) => !!s.auth && !s.offline);
  const currentId = usePlayerStore((s) => s.queue[s.index]?.id);
  const [busy, setBusy] = useState(false);

  const focused = useIsFocused();
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setAppActive(state === 'active'));
    return () => sub.remove();
  }, []);
  // Only while Home is the screen in front, and the app is in front of the
  // phone: a tab left behind or an app in the background has nothing to show
  // the answer on, and asking offline would be a request for its own sake.
  const polling = online && focused && appActive;

  const { data, refetch } = useQuery({
    queryKey: ['nowPlaying'],
    queryFn: () => getNowPlaying(),
    enabled: online,
    refetchInterval: polling ? POLL_MS : false,
    // A card that is not there is the right answer to a server that did not
    // answer; the next tick asks again anyway.
    retry: false,
  });

  // Coming back, to the tab or to the app, asks at once rather than waiting
  // out the interval: the timer stood still meanwhile, and whatever started
  // playing elsewhere in that time is the one thing the card is for.
  useEffect(() => {
    if (polling) void refetch();
  }, [polling, refetch]);

  const entry = data?.[0];
  // Gone once it is playing here too, whether it was picked up from this card
  // or just happened to be on: the card would otherwise offer, for up to ten
  // minutes, to start the song that is already going.
  if (!online || !entry || entry.song.id === currentId) return null;
  const player = entry.playerName || t('Another device');

  async function onPlay() {
    if (busy || !entry) return;
    setBusy(true);
    try {
      await playHere(entry, player);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.card}>
      <Cover uri={songCoverUrl(entry.song, COVER.thumb)} size={56} />
      <View style={styles.text}>
        <Text style={styles.overline} numberOfLines={1}>
          {t('Playing on {player}', { player })}
        </Text>
        <Text style={styles.title} numberOfLines={1}>
          {entry.song.title}
        </Text>
        {entry.song.artist ? (
          <Text style={styles.artist} numberOfLines={1}>
            {entry.song.artist}
          </Text>
        ) : null}
      </View>
      <Pressable
        style={({ pressed }) => [styles.button, pressed && { backgroundColor: colors.accentPressed }]}
        onPress={() => void onPlay()}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={t('Play here')}
      >
        {busy ? (
          <ActivityIndicator size={16} color={colors.onAccent} />
        ) : (
          <Ionicons name="play" size={16} color={colors.onAccent} />
        )}
        <Text style={styles.buttonText}>{t('Play here')}</Text>
      </Pressable>
    </View>
  );
}

const styles = themed((colors) => ({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.lg,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  text: { flex: 1, gap: 2 },
  overline: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  title: { color: colors.text, fontSize: fontSize.md, fontWeight: '600' },
  artist: { color: colors.textSecondary, fontSize: fontSize.sm },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  buttonText: { color: colors.onAccent, fontSize: fontSize.sm, fontWeight: '700' },
}));
