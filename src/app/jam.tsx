/**
 * The Jam screen: open a session or join one by its code, and while in one,
 * the code to give out, the QR code for a browser to scan, who is listening,
 * and the way out. What is playing is not here; that is the player, which
 * in a Jam plays what the session plays (see `store/jam.ts`).
 *
 * Reached from the output sheet and from Settings › Navifind, and by the
 * link `resonuls://jam/<code>`, which joins that session on arrival.
 */
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Share, Text, View } from 'react-native';

import { SettingRow, SettingsPage, settingsStyles, SwitchList, TextRow } from '@/components/SettingsUI';
import { useAccent } from '@/hooks/useAccent';
import { useT } from '@/i18n';
import { authHeaders } from '@/api/subsonic';
import { cleanCode, JamError, jamPageUrl, jamQrUrl, listJams } from '@/lib/jam';
import { navifindActive } from '@/lib/navifind';
import { useAuthStore } from '@/store/auth';
import { endJam, isJamHost, joinJamByCode, leaveJam, setJamListenHere, startJam, useJam } from '@/store/jam';
import { useToast } from '@/store/toast';
import { fontSize, spacing, useTheme } from '@/theme';

/** A code is six characters; room for the dashes and spaces people type. */
const CODE_MAX = 8;
const QR_SIZE = 200;
/** How often the list of sessions under way is asked for while this screen is up. */
const OPEN_EVERY_MS = 10_000;

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
  const [code, setCode] = useState(params.code ? cleanCode(params.code) : '');
  const canJam = navifindActive() && !!auth && !offline;
  const host = isJamHost();

  const said = (e: unknown) => {
    if (e instanceof JamError && e.kind === 'refused') toast(e.message);
    else if (e instanceof JamError && e.kind === 'gone') toast(t('No Jam with that code'));
    else toast(t('Could not reach the Jam'));
  };

  const start = () => startJam().catch(said);
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

            <SwitchList
              options={[
                {
                  label: t('Play on this phone'),
                  description: t('Off, this phone only shows and steers the Jam: for the phone in your hand while the speakers are on the computer that opened it.'),
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
    </SettingsPage>
  );
}
