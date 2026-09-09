/**
 * Settings › Navifind: the proxy that fetches music from the web into the
 * library, switched on or off for this profile, and what it can be asked for
 * while it is on.
 *
 * Off by default and off is the whole of it: no badge, no menu entry, no
 * page here beyond the switch (see `lib/navifind.ts`). On, the proxy's own
 * import goes here as well, so a link pasted from a phone ends up as a
 * playlist on the server without the proxy's web page ever being opened.
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Linking, ScrollView, Text } from 'react-native';

import { importIntoLibrary, navifindStatus } from '@/api/subsonic';
import { SettingRow, SettingsPage, settingsStyles, SwitchList, TextRow } from '@/components/SettingsUI';
import { useT } from '@/i18n';
import { askNotificationPermission, NAVIFIND_STATUS_KEY, navifindWorkStarted } from '@/lib/navifindWatch';
import { useAuthStore } from '@/store/auth';
import { useSettings } from '@/store/settings';
import { useToast } from '@/store/toast';
import { useTheme } from '@/theme';

const NAVIFIND_URL = 'https://gitlab.g-hells.fr/gnouet/navifind';
/** A pasted link, with room for the long ones Spotify and YouTube make. */
const URL_MAX = 300;
/**
 * How often the proxy is asked what it is doing while this page is open. Off
 * this page `lib/navifindWatch.ts` keeps asking, less often, until the work
 * it was given is done, and says so.
 */
const STATUS_EVERY_MS = 5_000;

export default function NavifindSettings() {
  // Repaints on a change of appearance or accent: a stack keeps this screen
  // mounted while you are on another one, out of reach of anything else.
  useTheme();
  const t = useT();
  const toast = useToast((s) => s.show);
  const auth = useAuthStore((s) => s.auth);
  const offline = useAuthStore((s) => s.offline);
  const navifind = useSettings((s) => s.navifind);
  const setNavifind = useSettings((s) => s.setNavifind);
  const [url, setUrl] = useState('');
  const [importing, setImporting] = useState(false);

  const canAsk = navifind && !!auth && !offline;
  const status = useQuery({
    queryKey: NAVIFIND_STATUS_KEY,
    queryFn: () => navifindStatus(auth!),
    enabled: canAsk,
    refetchInterval: STATUS_EVERY_MS,
    retry: false,
  });

  const runImport = async () => {
    if (!auth || importing || url.trim() === '') return;
    setImporting(true);
    // The first import is when a notification for its end has a reason, so
    // this is where the permission for one is asked, never at app start.
    void askNotificationPermission();
    try {
      const work = importIntoLibrary(auth, url);
      // Watched from before the proxy answers: a single track can be in the
      // library before the answer arrives, and the count starts from here.
      navifindWorkStarted(work);
      const queued = await work;
      setUrl('');
      toast(
        queued === 0
          ? t('Nothing to fetch at that link')
          : queued === 1
            ? t('Fetching 1 track into the library')
            : t('Fetching {n} tracks into the library', { n: queued }),
      );
    } catch {
      toast(t("The proxy couldn't take that link"));
    } finally {
      setImporting(false);
    }
  };

  return (
    <SettingsPage title="Navifind">
      <ScrollView contentContainerStyle={settingsStyles.content} keyboardShouldPersistTaps="handled">
        <Text style={settingsStyles.sectionDescription}>
          {t(
            'Navifind sits in front of Navidrome and answers searches with tracks it can fetch from YouTube and SoundCloud. Only turn it on if your server address points at it.',
          )}
        </Text>
        <SwitchList
          options={[
            {
              label: t('Use Navifind'),
              description: t('Marks online tracks in searches and lets them be copied into the library.'),
              value: navifind,
              onChange: setNavifind,
            },
          ]}
        />
        <SettingRow
          icon="open-outline"
          label={t('About Navifind')}
          chevron
          onPress={() => void Linking.openURL(NAVIFIND_URL)}
        />

        {navifind ? (
          <>
            <Text style={settingsStyles.sectionTitle}>{t('Import into the library')}</Text>
            <Text style={settingsStyles.sectionDescription}>
              {t(
                'A YouTube, SoundCloud or Spotify link. A playlist or an album becomes a playlist of the same name on the server once its tracks are in.',
              )}
            </Text>
            <TextRow
              label={t('Link')}
              value={url}
              placeholder="https://"
              maxLength={URL_MAX}
              onChange={setUrl}
            />
            <SettingRow
              icon="cloud-download-outline"
              label={importing ? t('Sending…') : t('Import')}
              onPress={url.trim() && !importing && !offline ? () => void runImport() : undefined}
            />

            <Text style={settingsStyles.sectionTitle}>{t('On the proxy')}</Text>
            {offline ? (
              <Text style={settingsStyles.sectionDescription}>{t('Offline: nothing to ask.')}</Text>
            ) : status.isError ? (
              <Text style={settingsStyles.sectionDescription}>
                {t("The server did not answer as Navifind would. Check the address, or turn this off.")}
              </Text>
            ) : (
              <>
                <SettingRow
                  icon="sync-outline"
                  label={t('Fetching now')}
                  right={String(status.data?.inProgress ?? 0)}
                />
                <SettingRow
                  icon="checkmark-done-outline"
                  label={t('In the library')}
                  description={t('Tracks the proxy has fetched so far. Navidrome picks them up on its next scan.')}
                  right={String(status.data?.done.length ?? 0)}
                />
              </>
            )}
          </>
        ) : null}
      </ScrollView>
    </SettingsPage>
  );
}
