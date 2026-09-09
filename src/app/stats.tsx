/**
 * Listening statistics: when you listen and what you listen to.
 *
 * The history says which songs went by; this says what the listening looks
 * like from a distance. A clock of the day (how many listens at each hour), a
 * heat map of the week (which hour of which day), and who came round most
 * often, over a week, a month, a year or for ever. All of it is counted by the
 * database (`lib/statsDb`), and this screen only draws the totals.
 *
 * The charts are plain views. There is no SVG library in the app and two bar
 * charts do not justify one: a bar is a view with a height, and a cell of the
 * heat map is a view with an opacity.
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { COVER, coverArtUrl, songCoverUrl } from '@/api/data';
import { BackChevron } from '@/components/BackChevron';
import { Cover } from '@/components/Cover';
import { EmptyState } from '@/components/EmptyState';
import { useScreenBottomPadding } from '@/hooks/useScreenBottomPadding';
import { useListPadding } from '@/hooks/useScreenSize';
import { useT, type TFunction } from '@/i18n';
import { formatTotalDuration } from '@/lib/format';
import { pushOnce } from '@/lib/pushOnce';
import { queryStats, type ListeningStats } from '@/lib/statsDb';
import { profileScopeId } from '@/store/auth';
import { useSettings } from '@/store/settings';
import { colors, fontSize, radius, spacing, themed, useTheme } from '@/theme';

type Period = 'week' | 'month' | 'year' | 'all';

/** In the order they are offered; the label is a translation key. */
const PERIODS: { key: Period; label: string }[] = [
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'year', label: 'This year' },
  { key: 'all', label: 'All time' },
];

/**
 * When the period began, in local time, or nothing for all of it. The week
 * starts on Monday, which is also how the heat map lays out its rows.
 */
function periodStart(period: Period, now: Date): number | null {
  switch (period) {
    case 'week': {
      const sinceMonday = (now.getDay() + 6) % 7;
      return new Date(now.getFullYear(), now.getMonth(), now.getDate() - sinceMonday).getTime();
    }
    case 'month':
      return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    case 'year':
      return new Date(now.getFullYear(), 0, 1).getTime();
    case 'all':
      return null;
  }
}

/** The hours written under both charts, one per quarter of the day. */
const HOUR_MARKS = [0, 6, 12, 18];

/**
 * Short weekday names in the current language, Monday first. Taken from real
 * dates rather than a table so every language the app ships gets its own
 * without a row here: the 8th of January 2024 was a Monday.
 */
function weekdayLabels(lang: string): string[] {
  return Array.from({ length: 7 }, (_, i) =>
    new Date(2024, 0, 8 + i).toLocaleDateString(lang, { weekday: 'short' }).replace(/\.$/, ''),
  );
}

function playsLabel(n: number, t: TFunction): string {
  return n === 1 ? t('1 play') : t('{n} plays', { n });
}

export default function StatsScreen() {
  // Repaints on a change of appearance or accent: a stack keeps this screen
  // mounted while you are on another one, out of reach of anything else.
  useTheme();
  const t = useT();
  const lang = useSettings((s) => s.language);
  const bottomPad = useScreenBottomPadding();
  // Content stops growing at a reading measure and centres itself (#131).
  const listPad = useListPadding(spacing.lg);
  const [period, setPeriod] = useState<Period>('week');

  // Keyed by profile as well as period, so switching accounts does not show
  // the previous one's charts while the new ones are being counted.
  const { data } = useQuery({
    queryKey: ['listening-stats', profileScopeId(), period],
    queryFn: () => queryStats(periodStart(period, new Date())),
    // Never served from the cache: a listen since the last look is exactly what
    // somebody coming back to this screen wants to see counted.
    staleTime: 0,
  });

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.bar}>
        <BackChevron size={28} />
        <Text style={styles.barTitle}>{t('Listening stats')}</Text>
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: bottomPad, paddingHorizontal: listPad }]}
      >
        <View style={styles.pills}>
          {PERIODS.map((p) => {
            const active = p.key === period;
            return (
              <Pressable
                key={p.key}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                style={({ pressed }) => [
                  styles.pill,
                  active && styles.pillActive,
                  pressed && { opacity: 0.6 },
                ]}
                onPress={() => setPeriod(p.key)}
              >
                <Text style={[styles.pillText, active && styles.pillTextActive]}>{t(p.label)}</Text>
              </Pressable>
            );
          })}
        </View>

        {!data ? null : data.total === 0 ? (
          <EmptyState
            icon="stats-chart-outline"
            title={t('No listens yet')}
            subtitle={
              period === 'all'
                ? t('Songs you listen to will be counted here.')
                : t('Nothing was played in this period.')
            }
          />
        ) : (
          <StatsBody stats={data} lang={lang} t={t} />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function StatsBody({ stats, lang, t }: { stats: ListeningStats; lang: string; t: TFunction }) {
  return (
    <>
      <View style={styles.cards}>
        <View style={styles.card}>
          <Text style={styles.cardValue}>{stats.total}</Text>
          <Text style={styles.cardLabel}>{t('Listens')}</Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.cardValue}>{formatTotalDuration(stats.totalListenedSec)}</Text>
          <Text style={styles.cardLabel}>{t('Time listened')}</Text>
        </View>
      </View>

      <Text style={styles.sectionTitle}>{t('By hour of the day')}</Text>
      <HourClock byHour={stats.byHour} />

      <Text style={styles.sectionTitle}>{t('By day and hour')}</Text>
      <WeekHeatmap byWeekdayHour={stats.byWeekdayHour} lang={lang} />

      {stats.topArtists.length > 0 ? (
        <>
          <Text style={styles.sectionTitle}>{t('Top artists')}</Text>
          {stats.topArtists.map((a, i) => (
            <TopRow
              key={a.id ?? a.name}
              rank={i + 1}
              cover={coverArtUrl(a.id, COVER.thumb)}
              rounded
              title={a.name || t('Unknown artist')}
              plays={playsLabel(a.plays, t)}
              href={a.id ? `/artist/${a.id}` : undefined}
            />
          ))}
        </>
      ) : null}

      {stats.topAlbums.length > 0 ? (
        <>
          <Text style={styles.sectionTitle}>{t('Top albums')}</Text>
          {stats.topAlbums.map((a, i) => (
            <TopRow
              key={a.id ?? a.name}
              rank={i + 1}
              cover={coverArtUrl(a.coverArt ?? a.id, COVER.thumb)}
              title={a.name || t('Unknown album')}
              subtitle={a.artist}
              plays={playsLabel(a.plays, t)}
              href={a.id ? `/album/${a.id}` : undefined}
            />
          ))}
        </>
      ) : null}

      {stats.topSongs.length > 0 ? (
        <>
          <Text style={styles.sectionTitle}>{t('Top songs')}</Text>
          {stats.topSongs.map((s, i) => (
            <TopRow
              key={s.id}
              rank={i + 1}
              cover={songCoverUrl(s, COVER.thumb)}
              title={s.title}
              subtitle={s.artist}
              plays={playsLabel(s.plays, t)}
              // A song has no screen of its own; its album is where it lives.
              href={s.albumId ? `/album/${s.albumId}` : undefined}
            />
          ))}
        </>
      ) : null}
    </>
  );
}

/** Twenty four bars, midnight on the left, each as tall as its share of the
 *  busiest hour. */
function HourClock({ byHour }: { byHour: number[] }) {
  const max = Math.max(1, ...byHour);
  return (
    <View style={styles.chart}>
      <View style={styles.bars}>
        {byHour.map((n, h) => (
          <View key={h} style={styles.barSlot}>
            {/* Two pixels for an hour with something in it, so it reads as a
                listen and not as nothing next to a busier neighbour. */}
            <View
              style={[
                styles.barFill,
                { height: n === 0 ? 0 : Math.max(2, Math.round((n / max) * BAR_HEIGHT)) },
              ]}
            />
          </View>
        ))}
      </View>
      <HourAxis />
    </View>
  );
}

/** Seven rows of twenty four cells, Monday at the top, each cell as strong as
 *  its share of the busiest hour of the week. */
function WeekHeatmap({ byWeekdayHour, lang }: { byWeekdayHour: number[][]; lang: string }) {
  const max = Math.max(1, ...byWeekdayHour.flat());
  const labels = weekdayLabels(lang);
  return (
    <View style={styles.chart}>
      {labels.map((label, row) => {
        // The database counts Sunday as day zero; the rows start on Monday.
        const counts = byWeekdayHour[(row + 1) % 7];
        return (
          <View key={label} style={styles.heatRow}>
            <Text style={styles.heatLabel} numberOfLines={1}>
              {label}
            </Text>
            {counts.map((n, h) => (
              <View
                key={h}
                style={[
                  styles.heatCell,
                  n > 0 && { backgroundColor: colors.accent, opacity: 0.2 + 0.8 * (n / max) },
                ]}
              />
            ))}
          </View>
        );
      })}
      <View style={styles.heatRow}>
        <View style={styles.heatLabel} />
        <View style={styles.axisFill}>
          <HourAxis />
        </View>
      </View>
    </View>
  );
}

/** "0 · 6 · 12 · 18", each over the first cell of its quarter. */
function HourAxis() {
  return (
    <View style={styles.axis}>
      {HOUR_MARKS.map((h) => (
        <Text key={h} style={styles.axisText}>
          {h}
        </Text>
      ))}
    </View>
  );
}

function TopRow({
  rank,
  cover,
  rounded,
  title,
  subtitle,
  plays,
  href,
}: {
  rank: number;
  cover?: string;
  rounded?: boolean;
  title: string;
  subtitle?: string;
  plays: string;
  href?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={!href}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
      onPress={() => href && pushOnce(href)}
    >
      <Text style={styles.rank}>{rank}</Text>
      <Cover uri={cover} size={48} rounded={rounded} />
      <View style={styles.rowInfo}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.rowSub} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <Text style={styles.rowPlays}>{plays}</Text>
    </Pressable>
  );
}

const BAR_HEIGHT = 120;

const styles = themed((colors) => ({
  safe: { flex: 1, backgroundColor: colors.background },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  barTitle: { flex: 1, color: colors.text, fontSize: fontSize.lg, fontWeight: '700' },
  content: { paddingHorizontal: spacing.lg },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  pill: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceHighlight,
  },
  pillActive: { backgroundColor: colors.accent },
  pillText: { color: colors.text, fontSize: fontSize.sm, fontWeight: '600' },
  pillTextActive: { color: colors.onAccent },
  cards: { flexDirection: 'row', gap: spacing.md },
  card: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  cardValue: { color: colors.text, fontSize: fontSize.xl, fontWeight: '700' },
  cardLabel: { color: colors.textSecondary, fontSize: fontSize.sm },
  sectionTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '700',
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
  },
  chart: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: 3,
  },
  bars: { flexDirection: 'row', alignItems: 'flex-end', height: BAR_HEIGHT, gap: 3 },
  barSlot: { flex: 1, height: BAR_HEIGHT, justifyContent: 'flex-end' },
  barFill: { backgroundColor: colors.accent, borderRadius: 2 },
  heatRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  heatLabel: {
    width: 32,
    color: colors.textSecondary,
    fontSize: fontSize.xs,
  },
  heatCell: {
    flex: 1,
    aspectRatio: 1,
    borderRadius: 2,
    backgroundColor: colors.surfaceHighlight,
  },
  axis: { flexDirection: 'row', marginTop: spacing.xs },
  axisFill: { flex: 1 },
  axisText: { flex: 1, color: colors.textMuted, fontSize: fontSize.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  rank: { width: 20, color: colors.textMuted, fontSize: fontSize.sm, fontWeight: '700', textAlign: 'center' },
  rowInfo: { flex: 1 },
  rowTitle: { color: colors.text, fontSize: fontSize.md, fontWeight: '600' },
  rowSub: { color: colors.textSecondary, fontSize: fontSize.xs, marginTop: 2 },
  rowPlays: { color: colors.textSecondary, fontSize: fontSize.sm },
}));
