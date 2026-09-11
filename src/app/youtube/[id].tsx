/**
 * A YouTube playlist, opened from the tab: its tracks, drawn like any other
 * list in the app.
 *
 * Nothing here is the server's. The proxy reads the playlist from YouTube and
 * hands the tracks over in the ordinary song shape, each with a `yt_` id, so
 * the list plays exactly like an album's does and each track it plays through
 * ends up in the library on its own. Which also means there is no favourite to
 * mark, no download, and no reordering: none of those are this list's to
 * change, and the header is asked for only what it can honestly show.
 *
 * A public playlist opens for anybody. A private one is the account's, so it
 * comes back only while the proxy is signed in, and when that has run out the
 * screen says which of the two things went wrong (see `lib/youtube.ts`).
 */
import { useQuery } from '@tanstack/react-query';
import { Redirect, useLocalSearchParams } from 'expo-router';

import { youtubePlaylist } from '@/api/subsonic';
import { Message } from '@/components/Message';
import { TrackListSkeleton } from '@/components/TrackListSkeleton';
import { TrackListView } from '@/components/TrackListView';
import { songsLabel, useT } from '@/i18n';
import { formatTotalDuration } from '@/lib/format';
import { accountRefusal } from '@/lib/youtube';
import { useAuthStore } from '@/store/auth';
import { currentSong, usePlayerStore } from '@/store/player';
import { useSettings } from '@/store/settings';
import { useTheme } from '@/theme';

/** How much of a long list is worth asking for at once. There is no paging
 *  here: the proxy answers the whole thing or the first `count` of it. */
const TRACKS = 300;

export default function YoutubePlaylistScreen() {
  // Repaints on a change of appearance or accent: a stack keeps this screen
  // mounted while you are on another one, out of reach of anything else.
  useTheme();
  const t = useT();
  const { id } = useLocalSearchParams<{ id: string }>();
  const auth = useAuthStore((s) => s.auth);
  const offline = useAuthStore((s) => s.offline);
  const navifind = useSettings((s) => s.navifind);
  const showListArtwork = useSettings((s) => s.showListArtwork);
  const lang = useSettings((s) => s.language);
  const playing = usePlayerStore(currentSong);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['youtube', 'playlist', id],
    queryFn: () => youtubePlaylist(auth!, id, TRACKS),
    enabled: navifind && !!auth && !offline,
    retry: false,
  });

  // The proxy is what answers for all of this, so without it there is no
  // screen to show — the same door the tab itself closes.
  if (!navifind || !auth) return <Redirect href="/" />;
  if (offline) return <Message text={t('Offline: nothing to ask.')} />;
  if (isLoading) return <TrackListSkeleton />;
  if (error || !data) {
    const refusal = accountRefusal(error);
    return (
      <Message
        text={
          refusal === 'expired'
            ? t('Your YouTube session has expired')
            : refusal === 'none'
              ? t('No YouTube account on the proxy')
              : t("Couldn't load the playlist.")
        }
        onRetry={refusal === null ? () => void refetch() : undefined}
      />
    );
  }

  const totalSec = data.songs.reduce((acc, s) => acc + (s.duration ?? 0), 0);
  const meta = [t('Playlist'), songsLabel(data.songCount ?? data.songs.length, lang)];
  if (totalSec > 0) meta.push(formatTotalDuration(totalSec));
  const href = `/youtube/${encodeURIComponent(data.id)}`;

  return (
    <TrackListView
      title={data.name}
      subtitle={data.owner}
      meta={meta.join(' · ')}
      coverUri={data.thumbnail}
      songs={data.songs}
      currentId={playing?.id}
      showArtwork={showListArtwork}
      searchable
      onPlay={(start, opts) => playQueue(data.songs, start, data.name, href, opts)}
    />
  );
}
