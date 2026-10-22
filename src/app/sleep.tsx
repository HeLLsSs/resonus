/**
 * Sleep mode: a black screen for the bedside, with the time in the dim grey
 * of a clock radio, the sleep timer, and the alarm that comes after it.
 *
 * Starting it sets the sleep timer with a long fade: the volume goes down
 * over the last ten minutes (half the time for a short timer) instead of the
 * plain timer's half minute, so the music leaves while you fall asleep
 * rather than stopping on you. The screen goes as dark as the phone allows
 * while this is open (Android, with the ride mode module that sets it) and
 * gives the brightness back on the way out. The phone is still allowed to
 * turn the screen off: this is somewhere to look once, not a night light.
 *
 * The alarm is a line, not a setting: when it rings next, or that it will
 * not, with the way to its screen.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useT } from '@/i18n';
import { alarmAvailable, nextAlarm } from '@/lib/alarm';
import { setScreenBrightness } from '@/lib/rideMode';
import { useAuthStore } from '@/store/auth';
import { usePlayerStore } from '@/store/player';
import { useSettings } from '@/store/settings';
import { fontSize, radius, spacing } from '@/theme';

/** The timers offered, in minutes. */
const SLEEP_MINUTES = [15, 30, 45, 60, 90];

/** The longest the fade to silence takes, in minutes; a short timer fades over half of itself. */
const SLEEP_FADE_MINUTES = 10;

/** How much "a bit longer" adds, in minutes. */
const MORE_MINUTES = 15;

/** The brightness while the screen is open: as low as it goes without being off. */
const NIGHT_BRIGHTNESS = 0.01;

/** Black, and greys a clock radio would use: the screen's own, whatever the theme. */
const NIGHT = { background: '#000000', text: '#5c5c5c', dim: '#3a3a3a', line: '#1c1c1c' };

function sleepFadeMinutes(minutes: number): number {
  return Math.min(SLEEP_FADE_MINUTES, minutes / 2);
}

export default function SleepScreen() {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const lang = useSettings((s) => s.language);
  const alarm = useSettings((s) => s.alarm);
  const auth = useAuthStore((s) => s.auth);
  const sleepEndsAt = usePlayerStore((s) => s.sleepEndsAt);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const setSleepTimer = usePlayerStore((s) => s.setSleepTimer);
  const cancelSleepTimer = usePlayerStore((s) => s.cancelSleepTimer);
  const toggle = usePlayerStore((s) => s.toggle);
  const [now, setNow] = useState(() => Date.now());

  // The clock and the minutes left move on their own; every ten seconds is
  // plenty for a screen that shows minutes.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    setScreenBrightness(NIGHT_BRIGHTNESS);
    return () => setScreenBrightness(-1);
  }, []);

  const time = (at: Date) => at.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
  const start = (minutes: number) => {
    setSleepTimer(minutes, sleepFadeMinutes(minutes));
    if (!isPlaying) toggle();
  };
  const minutesLeft = sleepEndsAt ? Math.max(0, Math.ceil((sleepEndsAt - now) / 60_000)) : 0;
  const next = alarmAvailable && auth ? nextAlarm(alarm, new Date(now)) : null;

  return (
    <View style={[styles.screen, { paddingTop: insets.top + spacing.md, paddingBottom: insets.bottom + spacing.lg }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('Close')}
        hitSlop={12}
        style={styles.close}
        onPress={() => router.back()}
      >
        <Ionicons name="close" size={28} color={NIGHT.text} />
      </Pressable>

      <View style={styles.middle}>
        <Text style={styles.clock}>{time(new Date(now))}</Text>
        {sleepEndsAt ? (
          <>
            <Text style={styles.line}>
              {t('Music stops at {time}', { time: time(new Date(sleepEndsAt)) })}
            </Text>
            <Text style={styles.small}>{t('{n} min left, the volume going down at the end', { n: minutesLeft })}</Text>
          </>
        ) : (
          <Text style={styles.line}>{t('Stop the music in')}</Text>
        )}
      </View>

      {sleepEndsAt ? (
        <View style={styles.row}>
          <Pressable style={styles.chip} onPress={() => start(minutesLeft + MORE_MINUTES)}>
            <Text style={styles.chipText}>{t('+{n} min', { n: MORE_MINUTES })}</Text>
          </Pressable>
          <Pressable style={styles.chip} onPress={cancelSleepTimer}>
            <Text style={styles.chipText}>{t('Turn the timer off')}</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.row}>
          {SLEEP_MINUTES.map((m) => (
            <Pressable key={m} style={styles.chip} onPress={() => start(m)}>
              <Text style={styles.chipText}>{t('{n} min', { n: m })}</Text>
            </Pressable>
          ))}
        </View>
      )}

      {alarmAvailable && auth ? (
        <Pressable style={styles.alarm} onPress={() => router.push('/settings/alarm')}>
          <Ionicons name="alarm-outline" size={18} color={NIGHT.text} />
          <Text style={styles.small}>
            {next
              ? t('Alarm {day} at {time}', {
                  day: next.toLocaleDateString(lang, { weekday: 'long' }),
                  time: time(next),
                })
              : t('No alarm set')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: NIGHT.background, paddingHorizontal: spacing.lg },
  close: { alignSelf: 'flex-start' },
  middle: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  clock: { color: NIGHT.text, fontSize: 72, fontWeight: '200', fontVariant: ['tabular-nums'] },
  line: { color: NIGHT.text, fontSize: fontSize.md, textAlign: 'center' },
  small: { color: NIGHT.dim, fontSize: fontSize.sm, textAlign: 'center' },
  row: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing.sm, marginBottom: spacing.lg },
  chip: {
    borderWidth: 1,
    borderColor: NIGHT.line,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  chipText: { color: NIGHT.text, fontSize: fontSize.sm },
  alarm: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.sm },
});
