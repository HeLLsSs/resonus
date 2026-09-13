/**
 * Settings › Equalizer: the switch, a preamp, a preset, one band per row, and
 * then the two boosts that are not equalisation.
 *
 * The filtering happens inside the player (`modules/audio-dsp`), so the ten
 * bands are the same ten everywhere and a gain set here means the same thing on
 * the phone, in the car and on the television. Nothing is chosen but the gains;
 * they are saved and heard at once.
 */
import { useState } from 'react';
import { ScrollView, Text } from 'react-native';

import {
  SelectList,
  SettingRow,
  SettingsPage,
  settingsStyles,
  SliderRow,
  SwitchList,
} from '@/components/SettingsUI';
import { useT } from '@/i18n';
import {
  BASS_BOOST_MAX,
  LOUDNESS_MAX_MB,
  PREAMP_MAX,
  PREAMP_MIN,
  useEqualizer,
} from '@/store/equalizer';
import { useTheme } from '@/theme';

/** 62 → «62 Hz»; 16000 → «16 kHz». */
function formatFreq(hz: number): string {
  return hz >= 1000 ? `${Math.round(hz / 100) / 10} kHz` : `${hz} Hz`;
}

/** Milibelios → «+3.0 dB». */
function formatGain(millibels: number): string {
  const db = millibels / 100;
  return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

export default function EqualizerSettings() {
  // Repaints on a change of appearance or accent: a stack keeps this screen
  // mounted while you are on another one, out of reach of anything else.
  useTheme();
  const t = useT();
  const supported = useEqualizer((s) => s.supported);
  const bands = useEqualizer((s) => s.bands);
  const minLevel = useEqualizer((s) => s.minLevel);
  const maxLevel = useEqualizer((s) => s.maxLevel);
  const presets = useEqualizer((s) => s.presets);
  const enabled = useEqualizer((s) => s.enabled);
  const levels = useEqualizer((s) => s.levels);
  const preamp = useEqualizer((s) => s.preamp);
  const setPreamp = useEqualizer((s) => s.setPreamp);
  const setEnabled = useEqualizer((s) => s.setEnabled);
  const setBandLevel = useEqualizer((s) => s.setBandLevel);
  const applyPreset = useEqualizer((s) => s.applyPreset);
  const reset = useEqualizer((s) => s.reset);
  const bassBoostSupported = useEqualizer((s) => s.bassBoostSupported);
  const loudnessSupported = useEqualizer((s) => s.loudnessSupported);
  const bassBoost = useEqualizer((s) => s.bassBoost);
  const setBassBoost = useEqualizer((s) => s.setBassBoost);
  const loudness = useEqualizer((s) => s.loudness);
  const setLoudness = useEqualizer((s) => s.setLoudness);

  // The selected preset is view-only: touching a band clears the preset
  // («Custom»). What's saved are the gains.
  const [preset, setPreset] = useState(-1);

  if (!supported) {
    return (
      <SettingsPage title={t('Equalizer')}>
        <ScrollView contentContainerStyle={settingsStyles.content}>
          <Text style={settingsStyles.sectionDescription}>
            {t('The equalizer is not available in this build.')}
          </Text>
        </ScrollView>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage title={t('Equalizer')}>
      <ScrollView contentContainerStyle={settingsStyles.content}>
        <SwitchList
          options={[
            {
              label: t('Equalizer'),
              description: t('Apply the equalizer to the app audio.'),
              value: enabled,
              onChange: setEnabled,
            },
          ]}
        />

        {/* Before the bands, because it is what makes room for them. */}
        <SliderRow
          label={t('Preamp')}
          description={t(
            'Where the room for a boost comes from. Raising a band makes the music louder, and a track mastered near the top will clip: pull this down by about as much as the biggest band you raised.',
          )}
          value={preamp}
          min={PREAMP_MIN}
          max={PREAMP_MAX}
          step={100}
          formatValue={formatGain}
          onChange={setPreamp}
        />

        {presets.length > 0 ? (
          <SelectList
            label={t('Preset')}
            options={[
              { value: -1, label: t('Custom') },
              ...presets.map((name, i) => ({ value: i, label: name })),
            ]}
            value={preset}
            onChange={(v) => {
              setPreset(v);
              if (v >= 0) applyPreset(v);
            }}
          />
        ) : null}

        <Text style={settingsStyles.sectionTitle}>{t('Bands')}</Text>
        {bands.map((band) => (
          <SliderRow
            key={band.index}
            label={formatFreq(band.centerFreq)}
            value={levels[band.index] ?? 0}
            min={minLevel}
            max={maxLevel}
            // 1 dB steps: the range comes in millibels.
            step={100}
            formatValue={formatGain}
            onChange={(v) => {
              setPreset(-1);
              setBandLevel(band.index, v);
            }}
          />
        ))}

        <SettingRow
          icon="arrow-undo-outline"
          label={t('Reset bands')}
          onPress={() => {
            setPreset(-1);
            reset();
          }}
        />

        {/* Under a heading of their own: two more sliders straight after the
            bands would read as two more bands. Each only where the device has
            the effect, and neither depends on the equalizer switch above: they
            are effects of their own, on or off by their value alone. */}
        {bassBoostSupported || loudnessSupported ? (
          <Text style={settingsStyles.sectionTitle}>{t('Boost')}</Text>
        ) : null}
        {bassBoostSupported ? (
          <SliderRow
            label={t('Bass boost')}
            value={bassBoost}
            max={BASS_BOOST_MAX}
            step={50}
            formatValue={(v) => (v === 0 ? t('Off') : `${Math.round(v / 10)}%`)}
            onChange={setBassBoost}
          />
        ) : null}
        {loudnessSupported ? (
          <SliderRow
            label={t('Volume boost')}
            description={t('Can distort or clip; the system volume stays the limit')}
            value={loudness}
            max={LOUDNESS_MAX_MB}
            // 1 dB steps: the range is in millibels.
            step={100}
            formatValue={(v) => (v === 0 ? t('Off') : formatGain(v))}
            onChange={setLoudness}
          />
        ) : null}
      </ScrollView>
    </SettingsPage>
  );
}
