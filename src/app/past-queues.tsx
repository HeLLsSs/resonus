/**
 * Past queues: the last few queues this profile replaced, kept so one can be
 * brought back (see `store/queueHistory`). A row puts that queue back where
 * it was, cursor included, and a long press forgets it.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getSongsByIds } from '@/api/data';
import { BackChevron } from '@/components/BackChevron';
import { Dialog } from '@/components/Dialog';
import { EmptyState } from '@/components/EmptyState';
import { useScreenBottomPadding } from '@/hooks/useScreenBottomPadding';
import { useListPadding } from '@/hooks/useScreenSize';
import { songsLabel, useT } from '@/i18n';
import { haptic } from '@/lib/haptics';
import { usePlayerStore } from '@/store/player';
import { useQueueHistory, type PastQueue } from '@/store/queueHistory';
import { useSettings } from '@/store/settings';
import { useToast } from '@/store/toast';
import { colors, fontSize, radius, spacing, themed, useTheme } from '@/theme';

export default function PastQueuesScreen() {
  // Repaints on a change of appearance or accent: a stack keeps this screen
  // mounted while you are on another one, out of reach of anything else.
  useTheme();
  const t = useT();
  const lang = useSettings((s) => s.language);
  const router = useRouter();
  const bottomPad = useScreenBottomPadding();
  const listPad = useListPadding(spacing.lg);
  const queues = useQueueHistory((s) => s.queues);
  const hydrate = useQueueHistory((s) => s.hydrate);
  const remove = useQueueHistory((s) => s.remove);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const toast = useToast((s) => s.show);
  const [busy, setBusy] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<PastQueue | null>(null);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  /** "12 songs · 8 Sept, 14:05". */
  const detail = (q: PastQueue): string => {
    const when = new Date(q.at);
    const date = when.toLocaleDateString(lang, {
      day: 'numeric',
      month: 'short',
      ...(when.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' as const } : {}),
    });
    const time = when.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
    return `${songsLabel(q.songIds.length, lang)} · ${date}, ${time}`;
  };

  /**
   * Brings the queue back and plays on from where it was. The songs are asked
   * for by id, so one the server no longer has drops out and the cursor lands
   * on the song it was on if that one is still there, else on the first.
   */
  const restore = async (q: PastQueue) => {
    if (busy) return;
    setBusy(q.id);
    try {
      const songs = await getSongsByIds(q.songIds);
      if (songs.length === 0) {
        toast(t("Couldn't bring the queue back"));
        return;
      }
      const wanted = q.songIds[q.index];
      const at = Math.max(
        0,
        songs.findIndex((s) => s.id === wanted),
      );
      const ok = await playQueue(songs, at, q.title);
      if (ok) router.back();
    } catch {
      toast(t("Couldn't bring the queue back"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.bar}>
        <BackChevron size={28} />
        <Text style={styles.barTitle}>{t('Past queues')}</Text>
        <View style={{ width: 28 }} />
      </View>
      <FlatList
        data={queues}
        keyExtractor={(q) => q.id}
        contentContainerStyle={[
          styles.list,
          { paddingBottom: bottomPad, paddingHorizontal: listPad },
        ]}
        ListEmptyComponent={
          <EmptyState
            icon="time-outline"
            title={t('No past queues yet')}
            subtitle={t('When a queue is replaced by another, it is kept here for a while.')}
          />
        }
        renderItem={({ item }) => (
          <Pressable
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
            onPress={() => void restore(item)}
            onLongPress={() => {
              haptic('medium');
              setDeleting(item);
            }}
          >
            <View style={styles.art}>
              {busy === item.id ? (
                <ActivityIndicator color={colors.accent} />
              ) : (
                <Ionicons name="list" size={26} color={colors.accent} />
              )}
            </View>
            <View style={styles.rowInfo}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={styles.rowSub} numberOfLines={1}>
                {detail(item)}
              </Text>
            </View>
            <Ionicons name="play-outline" size={22} color={colors.textSecondary} />
          </Pressable>
        )}
      />

      <Dialog
        visible={deleting !== null}
        title={t('Forget this queue')}
        message={deleting?.title}
        confirmLabel={t('Forget')}
        destructive
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) void remove(deleting.id);
          setDeleting(null);
        }}
      />
    </SafeAreaView>
  );
}

const styles = themed((colors) => ({
  safe: { flex: 1, backgroundColor: colors.background },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  barTitle: { color: colors.text, fontSize: fontSize.lg, fontWeight: '600' },
  list: { flexGrow: 1, gap: spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  rowInfo: { flex: 1 },
  rowTitle: { color: colors.text, fontSize: fontSize.md, fontWeight: '600' },
  rowSub: { color: colors.textSecondary, fontSize: fontSize.xs, marginTop: 2 },
  art: {
    width: 56,
    height: 56,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceHighlight,
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
