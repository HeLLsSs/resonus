/**
 * The Jam screen: open a session or join one by its code, and while in one,
 * the code to give out, the QR code for a browser to scan, who is listening,
 * and the way out. What is playing is not here; that is the player, which
 * in a Jam plays what the session plays (see `store/jam.ts`).
 *
 * Reached from the output sheet and from Settings › Navifind, and by the
 * link `resonuls://jam/<code>`, which joins that session on arrival.
 *
 * Guest mode is a Jam made for a room: it plays on this phone only, and the
 * QR code fills the screen for whoever comes in to scan, add songs from the
 * browser page and go back to their evening.
 */
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, Share, Text, useWindowDimensions, View } from 'react-native';
import { useKeepAwake } from 'expo-keep-awake';
import Slider from '@react-native-community/slider';
import { Ionicons } from '@expo/vector-icons';

import { SettingRow, SettingsPage, settingsStyles, SwitchList, TextRow } from '@/components/SettingsUI';
import { useAccent } from '@/hooks/useAccent';
import { useT } from '@/i18n';
import { authHeaders, type SubsonicAuth } from '@/api/subsonic';
import { cleanCode, JamError, jamPageUrl, jamQrUrl, listJams } from '@/lib/jam';
import { navifindActive } from '@/lib/navifind';
import { useAuthStore } from '@/store/auth';
import {
  endJam,
  isJamHost,
  jamReportVolume,
  joinJamByCode,
  leaveJam,
  setJamGuestAdds,
  setJamGuestMode,
  setJamListenHere,
  startJam,
  useJam,
} from '@/store/jam';
import { useToast } from '@/store/toast';
import { fontSize, spacing, useTheme } from '@/theme';

/** A code is six characters; room for the dashes and spaces people type. */
const CODE_MAX = 8;
const QR_SIZE = 200;
/** How often the list of sessions under way is asked for while this screen is up. */
const OPEN_EVERY_MS = 10_000;
/** How long the slider keeps the finger's level while the session has not answered with it. */
const LIVE_VOLUME_MAX_MS = 2_000;

export default function JamScreen() {
  const colors = useTheme();
  const accent = useAccent();
  const t = useT();
  const router = useRouter();
  const toast = useToast((s) => s.show);
  const params = useLocalSearchParams<{ code?: string }>();
  const auth = useAuthStore((s) => s.auth);
  const offline = useAuthStore((s) => s.offline);
  const session = useJam((s) => s.session);
  const me = useJam((s) => s.me);
  const busy = useJam((s) => s.busy);
  const listenHere = useJam((s) => s.listenHere);
  // Undefined with a proxy from before the session had a volume: no slider then.
  const sessionVolume = useJam((s) => s.session?.volume);
  // The slider's value from the finger touching it until the session answers
  // with a level near it: handed the session's stale number in between, the
  // thumb hopped back and then forward.
  const [liveVolume, setLiveVolume] = useState<number | null>(null);
  // When the finger first moved it: the hold runs from there, not from the
  // session's last word, or others moving the volume would keep it held.
  const liveSince = useRef(0);
  useEffect(() => {
    if (liveVolume === null) return;
    // Let go once the session is near it, or once a command that never came
    // back has had its chance: the session's own number is then the truth.
    const landed = sessionVolume !== undefined && Math.abs(sessionVolume - liveVolume) < 0.03;
    const left = Math.max(0, liveSince.current + LIVE_VOLUME_MAX_MS - Date.now());
    const timer = setTimeout(() => setLiveVolume(null), landed ? 0 : left);
    return () => clearTimeout(timer);
  }, [liveVolume, sessionVolume]);
  const [code, setCode] = useState(params.code ? cleanCode(params.code) : '');
  const canJam = navifindActive() && !!auth && !offline;
  const host = isJamHost();

  const said = (e: unknown) => {
    if (e instanceof JamError && e.kind === 'refused') toast(e.message);
    else if (e instanceof JamError && e.kind === 'gone') toast(t('No Jam with that code'));
    else toast(t('Could not reach the Jam'));
  };

  const start = () => startJam().catch(said);
  const [guestBoard, setGuestBoard] = useState(false);
  // Played here and nowhere else (the opener plays, the others only add
  // songs, see `store/jam.ts`), and the code up on the screen for the room.
  const startForGuests = () =>
    startJam({ guests: true })
      .then(() => setGuestBoard(true))
      .catch(said);
  const join = () => joinJamByCode(code).catch(said);

  // The sessions under way on the server: the one in the house is a tap away
  // rather than a code to type. Asked again now and then while the screen is
  // up, as somebody may open one after you got here.
  const open = useQuery({
    queryKey: ['jam', 'open', auth?.serverUrl],
    queryFn: () => listJams(auth!),
    enabled: canJam && !session,
    refetchInterval: OPEN_EVERY_MS,
  });
  const openJams = open.data ?? [];

  // The link brought a code: join once, as arriving with it is asking to.
  const joinedFromLink = useRef(false);
  useEffect(() => {
    if (!params.code || joinedFromLink.current || !canJam) return;
    joinedFromLink.current = true;
    joinJamByCode(params.code).catch(said);
    // The toast and the join are what they are on arrival; nothing here
    // should run again because the screen repainted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.code, canJam]);

  const share = () => {
    if (!auth || !session) return;
    void Share.share({ message: jamPageUrl(auth.serverUrl, session.code) }).catch(() => {});
  };

  return (
    <SettingsPage title={t('Jam')}>
      <ScrollView contentContainerStyle={settingsStyles.content} keyboardShouldPersistTaps="handled">
        <Text style={settingsStyles.sectionDescription}>
          {t(
            'Listen together, everyone on their own device, all hearing the same thing at the same moment. Anyone can add songs, skip or pause. A browser can join with the code, no account needed.',
          )}
        </Text>

        {!canJam ? (
          <Text style={settingsStyles.sectionDescription}>
            {offline
              ? t('A Jam needs a connection to the server.')
              : t('A Jam needs the Navifind proxy: turn it on in Settings › Navifind.')}
          </Text>
        ) : session ? (
          <>
            <View style={[settingsStyles.cardBox, { alignItems: 'center', padding: spacing.lg, gap: spacing.md }]}>
              <Text style={{ color: colors.textSecondary, fontSize: fontSize.sm }}>{t('Code')}</Text>
              <Text
                selectable
                style={{ color: accent, fontSize: 36, fontWeight: '800', letterSpacing: 8 }}
              >
                {session.code}
              </Text>
              {auth ? (
                <View style={{ backgroundColor: '#fff', borderRadius: 12, padding: spacing.sm }}>
                  <Image
                    source={{ uri: jamQrUrl(auth.serverUrl, session.code), headers: authHeaders(auth) }}
                    style={{ width: QR_SIZE, height: QR_SIZE }}
                    contentFit="contain"
                    accessibilityLabel={t('QR code to join from a browser')}
                  />
                </View>
              ) : null}
              <Pressable onPress={share} hitSlop={8}>
                <Text style={{ color: accent, fontWeight: '600', fontSize: fontSize.md }}>{t('Share the link')}</Text>
              </Pressable>
            </View>

            {/* The volume of the Jam, wherever it plays: the device that
                opened it follows this, and so do the volume keys of every
                phone in it. In twentieths, so a drag is not a command per
                pixel. */}
            {sessionVolume !== undefined && (host || !session.guestMode) ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.sm }}>
                <Ionicons name="volume-low-outline" size={20} color={colors.textSecondary} />
                <Slider
                  style={{ flex: 1, height: 32 }}
                  accessibilityLabel={t('Jam volume')}
                  minimumValue={0}
                  maximumValue={1}
                  step={0.05}
                  value={liveVolume ?? sessionVolume}
                  onValueChange={(v) => {
                    if (liveVolume === null) liveSince.current = Date.now();
                    setLiveVolume(v);
                    jamReportVolume(v, false);
                  }}
                  onSlidingComplete={(v) => jamReportVolume(v, false)}
                  minimumTrackTintColor={accent}
                  maximumTrackTintColor={colors.control}
                  thumbTintColor={colors.knob}
                />
                <Ionicons name="volume-high-outline" size={20} color={colors.textSecondary} />
              </View>
            ) : null}

            {host ? (
              <SettingRow
                icon="qr-code-outline"
                label={t('Show the code to guests')}
                description={t('The QR code full screen: guests scan it and add songs from their browser.')}
                onPress={() => setGuestBoard(true)}
              />
            ) : null}
            {host && session.guestMode !== undefined ? (
              <SwitchList
                options={[
                  {
                    label: t('Guest mode'),
                    description: t('The others only search and add songs, five a minute each; you keep every control.'),
                    value: session.guestMode,
                    onChange: (on) => void setJamGuestMode(on),
                  },
                  ...(session.guestMode
                    ? [
                        {
                          label: t('Guests can add songs'),
                          value: session.guestAdds !== false,
                          onChange: (on: boolean) => void setJamGuestAdds(on),
                        },
                      ]
                    : []),
                ]}
              />
            ) : null}

            <SwitchList
              options={[
                {
                  label: t('Play on this phone'),
                  description: t('The phone that opened the Jam plays it; the ones that join are silent and steer, volume keys included. On, this phone plays too.'),
                  value: listenHere,
                  onChange: setJamListenHere,
                },
              ]}
            />

            <Text style={settingsStyles.sectionTitle}>
              {session.members.length === 1
                ? t('1 listening')
                : t('{n} listening', { n: session.members.length })}
            </Text>
            {session.members.map((m) => (
              <SettingRow
                key={m.id}
                icon={m.id === me ? 'person' : 'person-outline'}
                label={m.name}
                right={m.id === session.hostId ? t('Host') : undefined}
              />
            ))}

            <Text style={settingsStyles.sectionTitle}>{t('Leave')}</Text>
            <SettingRow
              icon="exit-outline"
              label={t('Leave the Jam')}
              description={t('What is playing keeps playing, on this phone alone.')}
              onPress={() => {
                void leaveJam();
                router.back();
              }}
            />
            {host ? (
              <SettingRow
                icon="stop-circle-outline"
                label={t('End the Jam')}
                description={t('For everybody.')}
                destructive
                onPress={() => {
                  void endJam();
                  router.back();
                }}
              />
            ) : null}
          </>
        ) : (
          <>
            <SettingRow
              icon="radio-outline"
              label={t('Start a Jam')}
              description={t('What is playing here becomes what everybody hears.')}
              onPress={busy ? undefined : () => void start()}
            />
            <SettingRow
              icon="qr-code-outline"
              label={t('Guest mode')}
              description={t('A Jam played on this phone only, its QR code full screen: guests scan it and add songs from their browser, no app or account needed.')}
              onPress={busy ? undefined : () => void startForGuests()}
            />
            {openJams.length > 0 ? (
              <>
                <Text style={settingsStyles.sectionTitle}>{t('Jams under way')}</Text>
                {openJams.map((jam) => (
                  <SettingRow
                    key={jam.code}
                    icon="people-outline"
                    label={t("{name}'s Jam", { name: jam.host })}
                    description={[
                      jam.members === 1 ? t('1 listening') : t('{n} listening', { n: jam.members }),
                      jam.title ? [jam.title, jam.artist].filter(Boolean).join(' · ') : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    right={jam.code}
                    onPress={busy ? undefined : () => void joinJamByCode(jam.code).catch(said)}
                  />
                ))}
              </>
            ) : null}
            <Text style={settingsStyles.sectionTitle}>{t('Join a Jam')}</Text>
            <TextRow
              label={t('Code')}
              value={code}
              placeholder="ABC123"
              maxLength={CODE_MAX}
              onChange={(v) => setCode(cleanCode(v))}
            />
            <SettingRow
              icon="enter-outline"
              label={t('Join')}
              onPress={busy || code.length < 6 ? undefined : () => void join()}
            />
            {busy ? <ActivityIndicator color={accent} style={{ marginTop: spacing.md }} /> : null}
          </>
        )}
      </ScrollView>
      {guestBoard && session && auth ? (
        <GuestBoard code={session.code} auth={auth} onClose={() => setGuestBoard(false)} />
      ) : null}
    </SettingsPage>
  );
}

/** Room around the QR code, so a phone held at an angle still reads it. */
const BOARD_MARGIN = 48;

/**
 * The QR code as big as the screen allows, for a room to scan, with the code
 * and the address under it for whoever would rather type. The screen stays
 * on while it is up: a board that goes dark is no board.
 */
function GuestBoard({ code, auth, onClose }: { code: string; auth: SubsonicAuth; onClose: () => void }) {
  useKeepAwake();
  const colors = useTheme();
  const accent = useAccent();
  const t = useT();
  const { width, height } = useWindowDimensions();
  const size = Math.max(QR_SIZE, Math.min(width, height * 0.6) - BOARD_MARGIN * 2);
  return (
    <Modal visible animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View
        style={{
          flex: 1,
          backgroundColor: colors.background,
          alignItems: 'center',
          justifyContent: 'center',
          gap: spacing.lg,
          padding: spacing.lg,
        }}
      >
        <Text style={{ color: colors.text, fontSize: 28, fontWeight: '800', textAlign: 'center' }}>
          {t('Scan to add songs')}
        </Text>
        <View style={{ backgroundColor: '#fff', borderRadius: 16, padding: spacing.md }}>
          <Image
            source={{ uri: jamQrUrl(auth.serverUrl, code), headers: authHeaders(auth) }}
            style={{ width: size, height: size }}
            contentFit="contain"
            accessibilityLabel={t('QR code to join from a browser')}
          />
        </View>
        <Text style={{ color: accent, fontSize: 36, fontWeight: '800', letterSpacing: 8 }}>{code}</Text>
        <Text selectable style={{ color: colors.textSecondary, fontSize: fontSize.md, textAlign: 'center' }}>
          {jamPageUrl(auth.serverUrl, code)}
        </Text>
        <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button">
          <Text style={{ color: accent, fontWeight: '600', fontSize: fontSize.md }}>{t('Close')}</Text>
        </Pressable>
      </View>
    </Modal>
  );
}
