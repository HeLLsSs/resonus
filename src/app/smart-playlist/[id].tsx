/**
 * A smart playlist, opened: its rules run over the library, and the songs
 * that fit drawn like any playlist.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { createPlaylist, getAllSongs, reorderPlaylist } from '@/api/data';
import { Dialog } from '@/components/Dialog';
import { EmptyState } from '@/components/EmptyState';
import { Message } from '@/components/Message';
import { SheetModal } from '@/components/SheetModal';
import { TrackListSkeleton } from '@/components/TrackListSkeleton';
import { TrackListView } from '@/components/TrackListView';
import { songsLabel, useT } from '@/i18n';
import { formatTotalDuration } from '@/lib/format';
import { resolveSmartPlaylist } from '@/lib/smartPlaylists';
import { useAuthStore } from '@/store/auth';
import { currentSong, usePlayerStore } from '@/store/player';
import { usePlaylistPicker } from '@/store/playlistPicker';
import { useSettings } from '@/store/settings';
import { useSmartPlaylists } from '@/store/smartPlaylists';
import { useToast } from '@/store/toast';
import { colors, fontSize, spacing, themed, useTheme } from '@/theme';
import { rulesLabel, SmartPlaylistArt } from '../smart-playlists';

/** How long the library is trusted before it is asked for again. Long: a
 *  whole library comes down for it, and the rules are what changes. */
const LIBRARY_STALE_MS = 10 * 60 * 1000;

export default function SmartPlaylistScreen() {
  // Repaints on a change of appearance or accent: a stack keeps this screen
  // mounted while you are on another one, out of reach of anything else.
  useTheme();
  const t = useT();
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast((s) => s.show);
  const { id } = useLocalSearchParams<{ id: string }>();
  const list = useSmartPlaylists((s) => s.lists.find((l) => l.id === id));
  const remove = useSmartPlaylists((s) => s.remove);
  const lang = useSettings((s) => s.language);
  const showListArtwork = useSettings((s) => s.showListArtwork);
  const offline = useAuthStore((s) => s.offline);
  const playing = usePlayerStore(currentSong);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const menuRef = useRef<() => void>(() => {});
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Bumped to deal a random list again without asking the server for anything.
  const [deal, setDeal] = useState(0);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['allSongs'],
    queryFn: getAllSongs,
    staleTime: LIBRARY_STALE_MS,
  });

  const songs = useMemo(
    () => (data && list ? resolveSmartPlaylist(data, list) : []),
    // `deal` is in here on purpose: it is what asks for another shuffle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, list, deal],
  );

  if (!list) return <Message text={t('Nothing here yet')} />;
  if (isLoading) return <TrackListSkeleton />;
  if (error && !data) return <Message text={t("Couldn't load your songs.")} onRetry={() => void refetch()} />;

  const totalSec = songs.reduce((sum, s) => sum + (s.duration ?? 0), 0);
  const meta = [t('Smart playlist'), rulesLabel(list, t), songsLabel(songs.length, lang)];
  if (totalSec > 0) meta.push(formatTotalDuration(totalSec));
  const href = `/smart-playlist/${list.id}`;

  /** Writes what the rules found today as an ordinary playlist on the server. */
  async function snapshot(name: string) {
    setSaving(false);
    if (!name || songs.length === 0) return;
    try {
      const playlistId = await createPlaylist(name);
      await reorderPlaylist(
        playlistId,
        songs.map((s) => s.id),
      );
      queryClient.invalidateQueries({ queryKey: ['playlists'] });
      toast(t('Playlist saved on the server'));
    } catch {
      toast(t("Couldn't save the playlist"));
    }
  }

  return (
    <>
      <TrackListView
        title={list.name}
        meta={meta.join(' · ')}
        renderCover={(size) => <SmartPlaylistArt size={size} />}
        songs={songs}
        currentId={playing?.id}
        onMenu={() => menuRef.current()}
        showArtwork={showListArtwork}
        searchable
        emptyState={
          <EmptyState
            icon="sparkles-outline"
            title={t('Nothing matches these rules yet')}
            subtitle={t('Loosen a rule or two.')}
            action={{ label: t('Edit rules'), onPress: () => router.push(`/smart-playlist/edit?id=${list.id}`) }}
          />
        }
        selection={{ onAddTo: (sel) => usePlaylistPicker.getState().open(sel) }}
        onPlay={(start, opts) => playQueue(songs, start, list.name, href, opts)}
      />
      <SheetModal openRef={menuRef}>
        {(close) => (
          <>
            <Pressable
              style={({ pressed }) => [styles.action, pressed && { opacity: 0.6 }]}
              onPress={() => {
                close();
                router.push(`/smart-playlist/edit?id=${list.id}`);
              }}
            >
              <Ionicons name="options-outline" size={24} color={colors.text} />
              <Text style={styles.actionText}>{t('Edit rules')}</Text>
            </Pressable>
            {list.sort === 'random' ? (
              <Pressable
                style={({ pressed }) => [styles.action, pressed && { opacity: 0.6 }]}
                onPress={() => {
                  close();
                  setDeal((d) => d + 1);
                }}
              >
                <Ionicons name="shuffle" size={24} color={colors.text} />
                <Text style={styles.actionText}>{t('Reshuffle')}</Text>
              </Pressable>
            ) : null}
            <Pressable
              style={({ pressed }) => [styles.action, pressed && { opacity: 0.6 }]}
              onPress={() => {
                close();
                void refetch();
              }}
            >
              <Ionicons name="refresh" size={24} color={colors.text} />
              <Text style={styles.actionText}>{t('Refresh')}</Text>
            </Pressable>
            {!offline && songs.length > 0 ? (
              <Pressable
                style={({ pressed }) => [styles.action, pressed && { opacity: 0.6 }]}
                onPress={() => {
                  close();
                  setSaving(true);
                }}
              >
                <Ionicons name="cloud-upload-outline" size={24} color={colors.text} />
                <Text style={styles.actionText}>{t('Save on the server as a playlist')}</Text>
              </Pressable>
            ) : null}
            <View style={styles.actionDivider} />
            <Pressable
              style={({ pressed }) => [styles.action, pressed && { opacity: 0.6 }]}
              onPress={() => {
                close();
                setDeleting(true);
              }}
            >
              <Ionicons name="trash-outline" size={24} color={colors.danger} />
              <Text style={[styles.actionText, { color: colors.danger }]}>{t('Delete smart playlist')}</Text>
            </Pressable>
          </>
        )}
      </SheetModal>
      <Dialog
        visible={saving}
        title={t('Save on the server as a playlist')}
        message={t('What the rules find today is written down as a playlist; it will not follow the rules afterwards.')}
        input={{ placeholder: t('Playlist name'), initialValue: list.name }}
        confirmLabel={t('Save')}
        onCancel={() => setSaving(false)}
        onConfirm={(name) => void snapshot(name)}
      />
      <Dialog
        visible={deleting}
        title={t('Delete smart playlist')}
        message={t('Only the rules go: no song is touched.')}
        confirmLabel={t('Delete')}
        destructive
        onCancel={() => setDeleting(false)}
        onConfirm={() => {
          setDeleting(false);
          remove(list.id);
          router.back();
        }}
      />
    </>
  );
}

const styles = themed((colors) => ({
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  actionText: { color: colors.text, fontSize: fontSize.md },
  actionDivider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.xs },
}));
