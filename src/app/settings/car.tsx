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

import { DevicePicker } from '@/components/DevicePicker';
import { SelectList, SettingsPage, settingsStyles, SliderRow, SwitchList } from '@/components/SettingsUI';
import { useT } from '@/i18n';
import { canDrawOverlays, getNavigationApps, requestOverlayPermission, type DriveConfig, type EmptyQueueAction } from '@/lib/rideMode';
import { useRideMode } from '@/store/rideMode';

export default function CarSettings() {
  const t = useT();
  const config = useRideMode((s) => s.config);
  const setConfig = useRideMode((s) => s.setConfig);
  const [navigationApps] = useState(getNavigationApps);
  const car = config.car;
  const setCar = (patch: Partial<DriveConfig>) => setConfig({ car: { ...car, ...patch } });

  return (
    <SettingsPage title={t('Car mode')}>
      <ScrollView contentContainerStyle={settingsStyles.content}>
        <Text style={[settingsStyles.sectionTitle, { marginTop: 0 }]}>{t('Car')}</Text>
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
      </ScrollView>
    </SettingsPage>
  );
}
