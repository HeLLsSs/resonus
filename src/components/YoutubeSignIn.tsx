/**
 * Signing in to YouTube Music from inside the app: Google's own page, in a
 * WebView, with the session it leaves behind read out of the cookie jar.
 *
 * The alternative was a desktop browser, its developer tools, a request picked
 * out of the network list and a header copied by hand. What replaces it is a
 * button, and what makes that honest is that nothing about the sign-in is
 * imitated: it is Google's page in a real browser engine, so two-factor,
 * passkeys, account recovery and every other thing that can happen on the way
 * in behave exactly as they do everywhere else. Nothing here reads the form,
 * and no password passes through the app.
 *
 * **What comes out is a credential.** The cookie is handed straight to the
 * caller and kept nowhere: not in state, not in a log line, not on the screen.
 * The jar is emptied on the way out, whether the sign-in finished or not, so
 * the phone is not left holding a session the proxy already has.
 *
 * Mounted only while it is open, so that closing it is also what empties the
 * jar. The caller empties it on the way in, which is what gives the sign-in a
 * session of its own: Android keeps one jar per app rather than one per
 * WebView, and without that an account signed in last week would still be
 * there, which is how "sign out and in again" used to end up where it started.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewNavigation } from 'react-native-webview';

import { useT } from '@/i18n';
import { clearWebCookies, readWebCookie } from '@/lib/webCookies';
import { MUSIC_ORIGIN, SIGN_IN_URL, signedIn } from '@/lib/youtube';
import { colors, fontSize, spacing, themed } from '@/theme';

/**
 * What the WebView says it is.
 *
 * Google refuses to sign anybody in from a browser it believes is embedded in
 * an app, and the `wv` token Android's WebView puts in its own user agent is
 * what it looks for. This is Chrome's, in the frozen form Chrome itself has
 * sent since the user agent stopped saying anything true about the device — so
 * it ages about as well as the real one does, and a version behind changes
 * nothing.
 */
const BROWSER_UA =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36';

export function YoutubeSignIn({
  onSignedIn,
  onCancel,
}: {
  /** The whole `Cookie` header, once there is a session to hand over. Called
   *  once: the sign-in closes itself on the way out of it. */
  onSignedIn: (cookie: string) => void;
  /** Closed with nothing to show for it. */
  onCancel: () => void;
}) {
  const t = useT();
  const insets = useSafeAreaInsets();
  const webview = useRef<WebView>(null);
  /** Whether the sign-in has already been answered. A page sends several
   *  navigation events, and the account is only handed over once. */
  const done = useRef(false);
  /** Whether there is a page behind this one, for the back gesture. */
  const canGoBack = useRef(false);
  const [loading, setLoading] = useState(true);

  useEffect(
    () => () => {
      // The jar now holds a session that is either the proxy's or nobody's,
      // and neither is a reason to leave it on the phone.
      void clearWebCookies();
    },
    [],
  );

  /**
   * Every move the page makes, watched for the one that means it is over: the
   * address is YouTube Music, and the jar carries the pair a signed request is
   * signed with. Both are needed, and `signedIn` says why.
   */
  function onNavigate(state: WebViewNavigation) {
    canGoBack.current = state.canGoBack;
    if (done.current) return;
    const jar = readWebCookie(MUSIC_ORIGIN);
    if (!jar || !signedIn(state.url, jar)) return;
    done.current = true;
    onSignedIn(jar);
  }

  /** Back goes back through the sign-in while there is somewhere to go, and
   *  gives up on it only at the first page. */
  function goBack() {
    if (canGoBack.current) webview.current?.goBack();
    else onCancel();
  }

  return (
    <Modal visible statusBarTranslucent animationType="slide" onRequestClose={goBack}>
      <View style={[styles.page, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Pressable
            style={styles.close}
            accessibilityRole="button"
            accessibilityLabel={t('Close')}
            onPress={onCancel}
          >
            <Ionicons name="close" size={26} color={colors.text} />
          </Pressable>
          <Text style={styles.title} numberOfLines={1}>
            {t('Sign in to YouTube Music')}
          </Text>
          <View style={styles.close} />
        </View>

        <View style={styles.body}>
          <WebView
            ref={webview}
            source={{ uri: SIGN_IN_URL }}
            userAgent={BROWSER_UA}
            // Google's sign-in opens some of its steps in a second window, and
            // a WebView that cannot make one simply drops them. They load here
            // instead, which is the only place there is.
            setSupportMultipleWindows={false}
            onNavigationStateChange={onNavigate}
            onLoadStart={() => setLoading(true)}
            onLoadEnd={() => setLoading(false)}
          />
          {loading ? (
            <View style={styles.spinner} pointerEvents="none">
              <ActivityIndicator color={colors.accent} />
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = themed((colors) => ({
  page: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  // The same width either side of the title, so it sits in the middle of the
  // bar rather than in the middle of what is left of it.
  close: { width: 40, alignItems: 'center' },
  title: {
    flex: 1,
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '600',
    textAlign: 'center',
  },
  body: { flex: 1 },
  // Over the page rather than in place of it: the WebView paints its own
  // background before the page arrives, and a spinner on top of that is less of
  // a jump than a screen that swaps itself out.
  spinner: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
