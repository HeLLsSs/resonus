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
 *
 * Once the other device has stopped, the card turns into "continue": the song
 * it stopped on, which device and at what time, and a button that restores
 * its whole queue here and winds to the second it stopped at. Which device
 * stopped last comes from the proxy's playback spot, since this account's
 * devices all send the same client name; what to offer is `resumeOffer`.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import { useIsFocused } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, Text, View } from 'react-native';

import { getPlayQueue } from '@/api/backend';
import { COVER, getNowPlaying, songCoverUrl, type NowPlayingEntry } from '@/api/data';
import { CLIENT_NAME, lastPlayback, type SavedQueue, type SubsonicAuth } from '@/api/subsonic';
import { Cover } from '@/components/Cover';
import { type TFunction, useT } from '@/i18n';
import { navifindActive } from '@/lib/navifind';
import { type LastStop, RESUME_WINDOW_MS, resumeOffer, type ResumeOffer } from '@/lib/resumeElsewhere';
import { useAuthStore } from '@/store/auth';
import { thisDevice } from '@/store/playbackLock';
import { usePlayerStore } from '@/store/player';
import { useSettings } from '@/store/settings';
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

/** The last stop and the server's queue, as `resumeOffer` reads them. */
interface ResumeData {
  stop: LastStop | null;
  saved: SavedQueue | null;
}

/**
 * The queue fetched for a stop, kept for as long as the stop is the same one.
 * The proxy's answer is a few bytes and asked on every tick; the queue is the
 * whole of it with every song's metadata, and only changes with a new stop.
 */
let savedFor: { at: number; saved: SavedQueue | null } | null = null;

async function fetchResume(auth: SubsonicAuth): Promise<ResumeData> {
  let stop: LastStop | null = null;
  if (navifindActive()) {
    const device = await thisDevice().catch(() => null);
    const holder = device ? await lastPlayback(auth, device).catch(() => null) : null;
    if (holder) stop = { name: holder.name, at: holder.at, mine: holder.mine, stopped: holder.stopped === true };
    // Nothing to offer whatever the queue says: not worth asking for it.
    if (stop && (stop.mine || !stop.stopped || Date.now() - stop.at > RESUME_WINDOW_MS)) return { stop, saved: null };
    if (stop && savedFor?.at === stop.at) return { stop, saved: savedFor.saved };
  }
  const saved = await getPlayQueue(auth).catch(() => null);
  // Only once the stopped device's last save has landed: it pauses, then
  // saves a few seconds later, and a queue read in between carries the second
  // of its save before that one.
  if (stop && saved?.changed !== undefined && saved.changed >= stop.at) savedFor = { at: stop.at, saved };
  return { stop, saved };
}

/** The other device as the sentence names it, in the reader's language. */
function deviceName(device: string, t: TFunction): string {
  if (device === 'browser') return t('the browser');
  if (device === 'phone') return t('the phone');
  return device || t('another device');
}

/** "Stopped on the browser at 21:14", or yesterday at that time. */
function stoppedLabel(offer: ResumeOffer, t: TFunction, lang: string): string {
  const when = new Date(offer.at);
  const vars = {
    device: deviceName(offer.device, t),
    time: when.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' }),
  };
  return when.toDateString() === new Date().toDateString()
    ? t('Stopped on {device} at {time}', vars)
    : t('Stopped on {device} yesterday at {time}', vars);
}

export function PlayingElsewhereCard() {
  useTheme();
  const t = useT();
  const online = useAuthStore((s) => !!s.auth && !s.offline);
  const currentId = usePlayerStore((s) => s.queue[s.index]?.id);
  const playing = usePlayerStore((s) => s.isPlaying);
  const lang = useSettings((s) => s.language);
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

  // Coming back, to the tab or to the app, asks at once rather than waiting
  // out the interval: the timer stood still meanwhile, and whatever started
  // playing elsewhere in that time is the one thing the card is for. The
  // query is switched on and off for that rather than asked again from an
  // effect: never stale, it is fetched the moment it is switched on, and the
  // interval only runs while it is. An effect calling `refetch` on mount
  // cancelled the request the mount had just started and sent a second one.
  const { data } = useQuery({
    queryKey: ['nowPlaying'],
    queryFn: () => getNowPlaying(),
    enabled: polling,
    staleTime: 0,
    refetchInterval: POLL_MS,
    // A card that is not there is the right answer to a server that did not
    // answer; the next tick asks again anyway.
    retry: false,
  });

  // The same rule for the "continue" half, and only with nothing playing
  // here: somebody listening has nothing to resume.
  const { data: resume, dataUpdatedAt: resumeAt } = useQuery({
    queryKey: ['resumeElsewhere'],
    queryFn: () => {
      const { auth } = useAuthStore.getState();
      return auth ? fetchResume(auth) : { stop: null, saved: null };
    },
    enabled: polling && !playing,
    staleTime: 0,
    refetchInterval: POLL_MS,
    retry: false,
  });
  const offer =
    online && resume
      ? resumeOffer({
          // When the answer came, which is at most a tick ago.
          now: resumeAt,
          playing,
          saved: resume.saved,
          stop: resume.stop,
          ourClient: CLIENT_NAME,
          // Read, not watched: it only matters while paused, when it stands
          // still, and watching it re-drew the card on every tick of a song.
          here: { id: currentId, positionMs: usePlayerStore.getState().positionSec * 1000 },
        })
      : null;
  const resumeSong = offer ? resume?.saved?.entries[offer.index] : undefined;
  if (offer && resumeSong && resume?.saved) {
    const saved = resume.saved;
    const from = deviceName(offer.device, t);
    const onResume = async () => {
      if (busy) return;
      setBusy(true);
      try {
        const player = usePlayerStore.getState();
        if (await player.playQueue(saved.entries, offer.index, from)) {
          if (offer.positionMs > 0) player.seekTo(offer.positionMs / 1000);
        }
      } finally {
        setBusy(false);
      }
    };
    return (
      <ElsewhereRow
        song={resumeSong}
        overline={t('Continue')}
        detail={stoppedLabel(offer, t, lang)}
        action={t('Resume here')}
        busy={busy}
        onPress={() => void onResume()}
      />
    );
  }

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
    <ElsewhereRow
      song={entry.song}
      overline={t('Playing on {player}', { player })}
      detail={entry.song.artist}
      action={t('Play here')}
      busy={busy}
      onPress={() => void onPlay()}
    />
  );
}

/** One song from another device, and the button that brings it here. */
function ElsewhereRow({
  song,
  overline,
  detail,
  action,
  busy,
  onPress,
}: {
  song: NowPlayingEntry['song'];
  overline: string;
  detail?: string;
  action: string;
  busy: boolean;
  onPress: () => void;
}) {
  useTheme();
  return (
    <View style={styles.card}>
      <Cover uri={songCoverUrl(song, COVER.thumb)} size={56} />
      <View style={styles.text}>
        <Text style={styles.overline} numberOfLines={1}>
          {overline}
        </Text>
        <Text style={styles.title} numberOfLines={1}>
          {song.title}
        </Text>
        {detail ? (
          <Text style={styles.artist} numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
      <Pressable
        style={({ pressed }) => [styles.button, pressed && { backgroundColor: colors.accentPressed }]}
        onPress={onPress}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={action}
      >
        {busy ? (
          <ActivityIndicator size={16} color={colors.onAccent} />
        ) : (
          <Ionicons name="play" size={16} color={colors.onAccent} />
        )}
        <Text style={styles.buttonText}>{action}</Text>
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
