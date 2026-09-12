/**
 * Browsing a WebDAV share: folders, and the music in them.
 *
 * The folders are the library. Nothing was scanned, so a song is named by its
 * filename and nothing else — no album, no artist, no cover — and that is the
 * bargain: it works on a share of ten thousand files the moment it is added,
 * where reading the tags of all of them over a network would take an evening.
 *
 * Opening a folder of music plays it as a queue, starting where you pressed,
 * so a folder behaves like an album without pretending to be one.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';

import { type Song } from '@/api/subsonic';
import { EmptyState } from '@/components/EmptyState';
import { Message } from '@/components/Message';
import { ScreenHeader, SettingsSafeArea } from '@/components/SettingsUI';
import { useT } from '@/i18n';
import { isAudio, nameFromHref, type DavEntry } from '@/lib/webdav';
import { usePlayerStore } from '@/store/player';
import { davSongId, listFolder, useWebdav } from '@/store/webdav';
import { colors, fontSize, spacing, themed, useTheme } from '@/theme';

/** The name without its extension, which is what somebody reads. */
function songTitle(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export default function WebdavBrowse() {
  const t = useT();
  useTheme();
  const router = useRouter();
  const { id, path } = useLocalSearchParams<{ id: string; path?: string }>();
  const source = useWebdav((s) => s.sources.find((x) => x.id === id));
  const here = typeof path === 'string' ? path : '';

  const [entries, setEntries] = useState<DavEntry[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setEntries(null);
    setFailed(false);
    if (!source) return;
    listFolder(source, here)
      .then((found) => {
        if (live) setEntries(found);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [source, here]);

  if (!source) {
    return (
      <SettingsSafeArea>
        <ScreenHeader title={t('Network shares')} />
        <EmptyState icon="folder-outline" title={t('That share is gone')} />
      </SettingsSafeArea>
    );
  }

  const music = (entries ?? []).filter(isAudio);

  /** Plays the folder from the song pressed: what is around it is the queue. */
  async function play(entry: DavEntry) {
    const songs: Song[] = music.map((file) => ({
      id: davSongId(source!.id, `${here ? `${here}/` : ''}${nameFromHref(file.href)}`),
      title: songTitle(file.name),
      // Where it came from, which is the only thing known about it.
      album: source!.name,
      artist: here.split('/').filter(Boolean).slice(-1)[0] || source!.name,
      size: file.size,
    }));
    const at = music.findIndex((m) => m.href === entry.href);
    await usePlayerStore.getState().playQueue(songs, Math.max(0, at), source!.name);
  }

  const title = here ? (here.split('/').filter(Boolean).pop() ?? source.name) : source.name;

  return (
    <SettingsSafeArea>
      <ScreenHeader title={title} />
      {failed ? (
        <Message text={t('That folder could not be read. The share may be offline.')} />
      ) : entries === null ? (
        <View style={styles.waiting}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : entries.length === 0 ? (
        <EmptyState icon="folder-open-outline" title={t('Nothing here')} />
      ) : (
        <FlatList
          data={entries.filter((e) => e.isFolder || isAudio(e))}
          keyExtractor={(e) => e.href}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Pressable
              style={styles.row}
              onPress={() => {
                if (item.isFolder) {
                  const next = `${here ? `${here}/` : ''}${nameFromHref(item.href)}`;
                  router.push(`/webdav/${source.id}?path=${encodeURIComponent(next)}`);
                } else {
                  void play(item);
                }
              }}
            >
              <Ionicons
                name={item.isFolder ? 'folder-outline' : 'musical-note-outline'}
                size={22}
                color={item.isFolder ? colors.textSecondary : colors.accent}
              />
              <Text style={styles.name} numberOfLines={1}>
                {item.isFolder ? item.name : songTitle(item.name)}
              </Text>
            </Pressable>
          )}
        />
      )}
    </SettingsSafeArea>
  );
}

const styles = themed((colors) => ({
  waiting: { paddingVertical: spacing.xl, alignItems: 'center' },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  name: { color: colors.text, fontSize: fontSize.md, flexShrink: 1 },
}));
