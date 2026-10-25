/**
 * Settings › Car mode: which Bluetooth devices are cars, and what car mode
 * does when one connects (see `activateCar` in `src/lib/rideSync.ts`). For a
 * car with nothing but Bluetooth; one with Android Auto has its own screen.
 *
 * The phone's, not the profile's, like ride mode's settings, beside which it
 * is stored (`RideConfig.car`). Android only, and the row that leads here
 * only shows where the module is.
 */
import { useState } from 'react';
import { ScrollView, Text } from 'react-native';

import { Dialog } from '@/components/Dialog';
import { DevicePicker } from '@/components/DevicePicker';
import { SelectList, SettingRow, SettingsPage, settingsStyles, SliderRow, SwitchList } from '@/components/SettingsUI';
import { useT } from '@/i18n';
import {
  canDrawOverlays,
  getNavigationApps,
  PREPARE_COUNTS,
  requestOverlayPermission,
  songsToPrepare,
  type CarConfig,
  type EmptyQueueAction,
} from '@/lib/rideMode';
import { prepareRide, useRidePreparation } from '@/lib/ridePrepare';
import type { Song } from '@/api/subsonic';
import { deactivateCar } from '@/lib/rideSync';
import { useDownloads } from '@/store/downloads';
import { useNetworkType } from '@/store/networkType';
import { usePlayerStore } from '@/store/player';
import { useRideMode } from '@/store/rideMode';
import { useSettings } from '@/store/settings';
import { useToast } from '@/store/toast';

export default function CarSettings() {
  const t = useT();
  const config = useRideMode((s) => s.config);
  const setConfig = useRideMode((s) => s.setConfig);
  const carActive = useRideMode((s) => s.carActive);
  const [navigationApps] = useState(getNavigationApps);
  const car = config.car;
  const setCar = (patch: Partial<CarConfig>) => setConfig({ car: { ...car, ...patch } });
  // The same preparation as the ride screen's button, with the same word
  // asked over mobile data (see `src/app/ride.tsx`).
  const files = useDownloads((s) => s.files);
  const preparing = useRidePreparation((s) => s.preparing);
  const [confirming, setConfirming] = useState<Song[] | null>(null);
  const prepared = preparing ? preparing.filter((id) => files[id]).length : 0;
  const askPrepare = () => {
    if (preparing) return;
    const { queue, index, repeat } = usePlayerStore.getState();
    const songs = songsToPrepare(queue, index, config.prepareCount, repeat === 'all', files);
    if (songs.length === 0) {
      useToast.getState().show(t('The next songs are already downloaded'));
      return;
    }
    if (useNetworkType.getState().cellular && !useSettings.getState().downloadWifiOnly) {
      setConfirming(songs);
      return;
    }
    void prepareRide(songs);
  };

  return (
    <SettingsPage title={t('Car mode')}>
      <ScrollView contentContainerStyle={settingsStyles.content}>
        {/* Car mode has no screen: this, and the notification, are where
            it shows that it is on. */}
        {carActive ? (
          <SettingRow
            icon="stop-circle-outline"
            label={t('Car mode is on')}
            description={t('Stops it until the car connects again.')}
            right={t('Stop')}
            onPress={deactivateCar}
          />
        ) : null}
        <Text style={[settingsStyles.sectionTitle, { marginTop: carActive ? undefined : 0 }]}>{t('Car')}</Text>
        <Text style={settingsStyles.sectionDescription}>
          {t(
            'Car mode starts on its own when one of these Bluetooth devices connects, and stops when it disconnects. Pair the car with the phone first.',
          )}
        </Text>
        <DevicePicker
          chosen={config.cars}
          taken={config.intercoms}
          onChange={(cars) => setConfig({ cars })}
        />

        <Text style={settingsStyles.sectionTitle}>{t('When the car connects')}</Text>
        <SwitchList
          options={[
            {
              label: t('Resume playback'),
              description: t('What was playing starts again when the car connects.'),
              value: car.resume,
              onChange: (resume) => setCar({ resume }),
            },
            {
              label: t('Announce songs'),
              description: t('Each new song is read out over the car speakers.'),
              value: car.announce,
              onChange: (announce) => setCar({ announce }),
            },
            {
              label: t('Status at the start'),
              description: t('The battery, the output and how many songs are left, said when the car connects.'),
              value: car.status,
              onChange: (status) => setCar({ status }),
            },
            {
              label: t('Prepare the drive on its own'),
              description: t('On Wi-Fi only, the next songs are downloaded as the car connects, before the road leaves the network.'),
              value: car.prepareOnConnect,
              onChange: (prepareOnConnect) => setCar({ prepareOnConnect }),
            },
            {
              label: t('Not with Android Auto'),
              description: t(
                'Car mode stays off while Android Auto is on the car screen: it already starts the music and has its own screen.',
              ),
              value: car.notWithAndroidAuto,
              onChange: (notWithAndroidAuto) => setCar({ notWithAndroidAuto }),
            },
          ]}
        />
        {/* Only with the resume on: with nothing starting, there is nothing
            to start instead. */}
        {car.resume ? (
          <SelectList<EmptyQueueAction>
            label={t('With an empty queue')}
            description={t('What starts when there is nothing to resume.')}
            options={[
              { value: 'nothing', label: t('Nothing') },
              { value: 'foryou', label: t('For you') },
              { value: 'favorites', label: t('Favorites, shuffled') },
              { value: 'random', label: t('Shuffle all') },
            ]}
            value={car.emptyQueue}
            onChange={(emptyQueue) => setCar({ emptyQueue })}
          />
        ) : null}
        <SliderRow
          label={t('Volume at the start')}
          description={t('The media volume set when car mode starts, so it is not left where the kitchen had it.')}
          value={Math.round(car.startVolume * 100)}
          max={100}
          step={5}
          formatValue={(v) => (v === 0 ? t('Leave as is') : `${v} %`)}
          onChange={(v) => setCar({ startVolume: v / 100 })}
        />
        {/* Only the navigation apps the phone has, as on the ride mode
            screen. None installed, no row. */}
        {navigationApps.length > 0 ? (
          <SelectList
            label={t('Navigation app')}
            description={t('Brought to the front when the car connects.')}
            options={[
              { value: '', label: t('None') },
              ...navigationApps.map((app) => ({ value: app.package, label: app.name })),
            ]}
            value={navigationApps.some((app) => app.package === car.navigationApp) ? car.navigationApp : ''}
            onChange={(navigationApp) => {
              setCar({ navigationApp });
              // Bringing an app up from behind another one is only allowed
              // to an app that may draw over others: asked here, where it
              // is needed.
              if (navigationApp && !canDrawOverlays()) requestOverlayPermission();
            }}
          />
        ) : null}

        <Text style={settingsStyles.sectionTitle}>{t('Prepare the drive')}</Text>
        <SettingRow
          icon="cloud-download-outline"
          label={preparing ? `${t('Preparing the drive')}  ${prepared} / ${preparing.length}` : t('Prepare the drive')}
          description={t('The next songs of the queue downloaded now, for a road that leaves the network behind.')}
          onPress={askPrepare}
        />
        <SelectList<number>
          label={t('Songs to prepare')}
          description={t('How many songs of the queue are downloaded, by the button and on its own. Shared with ride mode.')}
          options={PREPARE_COUNTS.map((count) => ({ value: count, label: count === 0 ? t('Whole queue') : String(count) }))}
          value={config.prepareCount}
          onChange={(prepareCount) => setConfig({ prepareCount })}
        />
        <Dialog
          visible={confirming !== null}
          title={t('Download on mobile data?')}
          message={t('{n} songs will be downloaded over mobile data.', { n: confirming?.length ?? 0 })}
          confirmLabel={t('Download')}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const songs = confirming;
            setConfirming(null);
            if (songs) void prepareRide(songs);
          }}
        />
      </ScrollView>
    </SettingsPage>
  );
}
