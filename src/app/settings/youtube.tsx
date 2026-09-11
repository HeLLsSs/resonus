/**
 * Settings › YouTube: which YouTube account Navifind is signed in with, and
 * the two things that can be done about it from a phone — sign it in again, or
 * make it forget the account it has.
 *
 * The cookie it is signed in with used to live in a file on the server, and
 * replacing it meant editing the file and rebuilding a container, which is a
 * thing nobody does from a train. The proxy grew routes so it could be handed
 * one instead, and this is the screen that hands it over; the YouTube tab sends
 * people here the moment it finds the session dead, which is the only moment it
 * matters.
 *
 * Four answers, and not one of them reads like another: the account can be
 * read, the session it had has died, there was never an account at all, or the
 * proxy could not be asked. Only the second is somebody's to fix right now,
 * and it says the session died rather than that something is empty.
 *
 * **The session is a credential.** It is the whole `Cookie` header a browser
 * sends to YouTube Music, about seventeen hundred characters of it, and
 * whoever holds it holds the account. So it goes out in the body of a POST and
 * never in an address (see `postToProxy`), it leaves the screen as soon as
 * there is enough of it to be one — what stays is a line saying how long it
 * was — and nothing here ever prints it, not even while something goes wrong.
 * The one that comes out of the sign-in is never held at all: it arrives as an
 * argument and leaves with the request.
 *
 * Two ways in, and the first of them is the road. Google's own page opens in
 * the app (`YoutubeSignIn`) and the session it leaves behind is read out of the
 * cookie jar, because the cookies that matter are HttpOnly and no script in the
 * page can see them. The paste is what is left when that cannot be done: a
 * build without the native side, a sign-in page that refuses to finish, an
 * account already signed in somewhere else.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Redirect } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  forgetYoutubeAccount,
  saveYoutubeCookie,
  switchYoutubeAccount,
  youtubeAccount,
  youtubeAccounts,
} from '@/api/subsonic';
import { SettingRow, SettingsPage, settingsStyles, TextRow } from '@/components/SettingsUI';
import { YoutubeSignIn } from '@/components/YoutubeSignIn';
import { useT } from '@/i18n';
import { clearWebCookies, webCookiesAvailable } from '@/lib/webCookies';
import {
  cleanAuthUser,
  cleanCookie,
  FIRST_ACCOUNT,
  hasSapisid,
  saveFailure,
  type YoutubeSaveFailure,
} from '@/lib/youtube';
import { useAuthStore } from '@/store/auth';
import { useSettings } from '@/store/settings';
import { colors, useTheme } from '@/theme';

/** Twice the length of a working cookie, so a paste that brought a little too
 *  much along is still whole when the cleaning gets to it. */
const COOKIE_MAX = 4000;
/** An account number is one digit in practice; room for the header's name in
 *  front of it, since that is what gets copied with it. */
const AUTH_USER_MAX = 40;
/**
 * How much text in the field means a paste has landed, at which point it is
 * taken off the screen. A cookie is hundreds of characters; anything short of
 * this is a thumb on the keyboard rather than a credential, and hiding that
 * would only leave somebody with no way of seeing what they had typed.
 */
const A_PASTE = 40;

export default function YoutubeSettings() {
  // Repaints on a change of appearance or accent: a stack keeps this screen
  // mounted while you are on another one, out of reach of anything else.
  useTheme();
  const t = useT();
  const queryClient = useQueryClient();
  const auth = useAuthStore((s) => s.auth);
  const offline = useAuthStore((s) => s.offline);
  const navifind = useSettings((s) => s.navifind);
  const [cookie, setCookie] = useState('');
  const [authUser, setAuthUser] = useState('');
  const [busy, setBusy] = useState<'save' | 'forget' | null>(null);
  /** Whether Google's page is up. Mounting is what opens it and unmounting is
   *  what empties the jar behind it, so there is nothing else to keep. */
  const [signingIn, setSigningIn] = useState(false);
  /**
   * What the last thing done here came to, and which of the two ways in it is
   * about — because it is written under the button that was pressed, and a
   * sign-in answered two sections further down would not be read as an answer
   * at all.
   */
  const [result, setResult] = useState<{ from: 'sign-in' | 'paste' | 'switch'; text: string } | null>(null);
  const said = (from: 'sign-in' | 'paste' | 'switch', text: string) => setResult({ from, text });

  const account = useQuery({
    queryKey: ['youtube', 'account'],
    queryFn: () => youtubeAccount(auth!),
    enabled: navifind && !!auth && !offline,
    retry: false,
  });
  // A proxy that did not answer is its own state, told apart from the three it
  // answers with: see `lib/youtube.ts`.
  const state = account.isError ? 'unreachable' : account.data?.state;
  // Asked only once the session is known to work: on a proxy with no account,
  // or one whose session has died, this would be several signed requests for a
  // list that cannot exist. It costs one request per account index tried, so
  // it is not something to ask on every render either.
  const accounts = useQuery({
    queryKey: ['youtube', 'accounts'],
    queryFn: () => youtubeAccounts(auth!),
    enabled: !!auth && !offline && state === 'ok',
    staleTime: 5 * 60_000,
  });

  /**
   * Reads the other account instead. The cookie stays where it is: it opens
   * them all, and only the number Navifind reads with changes.
   */
  const switchTo = async (index: number) => {
    if (busy) return;
    setBusy('save');
    setResult(null);
    try {
      const now = await switchYoutubeAccount(auth!, index);
      said('switch', t('Navifind now reads {name}.', { name: now.name ?? '' }));
      await Promise.all([account.refetch(), accounts.refetch()]);
      // The tab reads the same account under keys of its own.
      await queryClient.invalidateQueries({ queryKey: ['youtube'] });
    } catch {
      said('switch', t('Navifind could not switch account, so nothing changed.'));
    } finally {
      setBusy(null);
    }
  };
  const pasted = cleanCookie(cookie);
  const held = pasted.length >= A_PASTE;

  /** The tab reads the same account under keys of its own, and a cookie that
   *  just changed makes every one of them wrong. */
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['youtube'] });

  const failureText = (why: YoutubeSaveFailure) => {
    if (why === 'refused') {
      return t(
        'YouTube would not accept that cookie, so nothing was changed. It is usually an old one: copy it again from a page you have just loaded.',
      );
    }
    if (why === 'youtube') {
      return t(
        'Navifind could not reach YouTube, so nothing was changed. Nothing is wrong with the cookie; try again in a moment.',
      );
    }
    return t(
      'Navifind did not take the cookie. It may be older than this screen, which needs the routes that let one be pasted.',
    );
  };

  /**
   * Hands a cookie to the proxy and says what came of it. The cookie arrives as
   * an argument and leaves with the request: nothing about it is kept here.
   *
   * The account number goes with where the cookie came from, which is why it is
   * a parameter: a paste carries the number of the browser account it was
   * copied out of, while the sign-in in the app is always the first account of
   * a jar that had none.
   */
  const send = async (
    whole: string,
    account: string,
    from: 'sign-in' | 'paste' | 'switch',
  ): Promise<boolean> => {
    if (!auth) return false;
    setBusy('save');
    setResult(null);
    try {
      const saved = await saveYoutubeCookie(auth, whole, account);
      said(
        from,
        saved.name
          ? t('Signed in as {name}.', { name: saved.name })
          : t('Signed in. Navifind can read the account again.'),
      );
      await refresh();
      return true;
    } catch (e) {
      said(from, failureText(saveFailure(e)));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!auth || busy) return;
    // Said here rather than after a round trip: the proxy refuses a cookie
    // without this pair outright, and its absence means something shorter than
    // the whole header was copied.
    if (!hasSapisid(pasted)) {
      said(
        'paste',
        t(
          'That is not a whole YouTube cookie: the SAPISID it is signed with is not in it. Copy the Cookie line again, all of it.',
        ),
      );
      return;
    }
    if (await send(pasted, cleanAuthUser(authUser), 'paste')) setCookie('');
  };

  /**
   * Opens Google's page on an empty jar. Android keeps one cookie jar per app
   * rather than one per WebView, so emptying it here is what makes this a
   * session of its own: without it, signing in as somebody else would land on
   * whoever was already there and nothing would appear to have happened.
   */
  const signIn = async () => {
    if (busy) return;
    setResult(null);
    await clearWebCookies();
    setSigningIn(true);
  };

  const forget = async () => {
    if (!auth || busy) return;
    setBusy('forget');
    setResult(null);
    try {
      const left = await forgetYoutubeAccount(auth);
      // What it landed on, which is not always nothing: the server may have
      // been started with a cookie of its own, and that one comes back.
      said(
        'paste',
        left.state === 'ok'
          ? t('Forgotten. Navifind went back to the account the server was started with.')
          : left.source === 'none'
            ? t('Forgotten. Navifind has no YouTube account left.')
            : t(
                'Forgotten. What the server was started with is all that is left, and its session has expired too.',
              ),
      );
      await refresh();
    } catch {
      said('paste', t('Navifind did not answer, so nothing was forgotten.'));
    } finally {
      setBusy(null);
    }
  };

  // Nothing to ask about without the proxy switched on: the switch is one
  // screen back, which is where this belongs anyway.
  if (!auth || !navifind) return <Redirect href="/settings/navifind" />;

  return (
    <SettingsPage title="YouTube">
      <ScrollView contentContainerStyle={settingsStyles.content} keyboardShouldPersistTaps="handled">
        <Text style={settingsStyles.sectionDescription}>
          {t(
            'Navifind can be signed in to YouTube Music as you, and then the YouTube tab shows what that account has: its home page, its playlists, the songs it liked.',
          )}
        </Text>

        {offline ? (
          <Text style={settingsStyles.sectionDescription}>{t('Offline: nothing to ask.')}</Text>
        ) : account.isPending ? (
          <SettingRow icon="ellipsis-horizontal-circle-outline" label={t('Asking Navifind…')} />
        ) : state === 'ok' ? (
          <SettingRow
            icon="checkmark-circle-outline"
            label={t('Signed in to YouTube')}
            right={account.data?.name}
            description={
              account.data?.source === 'stored'
                ? t('Using the cookie pasted from a phone.')
                : t('Using the cookie the server was started with.')
            }
          />
        ) : state === 'expired' ? (
          <SettingRow
            icon="time-outline"
            label={t('The session has expired')}
            description={t(
              'YouTube has ended the session Navifind was signed in with. Nothing of yours can be read until a fresh cookie takes its place.',
            )}
          />
        ) : state === 'none' ? (
          <SettingRow
            icon="person-outline"
            label={t('No account yet')}
            description={t(
              'Navifind has no YouTube cookie at all, so the tab shows what YouTube gives a stranger.',
            )}
          />
        ) : (
          <>
            <SettingRow
              icon="cloud-offline-outline"
              label={t('Navifind did not answer')}
              description={t(
                'Navifind could not be asked about its YouTube account. Either it is older than this screen and has not got the routes for it, or the address under Navifind is wrong.',
              )}
            />
            <SettingRow
              icon="refresh-outline"
              label={t('Ask again')}
              onPress={() => void account.refetch()}
            />
          </>
        )}

        {/* The road, where the phone can take it: Google's own page, and a
            session read out of the jar it leaves behind. */}
        {webCookiesAvailable ? (
          <>
            <Text style={settingsStyles.sectionTitle}>{t('Sign in')}</Text>
            <SettingRow
              icon="log-in-outline"
              label={
                state === 'ok' ? t('Sign in as somebody else') : t('Sign in to YouTube Music')
              }
              description={t(
                "Google's own page opens here, signed in to nobody. Whoever signs in on it is who Navifind reads, and the session it leaves behind goes to Navifind by itself. A second account can be signed in beside the first before you finish, and you can then switch between them here.",
              )}
              onPress={busy || offline ? undefined : () => void signIn()}
            />
            {result?.from === 'sign-in' ? (
              <Text style={settingsStyles.sectionDescription}>{result.text}</Text>
            ) : null}
          </>
        ) : null}

        <Text style={settingsStyles.sectionTitle}>{t('Paste a cookie instead')}</Text>
        <Text style={settingsStyles.sectionDescription}>
          {t(
            'The way round when the sign-in page will not finish, or when the account is already signed in to a browser somewhere else.',
          )}
        </Text>
        <Text style={settingsStyles.sectionDescription}>
          {t(
            'Open music.youtube.com in a browser signed in to the account Navifind should use, open the developer tools and reload the page. In the network list pick any request named youtubei, look at the headers it sent, and copy the whole Cookie line — all of it, about seventeen hundred characters.',
          )}
        </Text>
        <Text style={settingsStyles.sectionDescription}>
          {t(
            'If that request also carries an X-Goog-AuthUser header, write its number below: it says which of the accounts signed in to that browser the cookie belongs to.',
          )}
        </Text>

        {held ? (
          // The cookie itself is never drawn again. What it is doing here is
          // not in doubt once it has been pasted, and its length is the one
          // thing worth knowing: a paste that went wrong is far too short.
          <SettingRow
            icon="lock-closed-outline"
            label={t('A cookie is ready to send')}
            description={t('{n} characters, kept out of sight. Clear it to paste another.', {
              n: pasted.length,
            })}
          />
        ) : (
          <View style={[settingsStyles.cardBox, settingsStyles.textRow]}>
            <View style={settingsStyles.rowLabelBox}>
              <Text style={settingsStyles.rowLabel}>{t('Cookie')}</Text>
              <Text style={settingsStyles.rowDescription}>
                {t('The whole header, as the browser sent it.')}
              </Text>
            </View>
            <TextInput
              style={[settingsStyles.textInput, styles.paste]}
              value={cookie}
              onChangeText={setCookie}
              multiline
              placeholder="VISITOR_INFO1_LIVE=…; SAPISID=…"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
              maxLength={COOKIE_MAX}
            />
          </View>
        )}
        <TextRow
          label={t('Account number')}
          description={t('The X-Goog-AuthUser value. Leave it empty for the first account.')}
          value={authUser}
          placeholder="0"
          maxLength={AUTH_USER_MAX}
          onChange={setAuthUser}
        />
        <SettingRow
          icon="cloud-upload-outline"
          label={busy === 'save' ? t('Checking with YouTube…') : t('Send to Navifind')}
          description={t('Navifind tries it against YouTube and only keeps it if it works.')}
          onPress={pasted && !busy && !offline ? () => void save() : undefined}
        />
        {held ? (
          <SettingRow
            icon="close-circle-outline"
            label={t('Clear the paste')}
            onPress={
              busy
                ? undefined
                : () => {
                    setCookie('');
                    setResult(null);
                  }
            }
          />
        ) : null}
        {result?.from === 'paste' ? (
          <Text style={settingsStyles.sectionDescription}>{result.text}</Text>
        ) : null}

        {/* The accounts the stored cookie opens. A Google session carries every
            account the browser was signed in to, numbered, and switching
            between them is a choice rather than a second sign-in.

            Shown even when there is only one, which looks like a list asking to
            be read for nothing and is not: it is the only place that says how
            many accounts the session actually carries. Hidden below two, the
            screen looked identical whether a second sign-in had joined the
            first or quietly replaced it. */}
        {state === 'ok' && accounts.data && accounts.data.length > 0 ? (
          <>
            <Text style={settingsStyles.sectionTitle}>{t('Accounts')}</Text>
            <Text style={settingsStyles.sectionDescription}>
              {accounts.data.length > 1
                ? t('All of these are open with the session Navifind holds. Pick the one it reads.')
                : t(
                    'The session Navifind holds opens this one alone. To add another, sign in again and use "Add another account" before finishing.',
                  )}
            </Text>
            {accounts.data.map((choice) => (
              <SettingRow
                key={choice.index}
                icon={choice.active ? 'radio-button-on-outline' : 'radio-button-off-outline'}
                label={choice.name}
                onPress={busy || choice.active ? undefined : () => void switchTo(choice.index)}
              />
            ))}
            {result?.from === 'switch' ? (
              <Text style={settingsStyles.sectionDescription}>{result.text}</Text>
            ) : null}
          </>
        ) : null}


        {/* Only a pasted cookie is this screen's to drop. What the server was
            started with is the server's, and forgetting it is not on offer. */}
        {account.data?.source === 'stored' ? (
          <SettingRow
            icon="trash-outline"
            label={busy === 'forget' ? t('Forgetting…') : t('Forget this cookie')}
            description={t(
              'Navifind goes back to the value the server was started with, if it has one.',
            )}
            destructive
            onPress={busy || offline ? undefined : () => void forget()}
          />
        ) : null}
      </ScrollView>

      {/* Mounted only while it is open: unmounting is what empties the jar, so
          a sign-in that was abandoned leaves nothing on the phone either. */}
      {signingIn ? (
        <YoutubeSignIn
          onSignedIn={(whole) => {
            setSigningIn(false);
            // The sign-in worked; whether Navifind keeps it is its own answer,
            // and `send` is the one that says so.
            // An added account lands beside the one already there, so what
            // Navifind reads is left alone: the point was to make the other
            // one reachable, not to move to it.
            void send(whole, FIRST_ACCOUNT, 'sign-in');
          }}
          onCancel={() => {
            setSigningIn(false);
            said('sign-in', t('The sign-in was closed before it finished, so nothing was changed.'));
          }}
        />
      ) : null}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  /** Room for several lines at once: what goes in here arrives as a paragraph,
   *  not as a word, and a field one line tall says the wrong thing about it. */
  paste: { minHeight: 112, textAlignVertical: 'top' },
});
