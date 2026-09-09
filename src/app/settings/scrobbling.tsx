/**
 * Settings › Quality & playback › Scrobbling: when a song counts as played,
 * and where the server sends the listens.
 *
 * Two rules rather than one number: a share of the song, which is what makes a
 * listen mean the same on a two-minute track and on a ten-minute one, and a
 * flat time, which is what keeps the long ones from asking for five minutes
 * before they count. Either can be off, and the earlier one is what fires. What
 * they add up to lives in `scrobbleThresholdSec` (#126).
 *
 * Below them, the accounts. Navidrome scrobbles to ListenBrainz and Last.fm
 * itself, for every client at once, and links the accounts from its own web
 * page, which is a page somebody who only ever opens this app never sees. So
 * the same links are offered here, through the server's own API: nothing is
 * scrobbled from the phone, and a phone that never logs into Navidrome is
 * still scrobbling by tonight.
 *
 * Loves are the exception, and the one thing here the phone does itself: the
 * server has no notion of them, so the app keeps a ListenBrainz token of its
 * own for the hearts (see `lib/listenBrainz.ts`). It is the same token the
 * server is linked with, typed once, in the one field above `LovedTracks`.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Linking, ScrollView, Text } from 'react-native';

import { getAllSongs, getStarred, star } from '@/api/data';
import {
  getLastfmLink,
  getListenBrainzLink,
  linkListenBrainz,
  NavidromeError,
  unlinkLastfm,
  unlinkListenBrainz,
} from '@/api/navidrome';
import { SettingRow, SettingsPage, settingsStyles, SliderRow, TextRow } from '@/components/SettingsUI';
import { songsLabel, useT } from '@/i18n';
import { applyStarChange } from '@/lib/favoritesCache';
import { ListenBrainzError, lovedRecordings, validateToken } from '@/lib/listenBrainz';
import { formatDuration } from '@/lib/format';
import { useAuthStore } from '@/store/auth';
import { SCROBBLE_SECONDS_MAX, useSettings } from '@/store/settings';
import { useToast } from '@/store/toast';
import { useTheme } from '@/theme';

/** Where a ListenBrainz user token is read off. */
const LISTENBRAINZ_SETTINGS_URL = 'https://listenbrainz.org/settings/';
/** A user token is a UUID; room for one pasted with stray spaces. */
const TOKEN_MAX = 48;

export default function ScrobblingSettings() {
  // Repaints on a change of appearance or accent: a stack keeps this screen
  // mounted while you are on another one, out of reach of anything else.
  useTheme();
  const t = useT();
  const scrobblePercent = useSettings((s) => s.scrobblePercent);
  const setScrobblePercent = useSettings((s) => s.setScrobblePercent);
  const scrobbleSeconds = useSettings((s) => s.scrobbleSeconds);
  const setScrobbleSeconds = useSettings((s) => s.setScrobbleSeconds);
  const resetScrobbleRules = useSettings((s) => s.resetScrobbleRules);

  return (
    <SettingsPage title={t('Scrobbling')}>
      <ScrollView contentContainerStyle={settingsStyles.content}>
        <Text style={settingsStyles.sectionDescription}>
          {t('How far into a song it counts as played. Whichever of the two comes first.')}
        </Text>
        <SliderRow
          label={t('Part of the song')}
          value={scrobblePercent}
          max={100}
          step={5}
          formatValue={(v) => (v === 0 ? t('Off') : `${v} %`)}
          fineTune={{ step: 1, doneLabel: t('Done') }}
          onChange={setScrobblePercent}
        />
        {/* Seconds up to a minute, then minutes and seconds: "240 s" is a
            number to work out, and "4:00" is the one people already know. */}
        <SliderRow
          label={t('Time played')}
          value={scrobbleSeconds}
          max={SCROBBLE_SECONDS_MAX}
          step={5}
          formatValue={(v) => (v === 0 ? t('Off') : v < 60 ? `${v} s` : formatDuration(v))}
          fineTune={{ step: 1, doneLabel: t('Done') }}
          onChange={setScrobbleSeconds}
        />
        {/* Both off is a real choice, not a mistake to be corrected, so nothing
            is put back and the line only says what it does. It earns one
            because the play counts on the server stop too, which is further
            than turning off "scrobbling" sounds like it goes. */}
        {scrobblePercent === 0 && scrobbleSeconds === 0 ? (
          <Text style={settingsStyles.sectionDescription}>
            {t('With both off nothing is reported, not even to your own server.')}
          </Text>
        ) : null}
        {/* Always here, whether or not the rules have been touched. It is the
            same row in the same place every time the screen opens, which is
            what makes it findable, and appearing only once something has been
            changed is how a way back goes unnoticed by whoever wanted it. */}
        <SettingRow
          icon="arrow-undo-outline"
          label={t('Restore defaults')}
          onPress={resetScrobbleRules}
        />
        <ScrobbleAccounts />
      </ScrollView>
    </SettingsPage>
  );
}

/**
 * The ListenBrainz and Last.fm rows. Navidrome only, and only with the
 * password its own API wants (kept at login on a Navidrome profile; a profile
 * from before that exists gets a line saying to sign in again rather than a
 * box asking for a password in the middle of a settings screen).
 */
function ScrobbleAccounts() {
  const t = useT();
  const toast = useToast((s) => s.show);
  const queryClient = useQueryClient();
  const auth = useAuthStore((s) => s.auth);
  const offline = useAuthStore((s) => s.offline);
  const navidrome = auth?.serverType === 'navidrome';
  const canAsk = !!auth && navidrome && !offline && !!(auth.ndPassword ?? auth.password);
  // The one place a token is typed. It serves both the server's link and the
  // loves the app sends itself (see `LovedTracks` below), so one paste covers
  // both, and a token already kept for the loves fills it in for the server.
  const lbToken = useSettings((s) => s.listenBrainzToken);
  const setLoves = useSettings((s) => s.setListenBrainzLoves);
  const [token, setToken] = useState(lbToken);
  const [busy, setBusy] = useState(false);

  const listenBrainz = useQuery({
    queryKey: ['scrobble', 'listenbrainz'],
    queryFn: () => getListenBrainzLink(auth!),
    enabled: canAsk,
    retry: false,
  });
  const lastfm = useQuery({
    queryKey: ['scrobble', 'lastfm'],
    queryFn: () => getLastfmLink(auth!),
    enabled: canAsk,
    retry: false,
  });
  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['scrobble'] }),
    [queryClient],
  );

  // Linking Last.fm happens in the browser and ends on the server: the only
  // way to know it went through is to ask again when the person comes back.
  useEffect(() => {
    if (!canAsk) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => sub.remove();
  }, [canAsk, refresh]);

  const failed = (e: unknown, fallback: string) => {
    const reason = e instanceof NavidromeError && e.kind === 'other' ? e.message : '';
    toast(reason ? `${fallback} (${reason})` : fallback);
  };

  const run = async (work: () => Promise<void>, fallback: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
      await refresh();
    } catch (e) {
      failed(e, fallback);
    } finally {
      setBusy(false);
    }
  };

  // What the typed token is for: the server's link when it has none, and
  // otherwise only the loves, which ListenBrainz itself is asked to vouch for.
  // A link made here keeps the token for the loves as well, so one paste is
  // the whole of it; a link made on the server's web page cannot, since the
  // server never hands its token back, and that is the one case of a second
  // paste.
  const needsLink = listenBrainz.isSuccess && !listenBrainz.data.linked;
  // Not before the server has answered, or the field would ask for a link
  // that turns out to exist a moment later.
  const askToken = !listenBrainz.isPending && (needsLink || !lbToken);
  const applyToken = () =>
    run(async () => {
      const pasted = token.trim();
      if (needsLink) {
        const r = await linkListenBrainz(auth!, pasted);
        if (r.user) setLoves(pasted, r.user);
        setToken('');
        toast(r.user ? t('Linked as {name}', { name: r.user }) : t('Linked'));
        return;
      }
      let user: string | null;
      try {
        user = await validateToken(pasted);
      } catch (e) {
        const reason = e instanceof ListenBrainzError ? e.message : '';
        toast(reason ? `${t("Couldn't reach ListenBrainz")} (${reason})` : t("Couldn't reach ListenBrainz"));
        return;
      }
      if (!user) {
        toast(t('ListenBrainz does not know this token.'));
        return;
      }
      setLoves(pasted, user);
      setToken('');
      toast(t('Syncing loves as {name}', { name: user }));
    }, t("Couldn't link ListenBrainz"));

  if (!auth || !navidrome) {
    return (
      <>
        <Text style={settingsStyles.sectionTitle}>{t('Accounts')}</Text>
        <Text style={settingsStyles.sectionDescription}>
          {t('Listens go to your server, which is where ListenBrainz and Last.fm are set up.')}
        </Text>
      </>
    );
  }
  if (!canAsk) {
    return (
      <>
        <Text style={settingsStyles.sectionTitle}>{t('Accounts')}</Text>
        <Text style={settingsStyles.sectionDescription}>
          {offline
            ? t('Linking an account needs the server: come back online first.')
            : t('Sign in to this profile again to link ListenBrainz or Last.fm from here.')}
        </Text>
      </>
    );
  }

  const lb = listenBrainz.data;
  const lf = lastfm.data;
  // A server with the feature switched off answers the status call with an
  // error: nothing to link there, and the rows would only mislead.
  const lbOff = listenBrainz.isError;
  const lfOff = lastfm.isError;

  return (
    <>
      <Text style={settingsStyles.sectionTitle}>{t('ListenBrainz')}</Text>
      {lbOff ? (
        <Text style={settingsStyles.sectionDescription}>{t('Turned off on this server.')}</Text>
      ) : lb?.linked ? (
        <SettingRow
          icon="checkmark-circle-outline"
          label={lb.user ? t('Linked as {name}', { name: lb.user }) : t('Linked')}
          description={t('Every listen counted here is sent by the server.')}
          right={t('Unlink')}
          onPress={() => void run(() => unlinkListenBrainz(auth), t("Couldn't unlink ListenBrainz"))}
        />
      ) : null}
      {askToken ? (
        <>
          {needsLink ? (
            <SettingRow
              icon="open-outline"
              label={t('Get your user token')}
              description={t('Opens your ListenBrainz settings; copy the token shown there.')}
              chevron
              onPress={() => void Linking.openURL(LISTENBRAINZ_SETTINGS_URL)}
            />
          ) : (
            <Text style={settingsStyles.sectionDescription}>
              {t(
                'Loves are sent by the app, not the server, and the server keeps its token to itself: paste the same one here once more.',
              )}
            </Text>
          )}
          <TextRow
            label={t('User token')}
            value={token}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            maxLength={TOKEN_MAX}
            onChange={setToken}
          />
          <SettingRow
            icon={needsLink ? 'link-outline' : 'heart-outline'}
            label={
              busy
                ? needsLink
                  ? t('Linking…')
                  : t('Checking…')
                : needsLink
                  ? t('Link ListenBrainz')
                  : t('Use for loved tracks')
            }
            onPress={token.trim().length > 0 && !busy ? () => void applyToken() : undefined}
          />
        </>
      ) : null}
      <LovedTracks />

      <Text style={settingsStyles.sectionTitle}>{t('Last.fm')}</Text>
      {lfOff ? (
        <Text style={settingsStyles.sectionDescription}>{t('Turned off on this server.')}</Text>
      ) : lf?.linked ? (
        <SettingRow
          icon="checkmark-circle-outline"
          label={t('Linked')}
          description={t('Every listen counted here is sent by the server.')}
          right={t('Unlink')}
          onPress={() => void run(() => unlinkLastfm(auth), t("Couldn't unlink Last.fm"))}
        />
      ) : lf && !lf.authUrl ? (
        <Text style={settingsStyles.sectionDescription}>
          {t('The server has no Last.fm API key; its operator sets one up.')}
        </Text>
      ) : (
        <SettingRow
          icon="open-outline"
          label={t('Link Last.fm')}
          description={t('Last.fm asks you to allow it in the browser, then sends you back to the server.')}
          chevron
          onPress={lf?.authUrl ? () => void Linking.openURL(lf.authUrl!) : undefined}
        />
      )}
    </>
  );
}

/**
 * Loved tracks, under the ListenBrainz rows: the one part of ListenBrainz the
 * server does not carry (see `lib/listenBrainz.ts`), so the app does it with
 * a token of its own. The same token as the server's, pasted a second time,
 * because the server keeps its copy to itself and there is no API to read it
 * back; the line above the box says so when the server is linked, so that
 * a second box asking for the same thing does not look like a mistake.
 *
 * Once the token is checked (`validate-token` says whose it is), the app sends
 * a love for every favourite made here and takes it off for every one removed
 * (`api/data.ts`, `pushLove`), and the button below brings the other direction
 * over once: every loved recording that is in this library becomes a
 * favourite. Once, on a tap, and not on a schedule, because a favourite that
 * appears on its own is a favourite somebody has to work out the origin of.
 */
function LovedTracks() {
  const t = useT();
  const lang = useSettings((s) => s.language);
  const toast = useToast((s) => s.show);
  const lbToken = useSettings((s) => s.listenBrainzToken);
  const lbUser = useSettings((s) => s.listenBrainzUser);
  const setLoves = useSettings((s) => s.setListenBrainzLoves);
  const [busy, setBusy] = useState<'import' | null>(null);

  const failed = (e: unknown, fallback: string) => {
    const reason = e instanceof ListenBrainzError ? e.message : '';
    toast(reason ? `${fallback} (${reason})` : fallback);
  };

  const importLoves = async () => {
    if (busy) return;
    setBusy('import');
    try {
      const loved = new Set(await lovedRecordings(lbToken, lbUser));
      if (loved.size === 0) {
        toast(t('Nothing is loved on ListenBrainz yet.'));
        return;
      }
      // The whole library, matched by recording id: a loved recording that is
      // not in it is simply not here, and there is nothing to say about it.
      const [songs, starred] = await Promise.all([getAllSongs(), getStarred()]);
      const already = new Set(starred.songs.map((s) => s.id));
      let found = 0;
      let added = 0;
      for (const song of songs) {
        if (!song.musicBrainzId || !loved.has(song.musicBrainzId)) continue;
        found++;
        if (already.has(song.id)) continue;
        // Through the data layer like any other favourite, marked as coming
        // from ListenBrainz so the love is not sent straight back to it.
        await star(song.id, 'song', 'listenbrainz');
        applyStarChange('song', song.id, true, song);
        added++;
      }
      if (added > 0) {
        toast(t('{songs} added to favorites', { songs: songsLabel(added, lang) }));
      } else if (found > 0) {
        toast(t('Every loved track in this library is already a favorite.'));
      } else {
        toast(t('None of the loved tracks is in this library.'));
      }
    } catch (e) {
      failed(e, t("Couldn't import loved tracks"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Text style={settingsStyles.sectionTitle}>{t('Loved tracks on ListenBrainz')}</Text>
      {lbToken ? (
        <>
          <SettingRow
            icon="heart-outline"
            label={t('Syncing loves as {name}', { name: lbUser })}
            description={t(
              'A favorite here is a love there, and taking it off takes the love off. Favorites made offline stay here.',
            )}
          />
          <SettingRow
            icon="cloud-download-outline"
            label={busy === 'import' ? t('Importing…') : t('Import loved tracks')}
            description={t('Every track loved on ListenBrainz that is in this library becomes a favorite.')}
            onPress={busy ? undefined : () => void importLoves()}
          />
          <SettingRow
            icon="trash-outline"
            label={t('Forget token')}
            destructive
            onPress={busy ? undefined : () => setLoves('', '')}
          />
        </>
      ) : (
        <Text style={settingsStyles.sectionDescription}>
          {t('Loves are sent by the app, not the server, so they need the token above.')}
        </Text>
      )}
    </>
  );
}
