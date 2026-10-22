/**
 * Spotify-style Settings: the account at the top as a profile row (avatar +
 * name + server), categories as flat rows, and the mode and sign out pills at
 * the bottom. Restoring every setting is in About: sitting here it looked like
 * one more category and was a tap away from the button that goes offline.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { ScreenHeader, SettingsSafeArea, settingsStyles } from '@/components/SettingsUI';
import { useT } from '@/i18n';
import { useAuthStore } from '@/store/auth';
import { anyDownloads, useDownloads } from '@/store/downloads';
import { alarmAvailable } from '@/lib/alarm';
import { rideModeAvailable } from '@/lib/rideMode';
import { useSettings } from '@/store/settings';
import { useToast } from '@/store/toast';
import { colors, fontSize, radius, spacing, themed, useTheme } from '@/theme';

export default function SettingsScreen() {
  // Repaints on a change of appearance or accent: a stack keeps this screen
  // mounted while you are on another one, out of reach of anything else.
  useTheme();
  const router = useRouter();
  const t = useT();
  const auth = useAuthStore((s) => s.auth);
  // The avatar ring reads the store's accent to recolor when changed.
  const { accent: accentColor } = useTheme();
  useSettings((s) => s.appFont); // re-render when font changes
  const logout = useAuthStore((s) => s.logout);
  const goOnline = useAuthStore((s) => s.goOnline);
  const goOffline = useAuthStore((s) => s.goOffline);
  const offline = useAuthStore((s) => s.offline);
  // Only offer "go offline" manually if there's something downloaded to listen to.
  // Until the catalog has been read, an empty map means "not known yet", not
  // "nothing downloaded". Hiding the switch on that basis is what made it
  // disappear for the first seconds on a large library, which is exactly the
  // library that needs it.
  const hasDownloads = useDownloads((s) => !s.hydrated || anyDownloads(s));
  const toast = useToast((s) => s.show);
  const navifind = useSettings((s) => s.navifind);

  // Server account in offline mode (auth intact) vs local profile (no auth).
  const serverOffline = offline && !!auth;
  const initial = serverOffline
    ? (auth?.username ?? '?').charAt(0).toUpperCase()
    : offline
      ? 'O'
      : (auth?.username ?? '?').charAt(0).toUpperCase();
  const name = offline && !auth ? t('Local profile') : auth?.username ?? '—';
  const detail = serverOffline
    ? t('Offline · your downloads')
    : offline
      ? t('Music on your device')
      : auth?.serverUrl.replace(/^https?:\/\//, '') ?? '';

  // Offline, the categories are the same categories: each screen greys out what
  // needs a server rather than taking it away, so nothing here has to disappear
  // either (#114). "Library" is the exception, since server-offline leaves it
  // with nothing but scanning, and "Local music" is what a local profile gets
  // in its place.
  //
  // In groups under a title, since a single list of nearly twenty rows was
  // read top to bottom every time: what you listen to, where it goes (the
  // house, the road), the server and what is tied to it, and the app itself.
  type Row = {
    key: string;
    title: string;
    icon: keyof typeof Ionicons.glyphMap;
    disabled?: boolean;
    /** Where it leads, when that is not `/settings/<key>`. */
    href?: string;
  };
  const groups: { title: string; rows: Row[] }[] = [
    {
      title: 'Listening',
      rows: [
        { key: 'playback', title: 'Quality & playback', icon: 'musical-notes-outline' },
        { key: 'player', title: 'Player', icon: 'play-circle-outline' },
        // Downloads: in server-offline it reduces to used space and delete (no
        // server means no downloading, but freeing space is still useful). In the
        // local profile (no account) there are NO server downloads, so it's skipped.
        ...(offline && !auth
          ? []
          : [
              {
                key: 'downloads',
                // Named for both halves of what is in there: what gets downloaded,
                // and what the app does when there is no connection. The switch
                // that turns the mode on by itself lived here with no sign of it
                // from the outside (#89).
                title: 'Downloads & offline',
                icon: 'download-outline' as const,
              },
            ]),
        // Library: online is the server's; in local profile, the device's music.
        // Server-offline it is greyed out and says nothing else: what is inside
        // (scanning, choosing libraries) is the server's, and what could be done
        // from here without one is already in "Downloads & offline" above. The row
        // dims like any other disabled control, arrow included, which is a thing
        // people already know how to read.
        {
          key: 'library',
          title: offline && !auth ? 'Local music' : 'Library',
          icon: offline && !auth ? 'phone-portrait-outline' : 'server-outline',
          disabled: serverOffline,
        },
        { key: 'webdav', title: 'Network shares', icon: 'folder-outline' },
        // The alarm rings through its native module, and plays from the server.
        ...(alarmAvailable && auth ? [{ key: 'alarm', title: 'Wake-up alarm', icon: 'alarm-outline' as const }] : []),
      ],
    },
    {
      title: 'Home and on the road',
      rows: [
        // The house's speakers: the handoff when you get home, and Home
        // Assistant, Music Assistant and Kodi behind it. Every profile: the
        // house is the same whichever server is signed in.
        { key: 'home', title: 'At home', icon: 'home-outline' },
        // The motorbike: the intercom, the floating player and the spoken titles
        // are the native module's, so only a phone that has it gets the row.
        ...(rideModeAvailable ? [{ key: 'ride', title: 'Ride mode', icon: 'speedometer-outline' as const }] : []),
        // The car, for one with nothing but Bluetooth: the same module.
        ...(rideModeAvailable ? [{ key: 'car', title: 'Car mode', icon: 'car-outline' as const }] : []),
      ],
    },
    {
      title: 'Server',
      rows: [
        // Network: the addresses of the server and the switching between them. It
        // is the one thing here that must work offline and not merely be visible:
        // an address that is wrong, or a server that moved, is exactly why you
        // ended up offline, and hiding this screen left no way back in short of
        // deleting the profile and signing in again (#113). Checking an address is
        // a ping, which is one of the two requests offline mode lets through. A
        // local profile has no server, so there is nothing for it here.
        ...(auth ? [{ key: 'network', title: 'Network', icon: 'git-network-outline' as const }] : []),
        ...(auth ? [{ key: 'account', title: 'Account', icon: 'person-circle-outline' as const }] : []),
        // Scrobbling is also reachable from Quality & playback, where the thresholds
        // live; the accounts to link are what people come looking for.
        ...(auth ? [{ key: 'scrobbling', title: 'Scrobbling', icon: 'radio-outline' as const }] : []),
        // Only with a server: the proxy sits in front of one. Its own name, not
        // translated, and off by default (see `lib/navifind.ts`).
        ...(auth ? [{ key: 'navifind', title: 'Navifind', icon: 'cloud-download-outline' as const }] : []),
        // YouTube is Navifind's: shown only with it on, where it does something,
        // instead of one level down inside its screen.
        ...(auth && navifind ? [{ key: 'youtube', title: 'YouTube', icon: 'logo-youtube' as const }] : []),
      ],
    },
    {
      title: 'App',
      rows: [
        // Theme lives inside Appearance (row with chevron, like Language).
        { key: 'personalization', title: 'Appearance', icon: 'color-palette-outline' },
        { key: 'backup', title: 'Backup & restore', icon: 'archive-outline' },
        // Not a settings section: a screen of its own, reached from here
        // because this is where somebody looks for what the app knows.
        { key: 'stats', title: 'Listening stats', icon: 'stats-chart-outline', href: '/stats' },
        { key: 'about', title: 'About::app', icon: 'information-circle-outline' },
      ],
    },
  ];

  return (
    <SettingsSafeArea>
      <ScreenHeader title={t('Settings')} />
      {/* The same centred pane every other settings screen gets from
          `SettingsPage`; this one draws its own header, so it says it here. */}
      <View style={settingsStyles.pane}>
      <ScrollView contentContainerStyle={settingsStyles.content}>
        <View style={styles.profileRow}>
          <View style={[styles.avatar, { borderColor: accentColor }]}>
            <Text style={styles.avatarText}>{initial}</Text>
          </View>
          <View style={settingsStyles.rowLabelBox}>
            <Text style={styles.profileName}>{name}</Text>
            <Text style={settingsStyles.rowDescription} numberOfLines={1}>
              {detail}
            </Text>
          </View>
        </View>

        {groups
          .filter((group) => group.rows.length > 0)
          .map((group) => (
            <View key={group.title}>
              <Text style={settingsStyles.sectionTitle}>{t(group.title)}</Text>
              {group.rows.map((s) => (
                <Pressable
                  key={s.key}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !!s.disabled }}
                  disabled={s.disabled}
                  style={({ pressed }) => [
                    styles.sectionRow,
                    s.disabled && { opacity: 0.5 },
                    pressed && !s.disabled && { opacity: 0.6 },
                  ]}
                  onPress={() => router.push(s.href ?? `/settings/${s.key}`)}
                >
                  <Ionicons name={s.icon} size={24} color={colors.text} />
                  <Text style={styles.sectionRowTitle}>{t(s.title)}</Text>
                  <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
                </Pressable>
              ))}
            </View>
          ))}

        <View style={styles.sessionRow}>
          {/* MODE action (outline pill, left): same placement online and offline.
              Online with downloads: go offline manually; server offline: go back
              online. Both reload the library, so they navigate to Home. */}
          {!offline && auth && hasDownloads ? (
            <Pressable
              style={({ pressed }) => [styles.offlinePill, pressed && { opacity: 0.6 }]}
              onPress={() => {
                void goOffline(false);
                toast(t('Offline'));
                router.replace('/(tabs)');
              }}
            >
              <Ionicons name="cloud-offline-outline" size={18} color={colors.onInverse} />
              <Text style={styles.offlinePillText}>{t('Offline mode')}</Text>
            </Pressable>
          ) : serverOffline ? (
            <Pressable
              style={({ pressed }) => [styles.offlinePill, pressed && { opacity: 0.6 }]}
              onPress={() => {
                void goOnline();
                router.replace('/(tabs)');
              }}
            >
              <Ionicons name="cloud-outline" size={18} color={colors.onInverse} />
              <Text style={styles.offlinePillText}>{t('Back online')}</Text>
            </Pressable>
          ) : null}

          {/* Sign out (dark outline pill + icon): same style and position online
              and offline. In local profile it's "Exit local mode". logout()
              doesn't need network, so it works offline. */}
          <Pressable
            style={({ pressed }) => [styles.offlinePill, pressed && { opacity: 0.6 }]}
            onPress={() => logout()}
          >
            <Ionicons name="log-out-outline" size={18} color={colors.onInverse} />
            <Text style={styles.offlinePillText}>
              {offline && !auth ? t('Exit local mode') : t('Sign out')}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
      </View>
    </SettingsSafeArea>
  );
}

const styles = themed((colors) => ({
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  // Same avatar as the Home header (accent ring) for consistency.
  avatar: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceHighlight,
    borderWidth: 2,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.text, fontSize: fontSize.lg, fontWeight: '700' },
  profileName: { color: colors.text, fontSize: fontSize.md, fontWeight: '700' },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md + 2,
  },
  sectionRowTitle: { color: colors.text, fontSize: fontSize.md, fontWeight: '600', flex: 1 },
  // Row with session actions (manual offline + exit), centered.
  sessionRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  // Solid pill for session actions (mode toggle and sign out): the page's own
  // text colour as a fill, so it reads as the loudest thing on the screen in
  // either appearance.
  offlinePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.text,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  offlinePillText: { color: colors.onInverse, fontSize: fontSize.sm, fontWeight: '600' },
}));
