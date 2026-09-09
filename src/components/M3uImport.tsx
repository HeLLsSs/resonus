/**
 * The import half of M3U playlists: a hook that runs the file picker and the
 * search, and the card it ends on.
 *
 * A hook rather than a screen because the entry point is one line in whatever
 * screen makes playlists, and the summary has to outlive the sheet or dialog
 * that line sat in: the caller mounts `element` once and calls `start` from
 * wherever. Nothing here is a toast, because a toast hides under a modal and
 * a list of forty titles does not fit in one.
 */
import { useRouter } from 'expo-router';
import { useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useT } from '@/i18n';
import { importM3u, MAX_ENTRIES, pickM3uFile, type M3uImportResult } from '@/lib/m3u';
import { queryClient } from '@/lib/query';
import { useToast } from '@/store/toast';
import { colors, fontSize, radius, spacing, themed } from '@/theme';

/** The card is up while the search runs, and stays up with what it found. */
type Stage = 'busy' | M3uImportResult;

export function useM3uImport(): { start: () => Promise<void>; element: ReactNode } {
  const t = useT();
  const toast = useToast((s) => s.show);
  const router = useRouter();
  const [stage, setStage] = useState<Stage | null>(null);

  async function start() {
    let file: { name: string; text: string } | null;
    try {
      file = await pickM3uFile();
    } catch {
      toast(t("Couldn't read the file"));
      return;
    }
    if (!file) return;
    setStage('busy');
    try {
      const result = await importM3u(file.text, file.name);
      if (result.playlistId) void queryClient.invalidateQueries({ queryKey: ['playlists'] });
      setStage(result);
    } catch {
      setStage(null);
      toast(t("Couldn't complete the action"));
    }
  }

  const result = stage === 'busy' || stage === null ? null : stage;
  const element = (
    <Modal transparent visible={stage !== null} animationType="fade" onRequestClose={() => {}}>
      <View style={styles.backdrop} />
      <View style={styles.center} pointerEvents="box-none">
        <View style={styles.card}>
          {result ? (
            <>
              <Text style={styles.title}>{result.name}</Text>
              <Text style={styles.message}>
                {result.total === 0
                  ? t('This file has no tracks')
                  : t('{n} of {m} tracks found', { n: result.found, m: result.total })}
              </Text>
              {result.truncated ? (
                <Text style={styles.message}>
                  {t('Only the first {n} entries were read', { n: MAX_ENTRIES })}
                </Text>
              ) : null}
              {result.unresolved.length > 0 ? (
                <>
                  <Text style={styles.label}>{t('Not found on the server')}</Text>
                  <ScrollView style={styles.list} nestedScrollEnabled>
                    {result.unresolved.map((line, i) => (
                      <Text key={`${i}-${line}`} style={styles.line} numberOfLines={2}>
                        {line}
                      </Text>
                    ))}
                  </ScrollView>
                </>
              ) : null}
              <View style={styles.actions}>
                <Pressable hitSlop={8} onPress={() => setStage(null)}>
                  <Text style={styles.cancel}>{t('Done')}</Text>
                </Pressable>
                {result.playlistId ? (
                  <Pressable
                    hitSlop={8}
                    onPress={() => {
                      const id = result.playlistId;
                      setStage(null);
                      router.push(`/playlist/${id}`);
                    }}
                  >
                    <Text style={styles.confirm}>{t('Open')}</Text>
                  </Pressable>
                ) : null}
              </View>
            </>
          ) : (
            <View style={styles.busy}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.message}>{t('Importing…')}</Text>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );

  return { start, element };
}

const styles = themed((colors) => ({
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: colors.backdropStrong },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  card: {
    width: '100%',
    backgroundColor: colors.surfaceHighlight,
    borderRadius: radius.lg,
    padding: spacing.xl,
    gap: spacing.md,
  },
  busy: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  title: { color: colors.text, fontSize: fontSize.lg, fontWeight: '600' },
  message: { color: colors.textSecondary, fontSize: fontSize.md },
  label: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '600' },
  // Bounded, so forty missing titles scroll inside the card instead of
  // pushing its buttons off the screen.
  list: {
    maxHeight: 220,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  line: { color: colors.text, fontSize: fontSize.sm, paddingVertical: 2 },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.xl,
    marginTop: spacing.sm,
  },
  cancel: { color: colors.textSecondary, fontSize: fontSize.md, fontWeight: '600' },
  confirm: { color: colors.accent, fontSize: fontSize.md, fontWeight: '700' },
}));
