/**
 * Settings › Music Assistant: the address of the house's Music Assistant and
 * an account on it, which is all it takes for its players to show up in the
 * output sheet (see `store/musicAssistant.ts`).
 *
 * The same for every profile, on purpose: the house does not change with the
 * server the app is signed in to. What does change with the profile is which
 * of Music Assistant's music libraries is the server this app is signed in
 * to, so the test says which one it matched — a house can have two, or none,
 * and none means the players are there but no song of this profile's can be
 * played on them.
 *
 * The password is a secret and goes to the phone's secure store, the same
 * place the server password lives; on screen it is a hidden field, with no
 * count of characters over it for anybody looking over a shoulder. The token
 * the sign-in comes back with is kept beside it and is never shown at all.
 *
 * One button does both halves: the address and the account are kept as typed,
 * then tried, and the answer says what was found there, since an address that
 * answers but has no library for this server is the likelier mistake than one
 * that does not answer at all.
 */
import { useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';

import { SettingRow, SettingsPage, settingsStyles, TextRow, SwitchList } from '@/components/SettingsUI';
import { useT } from '@/i18n';
import { MusicAssistantError, normalizeMaUrl } from '@/lib/musicAssistant';
import {
  maCheck,
  maDisconnect,
  setMusicAssistantConfig,
  setMusicAssistantEnabled,
  useMusicAssistant,
} from '@/store/musicAssistant';
import { colors, useTheme } from '@/theme';

/** Room for a domain with a port after it. */
const URL_MAX = 200;
const USERNAME_MAX = 100;
const PASSWORD_MAX = 200;

export default function MusicAssistantSettings() {
  // Repaints on a change of appearance or accent: a stack keeps this screen
  // mounted while you are on another one, out of reach of anything else.
  useTheme();
  const t = useT();
  const enabled = useMusicAssistant((s) => s.enabled);
  const savedUrl = useMusicAssistant((s) => s.url);
  const savedUser = useMusicAssistant((s) => s.username);
  const savedPassword = useMusicAssistant((s) => s.password);
  const [url, setUrl] = useState(savedUrl);
  const [username, setUsername] = useState(savedUser);
  const [password, setPassword] = useState(savedPassword);
  const [busy, setBusy] = useState(false);
  /** What the last check found, under the button, until the next one. */
  const [result, setResult] = useState<string | null>(null);

  const saveAndTest = async () => {
    if (busy) return;
    const moved = normalizeMaUrl(url) !== savedUrl || username.trim() !== savedUser;
    // A session under way is against the address being replaced here, and the
    // speaker can only be told to stop while the app still knows how to reach
    // it: the sound is ended first, and the new address written after.
    if (moved || password !== savedPassword) await maDisconnect();
    setMusicAssistantConfig(url, username, password);
    if (!url.trim() || !username.trim()) return;
    setBusy(true);
    setResult(null);
    try {
      const found = await maCheck();
      const server = found.name
        ? t('Music Assistant {version} on {name}.', { version: found.version, name: found.name })
        : t('Music Assistant {version}.', { version: found.version });
      const players =
        found.players === 1
          ? t('1 player can be reached.')
          : t('{n} players can be reached.', { n: found.players });
      const library = found.library
        ? t('Matched the music library {library}.', { library: found.library })
        : t('No music library here matches this server.');
      setResult(`${server} ${players} ${library}`);
    } catch (e) {
      if (e instanceof MusicAssistantError && e.kind === 'unauthorized') {
        setResult(t('Music Assistant does not accept these credentials.'));
      } else {
        const reason = e instanceof MusicAssistantError && e.kind !== 'network' ? e.message : '';
        setResult(
          reason ? `${t("Couldn't reach Music Assistant")} (${reason})` : t("Couldn't reach Music Assistant"),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const forget = async () => {
    // Same order as above, and for the same reason: forgetting the address
    // first would leave the speaker playing with no way left to reach it.
    await maDisconnect();
    setMusicAssistantConfig('', '', '');
    setUrl('');
    setUsername('');
    setPassword('');
    setResult(null);
  };

  return (
    <SettingsPage title="Music Assistant">
      <ScrollView contentContainerStyle={settingsStyles.content} keyboardShouldPersistTaps="handled">
        <Text style={settingsStyles.sectionDescription}>
          {t(
            'Play on the players Music Assistant knows about. It fetches the music from your server itself, by the library it has already made of it, so nothing is streamed through the phone and the phone can go to sleep while it plays.',
          )}
        </Text>
        <SwitchList
          options={[
            {
              label: t('Use Music Assistant'),
              description: t('Lists its players in the output sheet.'),
              value: enabled,
              onChange: setMusicAssistantEnabled,
            },
          ]}
        />
        {enabled ? (
          <>
            <TextRow
              label={t('Address')}
              value={url}
              placeholder="http://192.168.1.10:8095"
              maxLength={URL_MAX}
              onChange={setUrl}
            />
            <TextRow
              label={t('Username')}
              value={username}
              maxLength={USERNAME_MAX}
              onChange={setUsername}
            />
            <View style={[settingsStyles.cardBox, settingsStyles.textRow]}>
              <View style={settingsStyles.rowLabelBox}>
                <Text style={settingsStyles.rowLabel}>{t('Password')}</Text>
                <Text style={settingsStyles.rowDescription}>
                  {t('Your Music Assistant account. It is kept on the phone and sent only to sign in.')}
                </Text>
              </View>
              <TextInput
                style={settingsStyles.textInput}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={PASSWORD_MAX}
                returnKeyType="done"
                onSubmitEditing={() => void saveAndTest()}
              />
            </View>
            <SettingRow
              icon="checkmark-circle-outline"
              label={busy ? t('Testing…') : t('Save and test')}
              onPress={url.trim() && username.trim() && !busy ? () => void saveAndTest() : undefined}
            />
            {result ? <Text style={settingsStyles.sectionDescription}>{result}</Text> : null}
            {savedUrl || savedUser ? (
              <SettingRow
                icon="trash-outline"
                label={t('Forget Music Assistant')}
                destructive
                onPress={busy ? undefined : () => void forget()}
              />
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </SettingsPage>
  );
}
