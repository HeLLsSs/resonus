/**
 * Settings › Download activity: the queue, song by song.
 *
 * The album and playlist buttons show one number per group, and for a
 * discography that number moves for an hour without saying which song is
 * taking so long, whether anything is moving at all, or what was skipped along
 * the way. This is where that lives: what is transferring and how fast, what
 * is waiting behind it, what gave up (with a way to try again) and what
 * recently arrived. It reads the store and nothing else, so it stays live
 * without polling anything.
 */
import { Pressable, ScrollView, Text, View } from 'react-native';

import { EmptyState } from '@/components/EmptyState';
import { SettingsPage, settingsStyles } from '@/components/SettingsUI';
import { useT, type TFunction } from '@/i18n';
import { formatBytes } from '@/lib/format';
import { useDownloads, type ActiveTransfer } from '@/store/downloads';
import { useSettings } from '@/store/settings';
import { colors, fontSize, radius, spacing, themed, useTheme } from '@/theme';

/** Waiting songs listed before the list folds into "and n more". */
const QUEUED_SHOWN = 20;

/** "340 KB/s", "1.2 MB/s": one decimal where `formatBytes` would round to a whole. */
function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec >= 1024 ** 2) return `${(bytesPerSec / 1024 ** 2).toFixed(1)} MB/s`;
  return `${Math.round(bytesPerSec / 1024)} KB/s`;
}

/** The reasons the store writes down, in words. Anything else is shown as it is. */
function describeError(error: string, t: TFunction): string {
  if (error === 'stalled') return t('Stopped receiving data');
  if (error === 'network') return t('Network error');
  if (error === 'not-audio') return t('The server sent an error instead of the song');
  return error;
}

function ActiveRow({ item, accent }: { item: ActiveTransfer; accent: string }) {
  const t = useT();
  const known = item.total > 0;
  const fraction = known ? Math.min(1, item.bytes / item.total) : 0;
  const size = known
    ? `${formatBytes(item.bytes)} / ${formatBytes(item.total)}`
    : formatBytes(item.bytes);
  return (
    <View style={styles.item}>
      <Text style={styles.title} numberOfLines={1}>
        {item.song.title}
      </Text>
      <Text style={styles.subtitle} numberOfLines={1}>
        {item.song.artist || t('Unknown artist')}
      </Text>
      <View style={styles.track}>
        {/* A transcode announces no length, so there is nothing to fill: the
            bar stays a thin line and the bytes underneath do the talking. */}
        {known ? <View style={[styles.fill, { flex: fraction, backgroundColor: accent }]} /> : null}
        {known ? <View style={{ flex: 1 - fraction }} /> : null}
      </View>
      <Text style={styles.meta}>
        {size} · {formatSpeed(item.bytesPerSec)}
      </Text>
    </View>
  );
}

/** Small accent text button, the same voice as the sheet actions. */
function TextButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      hitSlop={8}
      style={({ pressed }) => [styles.button, pressed && { opacity: 0.6 }]}
      onPress={onPress}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

function SectionTitle({ title, action }: { title: string; action?: { label: string; onPress: () => void } }) {
  return (
    <View style={styles.sectionHead}>
      <Text style={[settingsStyles.sectionTitle, styles.sectionTitle]}>{title}</Text>
      {action ? <TextButton label={action.label} onPress={action.onPress} /> : null}
    </View>
  );
}

export default function DownloadActivitySettings() {
  // Repaints on a change of appearance or accent: a stack keeps this screen
  // mounted while you are on another one, out of reach of anything else.
  const { accent } = useTheme();
  const t = useT();
  const lang = useSettings((s) => s.language);
  const activity = useDownloads((s) => s.activity);
  const retry = useDownloads((s) => s.retry);
  const retryAll = useDownloads((s) => s.retryAll);
  const clearRecent = useDownloads((s) => s.clearRecent);
  const { active, queued, failed, recent } = activity;
  const speed = active.reduce((sum, tr) => sum + tr.bytesPerSec, 0);
  const empty = active.length + queued.length + failed.length + recent.length === 0;

  // Short and local: the list is recent by definition, so the year would only
  // repeat itself fifty times.
  const when = (at: number) =>
    new Date(at).toLocaleString(lang, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });

  return (
    <SettingsPage title={t('Download activity')}>
      <ScrollView contentContainerStyle={settingsStyles.content}>
        {empty ? (
          <EmptyState
            icon="cloud-download-outline"
            title={t('Nothing downloading')}
            subtitle={t(
              'Songs you download show up here while they transfer, with what is waiting behind them and what recently arrived.',
            )}
          />
        ) : null}

        {active.length > 0 || queued.length > 0 ? (
          <Text style={[settingsStyles.sectionDescription, { marginTop: 0 }]}>
            {[formatSpeed(speed), t('{n} waiting', { n: queued.length })].join(' · ')}
          </Text>
        ) : null}

        {active.length > 0 ? (
          <>
            <SectionTitle title={t('Downloading')} />
            <View style={settingsStyles.cardBox}>
              {active.map((item, i) => (
                <View key={item.id} style={i > 0 && settingsStyles.rowBorder}>
                  <ActiveRow item={item} accent={accent} />
                </View>
              ))}
            </View>
          </>
        ) : null}

        {queued.length > 0 ? (
          <>
            <SectionTitle title={t('Waiting')} />
            <View style={settingsStyles.cardBox}>
              {queued.slice(0, QUEUED_SHOWN).map((item, i) => (
                <View key={item.id} style={[styles.item, i > 0 && settingsStyles.rowBorder]}>
                  <Text style={styles.title} numberOfLines={1}>
                    {item.song.title}
                  </Text>
                  <Text style={styles.subtitle} numberOfLines={1}>
                    {item.song.artist || t('Unknown artist')}
                  </Text>
                </View>
              ))}
              {queued.length > QUEUED_SHOWN ? (
                <View style={[styles.item, settingsStyles.rowBorder]}>
                  <Text style={styles.subtitle}>
                    {t('and {n} more', { n: queued.length - QUEUED_SHOWN })}
                  </Text>
                </View>
              ) : null}
            </View>
          </>
        ) : null}

        {failed.length > 0 ? (
          <>
            <SectionTitle
              title={t('Failed')}
              action={{ label: t('Retry all'), onPress: () => void retryAll() }}
            />
            <View style={settingsStyles.cardBox}>
              {failed.map((item, i) => (
                <View key={item.id} style={[styles.failedRow, i > 0 && settingsStyles.rowBorder]}>
                  <View style={styles.grow}>
                    <Text style={styles.title} numberOfLines={1}>
                      {item.song.title}
                    </Text>
                    <Text style={styles.subtitle} numberOfLines={1}>
                      {item.song.artist || t('Unknown artist')}
                    </Text>
                    <Text style={[styles.meta, { color: colors.danger }]} numberOfLines={2}>
                      {describeError(item.error, t)}
                    </Text>
                  </View>
                  <TextButton label={t('Retry')} onPress={() => void retry(item.id)} />
                </View>
              ))}
            </View>
          </>
        ) : null}

        {recent.length > 0 ? (
          <>
            <SectionTitle
              title={t('Recent')}
              action={{ label: t('Clear'), onPress: () => void clearRecent() }}
            />
            <View style={settingsStyles.cardBox}>
              {recent.map((item, i) => (
                <View key={item.id} style={[styles.item, i > 0 && settingsStyles.rowBorder]}>
                  <Text style={styles.title} numberOfLines={1}>
                    {item.song.title}
                  </Text>
                  <Text style={styles.subtitle} numberOfLines={1}>
                    {item.song.artist || t('Unknown artist')}
                  </Text>
                  <Text style={styles.meta}>
                    {formatBytes(item.bytes)} · {when(item.at)}
                  </Text>
                </View>
              ))}
            </View>
          </>
        ) : null}
      </ScrollView>
    </SettingsPage>
  );
}

const styles = themed((colors) => ({
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  // The head row carries the spacing, so the title itself gives it up.
  sectionTitle: { flexShrink: 1, marginBottom: 0 },
  item: { paddingVertical: spacing.md, paddingHorizontal: spacing.lg, gap: 2 },
  failedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  grow: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: fontSize.md },
  subtitle: { color: colors.textSecondary, fontSize: fontSize.sm },
  meta: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: 2 },
  track: {
    flexDirection: 'row',
    height: 4,
    borderRadius: radius.pill,
    overflow: 'hidden',
    backgroundColor: colors.surfaceHighlight,
    marginTop: spacing.sm,
  },
  fill: { borderRadius: radius.pill },
  button: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceHighlight,
  },
  buttonText: { color: colors.text, fontSize: fontSize.sm, fontWeight: '600' },
}));
