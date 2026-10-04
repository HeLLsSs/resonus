/**
 * What opens when a track or a playlist is shared to the app from YouTube,
 * YouTube Music or SoundCloud: play it now, play it next, or have the proxy
 * file it into the library.
 *
 * The text arrives through the `ShareReceiver` native module (Android only),
 * and is read here into a link (`parseSharedLink`). Everything after that is
 * the navifind proxy's: it answers for a YouTube track by its `yt_` id, reads
 * a YouTube playlist, and takes any of these links to import. Without the
 * proxy there is nothing to do with a link, and a toast says so.
 *
 * A SoundCloud link can only be filed: the proxy knows SoundCloud tracks by a
 * number the link does not carry, so there is nothing to play until it has
 * been imported.
 */
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { songCoverUrl } from '@/api/data';
import { COVER, getSong, importIntoLibrary, youtubePlaylist, type Song } from '@/api/subsonic';
import { Cover } from '@/components/Cover';
import { SheetModal } from '@/components/SheetModal';
import { songsLabel, tg, useT } from '@/i18n';
import { askNotificationPermission, navifindWorkStarted } from '@/lib/navifindWatch';
import { parseSharedLink, type SharedLink } from '@/lib/sharedLink';
import { useAuthStore } from '@/store/auth';
import { usePlayerStore } from '@/store/player';
import { useSettings } from '@/store/settings';
import { useToast } from '@/store/toast';
import { colors, fontSize, spacing, themed } from '@/theme';

interface NativeShareReceiver {
  takeSharedText: () => string | null;
  addListener: (event: 'shared', cb: (e: { text: string }) => void) => { remove: () => void };
}

const native = requireOptionalNativeModule<NativeShareReceiver>('ShareReceiver');

/** As many as the playlist screen asks for, so the two share one cache entry. */
const PLAYLIST_TRACKS = 300;

function Action({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress?: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.action, !onPress && { opacity: 0.4 }, pressed && { opacity: 0.6 }]}
      accessibilityRole="button"
      accessibilityState={{ disabled: !onPress }}
      disabled={!onPress}
      onPress={onPress}
    >
      <Ionicons name={icon} size={24} color={colors.text} />
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}

export function SharedLinkSheet() {
  const t = useT();
  const lang = useSettings((s) => s.language);
  const auth = useAuthStore((s) => s.auth);
  const toast = useToast((s) => s.show);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const queueMany = usePlayerStore((s) => s.queueMany);
  const openRef = useRef<() => void>(() => {});
  const [link, setLink] = useState<SharedLink | null>(null);

  useEffect(() => {
    if (!native) return;
    // Read off the stores when the share arrives, not when the listener was
    // set up: the proxy may have been switched on in between.
    const receive = (text: string) => {
      const say = useToast.getState().show;
      const parsed = parseSharedLink(text);
      if (!parsed) return say(tg('Only YouTube and SoundCloud links can be opened here'));
      if (!useSettings.getState().navifind) {
        return say(tg('Shared links need the Navifind proxy: turn it on in Settings › Navifind'));
      }
      const { auth: signedIn, offline: cut } = useAuthStore.getState();
      if (cut || !signedIn) return say(tg('Offline: nothing to ask.'));
      setLink(parsed);
      openRef.current();
    };
    const started = native.takeSharedText();
    if (started) receive(started);
    const sub = native.addListener('shared', (e) => receive(e.text));
    return () => sub.remove();
  }, []);

  const track = link?.source === 'youtube' && link.kind === 'track' ? link : null;
  const list = link?.source === 'youtube' && link.kind === 'playlist' ? link : null;
  const songQuery = useQuery({
    queryKey: ['song', `yt_${track?.videoId}`],
    queryFn: () => getSong(auth!, `yt_${track!.videoId}`),
    enabled: !!track && !!auth,
    retry: false,
  });
  const listQuery = useQuery({
    queryKey: ['youtube', 'playlist', list?.listId],
    queryFn: () => youtubePlaylist(auth!, list!.listId, PLAYLIST_TRACKS),
    enabled: !!list && !!auth,
    retry: false,
  });

  const source = link?.source === 'soundcloud' ? t('Shared from SoundCloud') : t('Shared from YouTube');
  const song = track ? songQuery.data : null;
  const songs: Song[] | null = song ? [song] : list ? (listQuery.data?.songs ?? null) : null;
  const loading = (!!track && songQuery.isLoading) || (!!list && listQuery.isLoading);
  const failed = (!!track && (songQuery.isError || songQuery.data === null)) || (!!list && listQuery.isError);
  const title = song?.title ?? listQuery.data?.name ?? link?.url ?? '';
  const subtitle = song
    ? song.artist
    : listQuery.data
      ? songsLabel(listQuery.data.songCount ?? listQuery.data.songs.length, lang)
      : link?.source === 'soundcloud'
        ? t('SoundCloud links can only be filed into the library')
        : failed
          ? t("Couldn't read that link")
          : undefined;
  const coverUri = song ? songCoverUrl(song, COVER.thumb) : (listQuery.data?.thumbnail ?? undefined);

  const fileIt = async (shared: SharedLink) => {
    if (!auth) return;
    void askNotificationPermission();
    try {
      const work = importIntoLibrary(auth, shared.url);
      navifindWorkStarted(work);
      const { queued } = await work;
      toast(
        queued === 0
          ? t('Nothing to fetch at that link')
          : queued === 1
            ? t('Fetching 1 track into the library')
            : t('Fetching {n} tracks into the library', { n: queued }),
      );
    } catch {
      toast(t("The proxy couldn't take that link"));
    }
  };

  return (
    <SheetModal openRef={openRef} onClosed={() => setLink(null)}>
      {(close) =>
        link ? (
          <>
            <Text style={styles.source}>{source}</Text>
            <View style={styles.header}>
              <Cover uri={coverUri} size={48} placeholderIcon={list ? 'list' : 'musical-note'} />
              <View style={styles.headerText}>
                <Text style={styles.title} numberOfLines={2}>
                  {title}
                </Text>
                {subtitle ? (
                  <Text style={styles.subtitle} numberOfLines={2}>
                    {subtitle}
                  </Text>
                ) : null}
              </View>
              {loading ? <ActivityIndicator color={colors.textSecondary} /> : null}
            </View>
            <View style={styles.divider} />
            {link.source === 'youtube' ? (
              <>
                <Action
                  icon="play-outline"
                  label={t('Play now')}
                  onPress={
                    songs?.length
                      ? () => {
                          close();
                          void playQueue(songs, 0, title, list ? `/youtube/${list.listId}` : undefined);
                        }
                      : undefined
                  }
                />
                <Action
                  icon="play-forward-outline"
                  label={t('Play next')}
                  onPress={
                    songs?.length
                      ? () => {
                          close();
                          queueMany(songs, 'next');
                          toast(t('Playing next'));
                        }
                      : undefined
                  }
                />
              </>
            ) : null}
            <Action
              icon="cloud-download-outline"
              label={t('Add to my library')}
              onPress={() => {
                close();
                void fileIt(link);
              }}
            />
          </>
        ) : null
      }
    </SheetModal>
  );
}

const styles = themed((colors) => ({
  source: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '700',
    marginBottom: spacing.md,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  headerText: { flex: 1 },
  title: { color: colors.text, fontSize: fontSize.md, fontWeight: '700' },
  subtitle: { color: colors.textSecondary, fontSize: fontSize.xs, marginTop: 2 },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    paddingVertical: spacing.md,
  },
  actionText: { color: colors.text, fontSize: fontSize.md },
}));
