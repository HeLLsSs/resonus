/**
 * The Bluetooth devices paired with the phone as switches, for choosing the
 * ones that start ride mode (Settings › Ride mode) or car mode (Settings ›
 * Car mode) when they connect. Several at once: two helmets, two cars.
 *
 * Knowing which device connected needs a permission from Android 12, asked
 * here the first time the list is opened. A device the other mode has is
 * left out, since one connection cannot start both.
 */
import { useState } from 'react';
import { Text } from 'react-native';

import { SettingRow, settingsStyles, SwitchList } from '@/components/SettingsUI';
import { useT } from '@/i18n';
import {
  getBondedDevices,
  hasBluetoothPermission,
  requestBluetoothPermission,
  type BluetoothDevice,
} from '@/lib/rideMode';

export function DevicePicker({
  chosen,
  taken,
  onChange,
}: {
  chosen: BluetoothDevice[];
  /** The devices of the other mode. */
  taken: BluetoothDevice[];
  /** The new list, and whether a device was added to it. */
  onChange: (devices: BluetoothDevice[], added: boolean) => void;
}) {
  const t = useT();
  const [allowed, setAllowed] = useState(hasBluetoothPermission);
  const [paired, setPaired] = useState<BluetoothDevice[]>(() => (allowed ? getBondedDevices() : []));

  const ask = async () => {
    const granted = await requestBluetoothPermission();
    setAllowed(granted);
    if (granted) setPaired(getBondedDevices());
  };

  if (!allowed) {
    return (
      <SettingRow
        label={t('Allow Bluetooth')}
        description={t('Android needs permission to tell which device connected.')}
        chevron
        onPress={() => void ask()}
      />
    );
  }

  const has = (list: BluetoothDevice[], d: BluetoothDevice) => list.some((c) => c.address === d.address);
  // A chosen device stays in the list even if it is not paired right now:
  // unpaired and paired again it keeps its address, and a choice that
  // vanished from the screen would look like it was never made.
  const devices = [...paired.filter((d) => !has(taken, d)), ...chosen.filter((d) => !has(paired, d))];
  if (devices.length === 0) return <Text style={settingsStyles.rowDescription}>{t('No paired device')}</Text>;

  return (
    <SwitchList
      options={devices.map((device) => ({
        label: device.name || device.address,
        value: has(chosen, device),
        onChange: (on) =>
          onChange(on ? [...chosen, device] : chosen.filter((c) => c.address !== device.address), on),
      }))}
    />
  );
}
