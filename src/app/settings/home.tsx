/**
 * Settings › At home: everything about the house's speakers in one place.
 * What happens when you walk in with the music on the phone, which speaker
 * it goes to, and the three ways the app reaches the house's players (Home
 * Assistant, Music Assistant, Kodi), each with its own screen as before.
 *
 * The handoff used to sit at the bottom of Quality & playback, between the
 * die and scrobbling, where nobody looking for "the house" would look; the
 * three integrations were three rows of the main list among a dozen.
 */
import { useRouter } from 'expo-router';
import { Platform, ScrollView, Text } from 'react-native';

import { SelectList, SettingRow, SettingsPage, settingsStyles, SwitchList } from '@/components/SettingsUI';
import { useT } from '@/i18n';
import { normalizeOutputDisplayName } from '@/lib/format';
import { linkPlayAvailable } from '@/lib/linkplay';
import { useLinkPlay } from '@/store/linkplay';
import { useSettings } from '@/store/settings';
import { useTheme } from '@/theme';

export default function HomeSettings() {
  // Repaints on a change of appearance or accent: a stack keeps this screen
  // mounted while you are on another one, out of reach of anything else.
  useTheme();
  const t = useT();
  const router = useRouter();
  const homeHandoff = useSettings((s) => s.homeHandoff);
  const setHomeHandoff = useSettings((s) => s.setHomeHandoff);
  const homeSpeakerHost = useSettings((s) => s.homeSpeakerHost);
  const setHomeSpeakerHost = useSettings((s) => s.setHomeSpeakerHost);
  const lpDevices = useLinkPlay((s) => s.devices);
  const linkPlayList = useSettings((s) => s.linkPlayList);
  const setLinkPlayList = useSettings((s) => s.setLinkPlayList);

  return (
    <SettingsPage title={t('At home')}>
      <ScrollView contentContainerStyle={settingsStyles.content}>
        {/* Only where the phone can reach a speaker: a browser with no proxy
            has nothing to offer. */}
        {linkPlayAvailable() ? (
          <>
            <Text style={[settingsStyles.sectionTitle, { marginTop: 0 }]}>{t('Home speaker')}</Text>
            <SelectList
              label={t('When you get home')}
              description={t(
                'What to do when the music plays on the phone and the home speaker is on the network. Switching on its own, the music also comes back to the phone when you leave the Wi-Fi.',
              )}
              options={[
                { value: 'off', label: t('Do nothing') },
                { value: 'ask', label: t('Ask') },
                { value: 'auto', label: t('Switch on its own') },
              ]}
              value={homeHandoff}
              onChange={setHomeHandoff}
            />
            {/* Which speaker the handoff is about. Greyed out rather than gone
                with the choice above on "Do nothing", so it can still be found
                (#114). A home speaker that is not on the network right now keeps
                its row, under its address, instead of the choice silently reading
                as "last one used". */}
            <SelectList
              label={t('Home speaker')}
              description={t(
                'The speaker the music goes to when you get home. Without one, it is the speaker you last played on.',
              )}
              options={[
                { value: '', label: t('Last one used') },
                ...lpDevices.map((d) => ({ value: d.host, label: normalizeOutputDisplayName(d.name) })),
                ...(homeSpeakerHost && !lpDevices.some((d) => d.host === homeSpeakerHost)
                  ? [{ value: homeSpeakerHost, label: homeSpeakerHost }]
                  : []),
              ]}
              value={homeSpeakerHost}
              onChange={setHomeSpeakerHost}
              disabled={homeHandoff === 'off'}
            />
            <SwitchList
              options={[
                {
                  label: t('Hand a WiiM the next songs'),
                  description: t(
                    'The speaker is given the songs after this one as a list and plays through it on its own, with no silence while the phone tells it the next one. Experimental: switch it off if a speaker stops after a song.',
                  ),
                  value: linkPlayList,
                  onChange: setLinkPlayList,
                },
              ]}
            />
          </>
        ) : null}

        <Text style={[settingsStyles.sectionTitle, !linkPlayAvailable() && { marginTop: 0 }]}>
          {t('Connected to the house')}
        </Text>
        <SettingRow
          icon="home-outline"
          label="Home Assistant"
          description={t("The house's media players in the output sheet.")}
          chevron
          onPress={() => router.push('/settings/home-assistant')}
        />
        <SettingRow
          icon="musical-notes-outline"
          label="Music Assistant"
          description={t('Its players, playing from the server on their own.')}
          chevron
          onPress={() => router.push('/settings/music-assistant')}
        />
        {/* Not in a browser: the page is served over HTTPS and Kodi only
            speaks HTTP, which it refuses. */}
        {Platform.OS !== 'web' ? (
          <SettingRow
            icon="tv-outline"
            label="Kodi"
            description={t('The television, as a speaker of the app.')}
            chevron
            onPress={() => router.push('/settings/kodi')}
          />
        ) : null}
      </ScrollView>
    </SettingsPage>
  );
}
