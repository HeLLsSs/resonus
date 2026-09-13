/**
 * Warns, on startup, that Android's battery optimization is restricting the
 * app — the usual reason playback dies in the background, a download stalls or
 * the sleep timer fires late.
 *
 * Asked once per launch, not once ever: the system re-restricts an app by
 * itself after a while without opening it, so «Later» has to mean later.
 * «Don't remind me» is the one that stops it for good (a switch in Settings ›
 * Playback brings it back).
 *
 * Never on a television, which is plugged into the wall: the warning is about
 * a phone rationing its battery, and the one thing a set nobody can charge
 * does not have is a battery to ration. Android still reports the app as
 * optimized there, so the check has to be made here rather than trusted to
 * come back false.
 *
 * Once per launch is counted here, not per mount. This is only on screen with a
 * profile open, so leaving one and going back in builds it again, and it used
 * to ask again on the way: at that moment the settings still on hand are the
 * ones of the profile that left, or the factory ones, and either way the answer
 * given a minute ago was not among them. Turning the warning off, or answering
 * «Don't remind me», did not survive the round trip.
 */
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { useT } from '@/i18n';
import { isBatteryOptimized, openBatterySettings } from '@/lib/batteryOpt';
import { IS_TV } from '@/lib/tv';
import { useSettings } from '@/store/settings';
import { Dialog } from './Dialog';

/** Whether this launch has already had its answer, whatever it was. */
let asked = false;

export function BatteryWarning() {
  const t = useT();
  const enabled = useSettings((s) => s.batteryWarning);
  const setEnabled = useSettings((s) => s.setBatteryWarning);
  const hydrated = useSettings((s) => s.hydrated);
  const [visible, setVisible] = useState(false);
  // The launch's flag as this mount found it, kept in step below. A ref because
  // that is the one outside state an effect may turn into React state: the
  // effect asks the ref, not the module, and the compiler lets it.
  const askedRef = useRef(asked);

  // Only once the settings are read from disk: before that `batteryWarning` is
  // its default (on), and someone who had turned it off would see it anyway.
  useEffect(() => {
    if (IS_TV || askedRef.current || !hydrated || !enabled || !isBatteryOptimized()) return;
    asked = true;
    askedRef.current = true;
    setVisible(true);
  }, [hydrated, enabled]);

  // Coming back from the system screen: if it was granted there, the dialog
  // has nothing left to say, so it closes itself instead of waiting for an
  // answer that no longer matters.
  useEffect(() => {
    if (!visible) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && !isBatteryOptimized()) setVisible(false);
    });
    return () => sub.remove();
  }, [visible]);

  return (
    <Dialog
      visible={visible}
      title={t('Battery optimization is on')}
      message={t(
        'Android may stop playback in the background, interrupt downloads or delay the sleep timer. Allowing unrestricted battery use fixes it.',
      )}
      confirmLabel={t('Open settings')}
      neutral={{
        label: t("Don't remind me"),
        onPress: () => {
          setEnabled(false);
          setVisible(false);
        },
      }}
      onCancel={() => setVisible(false)}
      onConfirm={() => {
        setVisible(false);
        openBatterySettings();
      }}
    />
  );
}
