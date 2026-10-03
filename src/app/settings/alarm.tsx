/**
 * Settings › Wake-up alarm: when it rings, what it plays, where, and how
 * slowly the volume rises.
 *
 * Every change goes through `setAlarm`, which also hands the time to the
 * native module, so the ring is in place the moment the screen is left; the
 * rest is read from the settings when it rings (`lib/alarm.ts`).
 */
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { useQuery } from '@tanstack/react-query';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { getPlaylists } from '@/api/data';
import { SelectList, SettingRow, SettingsPage, settingsStyles, SwitchList } from '@/components/SettingsUI';
import { useAccent } from '@/hooks/useAccent';
import { useT } from '@/i18n';
import { ALARM_RAMPS, type AlarmConfig, type AlarmWhat, type AlarmWhere, nextAlarm } from '@/lib/alarm';
import { linkPlayAvailable } from '@/lib/linkplay';
import { useLinkPlay } from '@/store/linkplay';
import { useSettings } from '@/store/settings';
import { colors, fontSize, radius, spacing, themed, useTheme } from '@/theme';

/** The days as `Date.getDay()` counts them, in the order the week is shown: Monday first. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

export default function AlarmSettings() {
  // Repaints on a change of appearance or accent: a stack keeps this screen
  // mounted while you are on another one, out of reach of anything else.
  useTheme();
  const t = useT();
  const accent = useAccent();
  const lang = useSettings((s) => s.language);
  const alarm = useSettings((s) => s.alarm);
  const setAlarm = useSettings((s) => s.setAlarm);
  const homeSpeakerHost = useSettings((s) => s.homeSpeakerHost);
  const speakerName = useLinkPlay((s) => s.devices.find((d) => d.host === homeSpeakerHost)?.name);
  const { data: playlists } = useQuery({
    queryKey: ['playlists'],
    queryFn: () => getPlaylists(),
    enabled: alarm.what === 'playlist',
  });

  const change = (patch: Partial<AlarmConfig>) => setAlarm({ ...alarm, ...patch });
  const timeOf = (hour: number, minute: number) =>
    new Date(2024, 0, 8, hour, minute).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
  const next = nextAlarm(alarm, new Date());
  const canSpeaker = linkPlayAvailable() && homeSpeakerHost !== '';

  function pickTime() {
    DateTimePickerAndroid.open({
      mode: 'time',
      value: new Date(2024, 0, 8, alarm.hour, alarm.minute),
      onChange: (event, date) => {
        if (event.type !== 'set' || !date) return;
        change({ hour: date.getHours(), minute: date.getMinutes() });
      },
    });
  }

  return (
    <SettingsPage title={t('Wake-up alarm')}>
      <ScrollView contentContainerStyle={settingsStyles.content}>
        <SwitchList
          options={[
            {
              label: t('Wake me up'),
              description: t('Plays music at the chosen time, even with the app closed.'),
              value: alarm.enabled,
              onChange: (enabled) => change({ enabled }),
            },
          ]}
        />
        <SettingRow
          label={t('Alarm time')}
          description={
            !alarm.enabled
              ? undefined
              : next
                ? t('Next alarm: {when}', {
                    when: `${next.toLocaleDateString(lang, { weekday: 'long' })} ${timeOf(alarm.hour, alarm.minute)}`,
                  })
                : t('Choose at least one day.')
          }
          right={timeOf(alarm.hour, alarm.minute)}
          chevron
          onPress={pickTime}
        />

        <Text style={settingsStyles.sectionTitle}>{t('Days')}</Text>
        <View style={styles.days}>
          {WEEK.map((day) => {
            const on = alarm.days.includes(day);
            // The 8th of January 2024 was a Monday, so its week names the days
            // in every language without a table here.
            const name = new Date(2024, 0, 7 + day)
              .toLocaleDateString(lang, { weekday: 'short' })
              .replace(/\.$/, '');
            return (
              <Pressable
                key={day}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                style={({ pressed }) => [
                  styles.day,
                  on && { backgroundColor: accent, borderColor: accent },
                  pressed && { opacity: 0.6 },
                ]}
                onPress={() =>
                  change({ days: on ? alarm.days.filter((d) => d !== day) : [...alarm.days, day].sort((a, b) => a - b) })
                }
              >
                <Text style={[styles.dayText, on && { color: colors.onAccent }]}>{name}</Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={settingsStyles.sectionTitle}>{t('Music')}</Text>
        <SelectList<AlarmWhat>
          label={t('What to play')}
          options={[
            { value: 'shuffle', label: t('Shuffle') },
            { value: 'forYou', label: t('For you') },
            { value: 'playlist', label: t('Playlist') },
          ]}
          value={alarm.what}
          onChange={(what) => change({ what })}
        />
        {alarm.what === 'playlist' ? (
          <SelectList
            label={t('Playlist')}
            options={[
              { value: '', label: t('Choose a playlist') },
              ...(playlists ?? []).map((p) => ({ value: p.id, label: p.name })),
            ]}
            value={alarm.playlistId}
            onChange={(playlistId) => change({ playlistId })}
          />
        ) : null}
        <SelectList<AlarmWhere>
          label={t('Where')}
          description={
            canSpeaker
              ? t('If the speaker does not answer, the phone rings instead.')
              : t('Choose your home speaker in Quality & playback to wake up on it.')
          }
          options={[
            { value: 'phone', label: t('This phone') },
            ...(canSpeaker
              ? [{ value: 'speaker' as const, label: speakerName ?? homeSpeakerHost }]
              : []),
          ]}
          value={canSpeaker ? alarm.where : 'phone'}
          onChange={(where) => change({ where })}
        />
        <SelectList
          label={t('Rising volume')}
          description={t('From silence up to the volume the phone or the speaker was left at.')}
          options={ALARM_RAMPS.map((n) => ({ value: n, label: n === 0 ? t('Off') : t('{n} min', { n }) }))}
          value={alarm.rampMinutes}
          onChange={(rampMinutes) => change({ rampMinutes })}
        />
      </ScrollView>
    </SettingsPage>
  );
}

const styles = themed((colors) => ({
  days: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  day: {
    minWidth: 44,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  dayText: { color: colors.text, fontSize: fontSize.sm, fontWeight: '600' },
}));
