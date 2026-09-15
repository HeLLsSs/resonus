/**
 * Browsing a WebDAV share: folders, and the music in them.
 *
 * The folders are the library: nothing is scanned before a share can be used,
 * which is what makes one of ten thousand files work the moment it is added.
 *
 * A song therefore arrives as its filename, and its tags are read behind the
 * list — a few hundred bytes per file rather than the file (`webdavTags`) —
 * so the names and artists fill themselves in while somebody is already
 * reading the folder. What has no ID3 tag keeps its filename, which today
 * means anything that is not an MP3.
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
import { type ID3Tags } from '@/lib/id3';
import { isAudio, nameFromHref, type DavEntry } from '@/lib/webdav';
import { inBatches, readRemoteTags } from '@/lib/webdavTags';
import { usePlayerStore } from '@/store/player';
import { authHeaderFor, davSongId, listFolder, urlFor, useWebdav } from '@/store/webdav';
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

  /**
   * What was read, and the folder it was read from. The two are one piece of
   * state because they change together: moving to another folder must not show
   * the last one's files for a frame, and clearing them on the way in is a
   * render nobody needs — the folder it belongs to is checked when it is read.
   */
  const where = `${source?.id ?? ''}|${here}`;
  const [read, setRead] = useState<{ at: string; entries: DavEntry[] | null; failed: boolean }>({
    at: where,
    entries: null,
    failed: false,
  });
  const entries = read.at === where ? read.entries : null;
  const failed = read.at === where && read.failed;
  /**
   * What the tags said, by href, as they come in. The list is shown at once
   * from the filenames and each row is replaced as its tag arrives, so a
   * folder is usable while this is still running and nothing waits on it.
   */
  const [tags, setTags] = useState<Record<string, ID3Tags>>({});

  useEffect(() => {
    let live = true;
    if (!source) return;
    listFolder(source, here)
      .then((found) => {
        if (live) setRead({ at: where, entries: found, failed: false });
      })
      .catch(() => {
        if (live) setRead({ at: where, entries: null, failed: true });
      });
    return () => {
      live = false;
    };
  }, [source, here, where]);

  // The tags, behind the list. A few at a time: a folder of fifty songs fired
  // at once is how a phone times out its own connections.
  useEffect(() => {
    let live = true;
    if (!source || !entries) return;
    const files = entries.filter(isAudio);
    if (files.length === 0) return;
    void (async () => {
      const headers = await authHeaderFor(source.id);
      await inBatches(files, 4, async (file) => {
        if (!live) return;
        const found = await readRemoteTags(urlFor(source, `${here ? `${here}/` : ''}${nameFromHref(file.href)}`), headers);
        if (!live || !found) return;
        // One at a time rather than all at the end: the names appear as they
        // are read, which is what makes the wait bearable on a slow share.
        setTags((had) => ({ ...had, [file.href]: found }));
      });
    })();
    return () => {
      live = false;
    };
  }, [source, here, entries]);

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
    const songs: Song[] = music.map((file) => {
      const tag = tags[file.href];
      return {
        id: davSongId(source!.id, `${here ? `${here}/` : ''}${nameFromHref(file.href)}`),
        title: tag?.title || songTitle(file.name),
        // What the tag says, and where it came from when it says nothing: a
        // folder is a poor album name, but it beats no name at all.
        album: tag?.album || source!.name,
        artist: tag?.artist || here.split('/').filter(Boolean).slice(-1)[0] || source!.name,
        track: tag?.track,
        year: tag?.year,
        size: file.size,
      };
    });
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
              <View style={styles.labels}>
                <Text style={styles.name} numberOfLines={1}>
                  {item.isFolder ? item.name : tags[item.href]?.title || songTitle(item.name)}
                </Text>
                {!item.isFolder && tags[item.href]?.artist ? (
                  <Text style={styles.artist} numberOfLines={1}>
                    {tags[item.href]?.artist}
                  </Text>
                ) : null}
              </View>
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
  labels: { flexShrink: 1 },
  name: { color: colors.text, fontSize: fontSize.md },
  artist: { color: colors.textSecondary, fontSize: fontSize.sm },
}));
