/**
 * Settings › Ride mode: which Bluetooth device is the helmet's intercom, and
 * what ride mode does when it connects (see `src/lib/rideSync.ts`).
 *
 * The phone's, not the profile's: the helmet is the same whichever server
 * is signed in, which is why it lives in `store/rideMode.ts` rather than in
 * the settings store. Android only, and the row that leads here only shows
 * where the module is.
 *
 * Two permissions, each asked where it is first needed rather than at
 * start: knowing which device connected (Android 12 and later), asked when
 * the list of paired devices is first opened; and drawing over other apps,
 * asked when the floating player is switched on, which is also what lets
 * the app come up on its own over the navigation app; and the position,
 * asked when the volume with the speed is switched on.
 */
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { SelectList, SettingRow, SettingsPage, settingsStyles, SliderRow, SwitchList } from '@/components/SettingsUI';
import { getRadioStations } from '@/api/subsonic';
import { useT } from '@/i18n';
import {
  canDrawOverlays,
  getBondedDevices,
  getNavigationApps,
  hasBluetoothPermission,
  PREPARE_COUNTS,
  requestBluetoothPermission,
  requestLocationPermission,
  requestOverlayPermission,
  type BluetoothDevice,
  type EmptyQueueAction,
  type OverlaySize,
  type SpeedStrength,
} from '@/lib/rideMode';
import { useAuthStore } from '@/store/auth';
import { useRideMode } from '@/store/rideMode';
import { fontSize, radius, spacing, themed, useTheme } from '@/theme';

export default function RideSettings() {
  // Repaints on a change of appearance or accent: a stack keeps this screen
  // mounted while you are on another one, out of reach of anything else.
  const { accent, onAccent } = useTheme();
  const t = useT();
  const router = useRouter();
  const config = useRideMode((s) => s.config);
  const setConfig = useRideMode((s) => s.setConfig);
  const [allowed, setAllowed] = useState(hasBluetoothPermission);
  const [devices, setDevices] = useState<BluetoothDevice[]>(() => (allowed ? getBondedDevices() : []));
  // Asked again every time the screen is looked at: the answer is given on
  // the system's own screen, which this one has no way of hearing from.
  const [overlayAllowed, setOverlayAllowed] = useState(canDrawOverlays);
  const [navigationApps] = useState(getNavigationApps);
  // The same query the radio screen keeps, so a station added there is here.
  const auth = useAuthStore((s) => s.auth);
  const stations = useQuery({
    queryKey: ['radioStations'],
    queryFn: () => getRadioStations(auth!),
    enabled: !!auth,
  });

  const ask = async () => {
    const granted = await requestBluetoothPermission();
    setAllowed(granted);
    if (granted) setDevices(getBondedDevices());
  };

  const setOverlay = (on: boolean) => {
    setConfig({ overlay: on });
    if (!on) return;
    const can = canDrawOverlays();
    setOverlayAllowed(can);
    if (!can) requestOverlayPermission();
  };

  // Not on without the position: a switch that is on and reads nothing
  // would be a lie told to the rider.
  const setSpeedVolume = async (on: boolean) => {
    if (on && !(await requestLocationPermission())) return;
    setConfig({ speedVolume: on });
  };

  // The chosen intercom stays in the list even if it is not paired right
  // now: unpaired and paired again it keeps its name, and a choice that
  // vanished from the screen would look like it was never made.
  const chosen = config.intercomAddress;
  const options = [
    { value: '', label: t('None') },
    ...devices.map((d) => ({ value: d.address, label: d.name })),
    ...(chosen && !devices.some((d) => d.address === chosen)
      ? [{ value: chosen, label: config.intercomName || chosen }]
      : []),
  ];

  return (
    <SettingsPage title={t('Ride mode')}>
      <ScrollView contentContainerStyle={settingsStyles.content}>
        <Text style={[settingsStyles.sectionTitle, { marginTop: 0 }]}>{t('Intercom')}</Text>
        {allowed ? (
          <SelectList
            label={t('Start when this device connects')}
            description={t(
              'Ride mode starts on its own when the chosen Bluetooth device connects, and stops when it disconnects. Pair the intercom with the phone first.',
            )}
            options={options}
            value={chosen}
            onChange={(address) => {
              const device = devices.find((d) => d.address === address);
              setConfig({ intercomAddress: address, intercomName: device?.name ?? '' });
              // Coming up over the navigation app is only allowed to an app
              // that may draw over others: asked here, where it is needed.
              if (address && !canDrawOverlays()) requestOverlayPermission();
            }}
          />
        ) : (
          <SettingRow
            label={t('Allow Bluetooth')}
            description={t('Android needs permission to tell which device connected.')}
            chevron
            onPress={() => void ask()}
          />
        )}
        {allowed && devices.length === 0 ? (
          <Text style={settingsStyles.rowDescription}>{t('No paired device')}</Text>
        ) : null}

        <Text style={settingsStyles.sectionTitle}>{t('On the road')}</Text>
        <SwitchList
          options={[
            {
              label: t('Floating player'),
              description: overlayAllowed
                ? t('Play, pause and skip over Waze or any other app. Tap the title to come back here.')
                : t(
                    'Play, pause and skip over Waze or any other app. Needs permission to draw over other apps, asked when switched on.',
                  ),
              value: config.overlay,
              onChange: setOverlay,
            },
            {
              label: t('Announce songs'),
              description: t('Each new song is read out in the helmet.'),
              value: config.announce,
              onChange: (announce) => setConfig({ announce }),
            },
            {
              label: t('Status at the start'),
              description: t('The battery, the output and how many songs are left, said when the intercom connects.'),
              value: config.status,
              onChange: (status) => setConfig({ status }),
            },
            {
              label: t('Resume playback'),
              description: t('What was playing starts again when the intercom connects.'),
              value: config.resume,
              onChange: (resume) => setConfig({ resume }),
            },
            {
              label: t('Volume with the speed'),
              description: t(
                'The volume rises over your own level as the bike goes faster, against the wind, from the GPS. Needs the location allowed all the time, since the navigation app is in front.',
              ),
              value: config.speedVolume,
              onChange: (on) => void setSpeedVolume(on),
            },
          ]}
        />
        {/* Only with the volume following the speed: how far, from 30 to
            110 km/h. */}
        {config.speedVolume ? (
          <SelectList<SpeedStrength>
            label={t('Raised by')}
            options={[
              { value: 'light', label: t('Light, one step') },
              { value: 'medium', label: t('Medium, two steps') },
              { value: 'strong', label: t('Strong, three steps') },
            ]}
            value={config.speedStrength}
            onChange={(speedStrength) => setConfig({ speedStrength })}
          />
        ) : null}
        {/* Only with the floating player on: the size of a thing that is
            not there is not a setting. */}
        {config.overlay ? (
          <SelectList<OverlaySize>
            label={t('Floating player size')}
            options={[
              { value: 'normal', label: t('Normal') },
              { value: 'large', label: t('Large, for thick gloves') },
            ]}
            value={config.overlaySize}
            onChange={(overlaySize) => setConfig({ overlaySize })}
          />
        ) : null}
        <SliderRow
          label={t('Volume at the start')}
          description={t('The media volume set when ride mode starts on its own, so it is not left where the kitchen had it.')}
          value={Math.round(config.startVolume * 100)}
          max={100}
          step={5}
          formatValue={(v) => (v === 0 ? t('Leave as is') : `${v} %`)}
          onChange={(v) => setConfig({ startVolume: v / 100 })}
        />
        {/* Only with the resume on: with nothing starting, there is nothing
            to start instead. */}
        {config.resume ? (
          <SelectList<EmptyQueueAction>
            label={t('With an empty queue')}
            description={t('What starts when there is nothing to resume.')}
            options={[
              { value: 'nothing', label: t('Nothing') },
              { value: 'foryou', label: t('For you') },
              { value: 'favorites', label: t('Favorites, shuffled') },
              { value: 'random', label: t('Shuffle all') },
            ]}
            value={config.emptyQueue}
            onChange={(emptyQueue) => setConfig({ emptyQueue })}
          />
        ) : null}
        {/* Only the navigation apps the phone has: a list of names with
            nothing behind them would be a promise. None installed, no row. */}
        {navigationApps.length > 0 ? (
          <SelectList
            label={t('Navigation app')}
            description={t('Brought to the front when the intercom connects, with the floating player over it.')}
            options={[
              { value: '', label: t('None') },
              ...navigationApps.map((app) => ({ value: app.package, label: app.name })),
            ]}
            value={navigationApps.some((app) => app.package === config.navigationApp) ? config.navigationApp : ''}
            onChange={(navigationApp) => setConfig({ navigationApp })}
          />
        ) : null}
        {/* Only with stations to choose from: the button on the ride screen
            is there when a station is, and not otherwise. */}
        {stations.data && stations.data.length > 0 ? (
          <SelectList
            label={t('Radio station')}
            description={t('The station the Radio button of the ride screen plays.')}
            options={[
              { value: '', label: t('None') },
              ...stations.data.map((s) => ({ value: s.id, label: s.name })),
            ]}
            value={stations.data.some((s) => s.id === config.radioStationId) ? config.radioStationId : ''}
            onChange={(radioStationId) =>
              setConfig({
                radioStationId,
                radioStationName: stations.data?.find((s) => s.id === radioStationId)?.name ?? '',
              })
            }
          />
        ) : null}
        <Text style={settingsStyles.sectionTitle}>{t('Prepare the ride')}</Text>
        <Text style={settingsStyles.sectionDescription}>
          {t('How many songs of the queue Prepare the ride downloads before the bike leaves the network.')}
        </Text>
        {/* Chips rather than a list: four short choices, read in one glance. */}
        <View style={styles.chips}>
          {PREPARE_COUNTS.map((count) => {
            const active = count === config.prepareCount;
            return (
              <Pressable
                key={count}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => setConfig({ prepareCount: count })}
                style={({ pressed }) => [
                  styles.chip,
                  active && { backgroundColor: accent },
                  pressed && { opacity: 0.6 },
                ]}
              >
                <Text style={[styles.chipText, active && { color: onAccent }]}>
                  {count === 0 ? t('Whole queue') : String(count)}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <SwitchList
          options={[
            {
              label: t('Prepare on its own'),
              description: t(
                'On the charger and on Wi-Fi, at night or with the screen off for ten minutes, once in twelve hours at most. While the app is running.',
              ),
              value: config.autoPrepare,
              onChange: (autoPrepare) => setConfig({ autoPrepare }),
            },
          ]}
        />
        <SettingRow
          label={t('Open ride mode')}
          description={t('Big buttons for a glove, the screen kept on, and a flick to skip.')}
          chevron
          onPress={() => router.push('/ride')}
        />
      </ScrollView>
    </SettingsPage>
  );
}

const styles = themed((colors) => ({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  chip: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceHighlight,
  },
  chipText: { color: colors.text, fontSize: fontSize.sm, fontWeight: '600' },
}));
