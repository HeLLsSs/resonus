/**
 * Root layout: global providers and session control. Routes are protected
 * depending on whether a session is active, using expo-router's Stack.Protected.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';
import { ActivityIndicator, AppState, Platform, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { AppStartupTab } from '@/components/AppStartupTab';
import { ArtistPickerSheet } from '@/components/ArtistPickerSheet';
import { BatteryWarning } from '@/components/BatteryWarning';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { GlobalMiniPlayer } from '@/components/GlobalMiniPlayer';
import { GlobalTabBar } from '@/components/GlobalTabBar';
import { MediaMenuSheet } from '@/components/MediaMenuSheet';
import { GlobalPlaylistPicker } from '@/components/PlaylistPickerSheet';
import { GlobalShareSheet } from '@/components/ShareSheet';
import { SongInfoSheet } from '@/components/SongInfoSheet';
import { SongMenuSheet } from '@/components/SongMenuSheet';
import { Toast } from '@/components/Toast';
import { UpdatePrompt } from '@/components/UpdatePrompt';
import { installAppFont, setAppFont } from '@/lib/appFont';
import { systemAccentAvailable } from '@/lib/materialYou';
import { queryClient } from '@/lib/query';
import { useAuthStore } from '@/store/auth';
import { anyDownloads, useDownloads } from '@/store/downloads';
import { APP_FONT_FAMILY, useSettings } from '@/store/settings';
import { colors, themeMode, useTheme } from '@/theme';

// Patches Text/TextInput once, before the first render.
installAppFont();

/** Queue and lyrics are whole screens. On iOS `modal` is a sheet that stops
 *  short of the top, so there they need the full-screen one. */
const FULL_MODAL = {
  presentation: Platform.OS === 'ios' ? 'fullScreenModal' : 'modal',
  animation: Platform.OS === 'ios' ? 'fade' : 'fade_from_bottom',
} as const;

/*
 * There is no `dangerouslySingular` on any route here, and there is not going
 * to be. It asks the router for one screen per name, and the router delivers by
 * taking the existing route out of the middle of the stack and pushing it again
 * on the end with the same key. react-native-screens does not survive that
 * reorder: the Screen on top comes back with no content in it at all, no
 * `ScreenContentWrapper`, nothing to touch, while JS carries on running.
 *
 * It froze the app twice from two different directions. First on ordinary
 * screens (#148): album → its artist → an album of that artist → its artist
 * again → back → back, and the last frame sits there answering nothing. Taking
 * it off those left it on the three modals, on the argument that the mini
 * player is the only thing that opens the player and is hidden while the player
 * is up, so the player could never be opened from above itself.
 *
 * That was wrong, and it froze the app again. The mini player is hidden while
 * the player is the TOP route, not while it is anywhere in the stack, and the
 * player pushes the artist and the album screens without closing itself. So:
 * player → artist → an album, and the mini player is back with a player still
 * buried underneath; tapping it pushes a route that is already down there, and
 * the reorder happens. Worse than #148, because a transparent modal with
 * nothing in it is invisible: the screen behind shows through, everything looks
 * normal and nothing answers. Kill-the-app frozen.
 *
 * The duplicate screens it was there to prevent are handled by `pushOnce`,
 * which debounces the tap and never touches the stack.
 */

export default function RootLayout() {
  // The selected font is applied on every render (and after hydrating settings):
  // so everything that gets repainted picks up the current family.
  const appFont = useSettings((s) => s.appFont);
  setAppFont(APP_FONT_FAMILY[appFont]);
  // The appearance. Everything mounted beside the Stack below (mini player, tab
  // bar, sheets, toast) repaints from here; the screens inside subscribe on
  // their own, because a stack keeps them mounted and out of this render.
  const palette = useTheme();
  // The window behind everything the app draws. It shows through for an instant
  // between screens and under an overscroll, and left at the launch colour it
  // was a dark flash in the middle of the light theme.
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(palette.background);
  }, [palette.background]);

  const auth = useAuthStore((s) => s.auth);
  const offline = useAuthStore((s) => s.offline);
  const offlineSource = useAuthStore((s) => s.offlineSource);
  const hydrating = useAuthStore((s) => s.hydrating);
  // With downloads, the local profile works without having chosen a music source.
  const hasDownloads = useDownloads(anyDownloads);
  const ready = !!auth || (offline && (!!offlineSource || hasDownloads));
  // The wallpaper is changed outside the app, and Android does not say when.
  // Asking again on the way back to the foreground is enough: one resource
  // read, and from here it happens wherever the app was left, not only on the
  // theme screen.
  const systemAccent = useSettings((s) => s.systemAccent);
  useEffect(() => {
    if (!systemAccentAvailable || !systemAccent) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') useSettings.getState().refreshSystemAccent();
    });
    return () => sub.remove();
  }, [systemAccent]);

  // Keep screen awake (setting). The native flag only acts with the app in
  // the foreground, so it doesn't waste extra battery in the background.
  const keepScreenAwake = useSettings((s) => s.keepScreenAwake);
  useEffect(() => {
    if (!keepScreenAwake) return;
    void activateKeepAwakeAsync('setting');
    return () => {
      void deactivateKeepAwake('setting');
    };
  }, [keepScreenAwake]);

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <QueryClientProvider client={queryClient}>
        {/* The clock and the battery, which are painted by the system over our
            background: dark icons on the light theme, light on the dark one.

            The navigation bar at the other end is not ours to colour. It is
            transparent (styles.xml) and the app draws behind it, but the
            colour of the gesture pill comes from `windowLightNavigationBar`,
            which is a build-time flag — so under the light theme it stays
            white on white. Fixing it means adding `expo-navigation-bar` and a
            new build, which is why it is waiting for one. */}
        <StatusBar style={themeMode() === 'light' ? 'dark' : 'light'} />
        {hydrating ? (
          <View
            style={{
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: colors.background,
            }}
          >
            <ActivityIndicator color={colors.accent} size="large" />
          </View>
        ) : (
          <ErrorBoundary>
          <View style={{ flex: 1 }}>
            <Stack
              screenOptions={{
                headerShown: false,
                // Fast crossfade between screens: on Android native transition
                // durations can't be adjusted and lateral pushes
                // (slide/ios_from_right) felt sluggish.
                animation: 'fade',
                // A screen you have navigated away from stops re-rendering
                // until you come back. It stays mounted either way, which is
                // the point of a stack, but without this every screen still
                // behind you kept answering to every change in every store:
                // the position of the song playing, a download's progress, a
                // favourite. Ten screens deep that is ten renders nobody sees,
                // between the tap and the screen that was asked for, which is
                // why the lag grew the more you browsed.
                freezeOnBlur: true,
                contentStyle: { backgroundColor: colors.background },
              }}
            >
              <Stack.Protected guard={ready}>
                <Stack.Screen name="(tabs)" />
                <Stack.Screen name="album/[id]" />
                <Stack.Screen name="playlist/[id]" />
                <Stack.Screen name="youtube/[id]" />
                <Stack.Screen name="artist/[id]" />
                <Stack.Screen name="artist/discography/[id]" />
                <Stack.Screen name="browse/albums" />
                <Stack.Screen name="browse/artists" />
                <Stack.Screen name="browse/folder/[id]" />
                <Stack.Screen name="genres" />
                <Stack.Screen name="genre/[name]" />
                <Stack.Screen name="composers" />
                <Stack.Screen name="labels" />
                <Stack.Screen name="label/[id]" />
                <Stack.Screen name="radio" />
                <Stack.Screen name="favorites" />
                <Stack.Screen name="favorites-add" />
                <Stack.Screen name="history" />
                <Stack.Screen name="stats" />
                <Stack.Screen name="smart-playlists" />
                <Stack.Screen name="smart-playlist/[id]" />
                <Stack.Screen name="smart-playlist/edit" />
                <Stack.Screen name="bookmarks" />
                <Stack.Screen name="past-queues" />
                <Stack.Screen name="settings/index" />
                <Stack.Screen name="settings/downloads" />
                <Stack.Screen name="settings/download-activity" />
                <Stack.Screen name="settings/navifind" />
                <Stack.Screen name="settings/library" />
                <Stack.Screen name="settings/playback" />
                <Stack.Screen name="settings/player" />
                <Stack.Screen name="settings/language" />
                <Stack.Screen name="settings/font" />
                <Stack.Screen name="settings/personalization" />
                <Stack.Screen name="settings/home-chips" />
                <Stack.Screen name="settings/home-sections" />
                <Stack.Screen name="settings/equalizer" />
                <Stack.Screen name="settings/scrobbling" />
                <Stack.Screen name="settings/home-assistant" />
                <Stack.Screen name="settings/music-assistant" />
                <Stack.Screen name="settings/account" />
                <Stack.Screen name="settings/theme" />
                <Stack.Screen name="settings/about" />
              </Stack.Protected>
              <Stack.Protected guard={offline && !offlineSource && !hasDownloads}>
                <Stack.Screen name="offline" />
              </Stack.Protected>
              <Stack.Protected guard={!auth && !offline}>
                <Stack.Screen name="login" />
              </Stack.Protected>
              {/* Restoring is the one thing somebody may need before there is
                  anything to protect: a phone whose app was reinstalled has no
                  profile, and the file that would give it one is read here.
                  Last, and that matters: with no session every guarded screen
                  above is gone, and the router opens on the first one left. A
                  phone with nothing on it must land on the profile screen, not
                  on the file picker it sends you to. */}
              <Stack.Screen name="settings/backup" />
              {/* Modals shared by server and offline (require active song).
                  Open from the bottom but with the short variant
                  (fade_from_bottom): native slide_from_bottom takes ~350 ms
                  fixed and opening the player felt slow. */}
              {/* containedTransparentModal (not plain modal nor transparentModal)
                  so the screen behind stays composited within the same stack
                  container and shows through while dragging the player down to
                  dismiss (Spotify-style reveal). On Android a plain
                  transparentModal is a separate window and only black shows
                  behind. The custom drag lives in player.tsx and translates the
                  opaque surface over it. */}
              <Stack.Screen
                name="player"
                options={{
                  presentation: 'containedTransparentModal',
                  animation: 'fade_from_bottom',
                  // Override the global opaque contentStyle: without this the
                  // modal container itself is painted with colors.background and
                  // dragging the player only exposes that dark surface, never the
                  // screen behind.
                  contentStyle: { backgroundColor: 'transparent' },
                }}
              />
              <Stack.Screen
                name="queue"
                options={FULL_MODAL}
              />
              <Stack.Screen
                name="lyrics"
                options={FULL_MODAL}
              />
            </Stack>
            {auth || offline ? <AppStartupTab /> : null}
            {auth || offline ? <GlobalMiniPlayer /> : null}
            {auth || offline ? <GlobalTabBar /> : null}
            {auth || offline ? <SongMenuSheet /> : null}
            {auth || offline ? <SongInfoSheet /> : null}
            {auth || offline ? <ArtistPickerSheet /> : null}
            {auth || offline ? <MediaMenuSheet /> : null}
            {auth || offline ? <GlobalPlaylistPicker /> : null}
            {auth || offline ? <GlobalShareSheet /> : null}
            {auth || offline ? <BatteryWarning /> : null}
            {/* Not behind the profile guard on a whim: the check reaches
                GitHub, not the music server, and somebody stuck on the login
                screen because a two-release-old bug is exactly who needs it. */}
            <UpdatePrompt />
            <Toast />
          </View>
          </ErrorBoundary>
        )}
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
