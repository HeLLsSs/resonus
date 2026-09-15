/**
 * Settings › Navifind: the proxy that fetches music from the web into the
 * library, switched on or off for this profile, and what it can be asked for
 * while it is on.
 *
 * Off by default and off is the whole of it: no badge, no menu entry, no
 * page here beyond the switch (see `lib/navifind.ts`). On, the proxy's own
 * import goes here as well, so a link pasted from a phone ends up as a
 * playlist on the server without the proxy's web page ever being opened, and
 * the YouTube account it reads is one screen further in.
 */
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { openBrowserAsync } from 'expo-web-browser';
import { useState } from 'react';
import { ScrollView, Text } from 'react-native';

import {
  forgetSpotifyAccount,
  type ImportRefusal,
  importIntoLibrary,
  navifindStatus,
  spotifyAccount,
} from '@/api/subsonic';
import { SettingRow, SettingsPage, settingsStyles, SwitchList, TextRow } from '@/components/SettingsUI';
import { useT } from '@/i18n';
import { askNotificationPermission, NAVIFIND_STATUS_KEY, navifindWorkStarted } from '@/lib/navifindWatch';
import { useAuthStore } from '@/store/auth';
import { useSettings } from '@/store/settings';
import { useToast } from '@/store/toast';
import { useTheme } from '@/theme';

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
  const router = useRouter();
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
  // Per profile, because the account is: the proxy keeps one Spotify per
  // Navidrome user. A proxy too old to know the route, or one with no Spotify
  // set up, has nothing to branch, and one with an account of its own needs
  // nobody to: in both cases the section is not drawn at all rather than
  // drawn with a row that cannot act, or need not.
  const spotify = useQuery({
    queryKey: ['navifind', 'spotify', auth?.serverUrl, auth?.username],
    queryFn: () => spotifyAccount(auth!),
    enabled: canAsk,
    retry: false,
  });
  const branched = spotify.data?.connected ?? false;
  const authorizeUrl = spotify.data?.authorizeUrl ?? null;
  const spotifyOffered = branched || (authorizeUrl !== null && !(spotify.data?.shared ?? false));

  /**
   * What the proxy said when a Spotify link gave nothing. Only the first two
   * are somebody's to fix from here, and they say how.
   */
  const refusalSaid = (reason: ImportRefusal): string => {
    switch (reason) {
      case 'needs-account':
        return t('Spotify no longer opens a playlist to an app on its own. Branch your Spotify account on this screen, once.');
      case 'not-yours':
        return t('Spotify only opens the playlists the branched account made itself. Make a copy of it on that account, then import the copy.');
      case 'gone':
        return t("That is gone from Spotify, or it is one of its own playlists — those are closed to apps.");
      case 'empty':
        return t('There are no tracks at that link');
      case 'unreachable':
        return t('Spotify did not answer. Try again.');
      case 'no-token':
        return t("Spotify refused the proxy's own credentials.");
      case 'unsupported':
        return t('That Spotify link was not recognised');
    }
  };

  /**
   * Spotify's own page, in a browser rather than in the app: it only comes
   * back to the one address registered against the proxy, and what comes back
   * is a page for a person to read. Nothing is held here — the proxy keeps
   * what the account gave it. The address is asked for afresh on the way out,
   * because the state it carries expires and this screen may have sat open
   * longer than that; and asked again once the browser closes, since the
   * proxy is what learnt whether the account was branched.
   */
  const connectSpotify = async () => {
    const fresh = (await spotify.refetch()).data?.authorizeUrl ?? authorizeUrl;
    if (!fresh) return;
    await openBrowserAsync(fresh);
    void spotify.refetch();
  };

  const forgetSpotify = async () => {
    if (!auth) return;
    try {
      await forgetSpotifyAccount(auth);
      toast(t('Forgotten. Navifind has no Spotify account left.'));
    } catch {
      toast(t("The proxy couldn't be asked"));
    }
    void spotify.refetch();
  };

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
      const { queued, capped, reason } = await work;
      // A link that only wanted an account stays in the field: branching one
      // and pressing Import again is the whole of the repair.
      if (queued > 0) setUrl('');
      toast(
        queued === 0
          ? reason
            ? refusalSaid(reason)
            : t('Nothing to fetch at that link')
          : capped
            ? t('Only the first 100 tracks came: Spotify shows no more of a playlist to anyone but its maker. If it holds more, make a copy of it on your Spotify account and import that one.')
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
        {navifind ? (
          <>
            {/* A screen of its own because what is behind it is a credential
                and a page of prose about where to find it, neither of which
                belongs between two rows here. */}
            <SettingRow
              icon="logo-youtube"
              label={t('YouTube account')}
              description={t('Which account Navifind reads, and where to sign in to another.')}
              chevron
              onPress={() => router.push('/settings/youtube')}
            />

            {/* Spotify closed playlists to an application holding only its
                own credentials, so an import of one needs the account of
                somebody who can see it. Branched here once, kept by the
                proxy, and never by this app. */}
            {spotifyOffered ? (
              <>
                <Text style={settingsStyles.sectionTitle}>{t('Spotify account')}</Text>
                <Text style={settingsStyles.sectionDescription}>
                  {t(
                    'Spotify only opens a playlist to the account that made it, so importing one needs your account branched here once. It stays on the proxy, for this profile alone.',
                  )}
                </Text>
                <SettingRow
                  icon={branched ? 'checkmark-circle-outline' : 'link-outline'}
                  label={branched ? t('Spotify is branched') : t('Branch Spotify')}
                  description={
                    branched
                      ? t('The playlists you made are yours to import.')
                      : t('Opens Spotify in a browser to ask for its permission.')
                  }
                  onPress={offline || !authorizeUrl ? undefined : () => void connectSpotify()}
                />
                {branched ? (
                  <SettingRow
                    icon="close-circle-outline"
                    label={t('Forget the Spotify account')}
                    destructive
                    onPress={offline ? undefined : () => void forgetSpotify()}
                  />
                ) : null}
              </>
            ) : null}

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
                {/* What the last imports gave. The count on the way in was the
                    source's; this is what arrived, and what was left out
                    because nothing online was recognised as it. */}
                {status.data?.imports.length ? (
                  <>
                    <Text style={settingsStyles.sectionTitle}>{t('Last imports')}</Text>
                    {status.data.imports.slice(0, 5).map((report) => (
                      <SettingRow
                        key={`${report.at}-${report.name}`}
                        icon={report.leftOut.length === 0 ? 'checkmark-circle-outline' : 'alert-circle-outline'}
                        label={report.name || t('Untitled')}
                        description={
                          report.leftOut.length === 0
                            ? t('All {total} tracks found', { total: report.total })
                            : t('{found} of {total} found. Left out: {titles}', {
                                found: report.found,
                                total: report.total,
                                titles: report.leftOut.join(' · '),
                              })
                        }
                      />
                    ))}
                  </>
                ) : null}
              </>
            )}
          </>
        ) : null}
      </ScrollView>
    </SettingsPage>
  );
}
