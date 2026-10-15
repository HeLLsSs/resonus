/**
 * Settings › Kodi: the address of a Kodi on the network and the account of
 * its web server, which is all it takes for it to show up in the output
 * sheet (see `store/kodi.ts`).
 *
 * The same for every profile, like Home Assistant: the TV does not change
 * with the server the app is signed in to. The password goes to the phone's
 * secure store with the rest, and is a hidden field on screen.
 *
 * One button keeps what was typed and asks Kodi what it is, and the answer
 * says whether the Resonuls add-on is there, since without it the TV shows a
 * file name where the title should be.
 */
import { useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';

import { SettingRow, SettingsPage, settingsStyles, SwitchList, TextRow } from '@/components/SettingsUI';
import { useT } from '@/i18n';
import { describeKodi, KodiError, normalizeKodiUrl } from '@/lib/kodi';
import { kodiDisconnect, setKodiConfig, setKodiEnabled, useKodi } from '@/store/kodi';
import { colors, useTheme } from '@/theme';

/** Room for a name and a port. */
const URL_MAX = 200;
const ACCOUNT_MAX = 100;

export default function KodiSettings() {
  // Repaints on a change of appearance or accent: a stack keeps this screen
  // mounted while you are on another one, out of reach of anything else.
  useTheme();
  const t = useT();
  const enabled = useKodi((s) => s.enabled);
  // One selector per value: an object made fresh on each read would be a new
  // state each render, and the screen would never stop drawing.
  const savedUrl = useKodi((s) => s.url);
  const savedUser = useKodi((s) => s.user);
  const savedPassword = useKodi((s) => s.password);
  const saved = { url: savedUrl, user: savedUser, password: savedPassword };
  const [url, setUrl] = useState(saved.url);
  const [user, setUser] = useState(saved.user);
  const [password, setPassword] = useState(saved.password);
  const [busy, setBusy] = useState(false);
  /** What the last check found, under the button, until the next one. */
  const [result, setResult] = useState<string | null>(null);

  const saveAndTest = async () => {
    if (busy) return;
    const next = { url: normalizeKodiUrl(url), user: user.trim(), password };
    // A session under way is against the address being replaced, and Kodi
    // can only be told to stop while the app still knows how to reach it.
    if (next.url !== saved.url || next.user !== saved.user || next.password !== saved.password) await kodiDisconnect();
    setKodiConfig(next.url, next.user, next.password);
    setUrl(next.url);
    if (!next.url) return;
    setBusy(true);
    setResult(null);
    try {
      const info = await describeKodi(next);
      useKodi.setState(info);
      setResult(
        info.addon
          ? t('{name} answers, with the Resonuls add-on: the TV shows what is playing.', { name: info.name })
          : t('{name} answers. Install the Resonuls add-on on it to see the title and cover on the TV.', {
              name: info.name,
            }),
      );
    } catch (e) {
      setResult(
        e instanceof KodiError && e.kind === 'unauthorized'
          ? t('Kodi refused the user or password')
          : t("Couldn't reach Kodi"),
      );
    } finally {
      setBusy(false);
    }
  };

  const forget = async () => {
    // Same order as above: forgetting the address first would leave Kodi
    // playing with no way left to reach it.
    await kodiDisconnect();
    setKodiConfig('', '', '');
    useKodi.setState({ name: '', addon: false });
    setUrl('');
    setUser('');
    setPassword('');
    setResult(null);
  };

  return (
    <SettingsPage title="Kodi">
      <ScrollView contentContainerStyle={settingsStyles.content} keyboardShouldPersistTaps="handled">
        <Text style={settingsStyles.sectionDescription}>
          {t(
            'Play on the TV through Kodi. In Kodi, turn on Settings › Services › Control › Allow remote control via HTTP, and give it a user and a password.',
          )}
        </Text>
        <SwitchList
          options={[
            {
              label: t('Use Kodi'),
              description: t('Lists it in the output sheet.'),
              value: enabled,
              onChange: setKodiEnabled,
            },
          ]}
        />
        {enabled ? (
          <>
            <TextRow label={t('Address')} value={url} placeholder="192.168.1.20:8080" maxLength={URL_MAX} onChange={setUrl} />
            <TextRow label={t('Username')} value={user} placeholder="kodi" maxLength={ACCOUNT_MAX} onChange={setUser} />
            <View style={[settingsStyles.cardBox, settingsStyles.textRow]}>
              <View style={settingsStyles.rowLabelBox}>
                <Text style={settingsStyles.rowLabel}>{t('Password')}</Text>
              </View>
              <TextInput
                style={settingsStyles.textInput}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={ACCOUNT_MAX}
                returnKeyType="done"
                onSubmitEditing={() => void saveAndTest()}
              />
            </View>
            <SettingRow
              icon="checkmark-circle-outline"
              label={busy ? t('Testing…') : t('Save and test')}
              onPress={url.trim() && !busy ? () => void saveAndTest() : undefined}
            />
            {result ? <Text style={settingsStyles.sectionDescription}>{result}</Text> : null}
            {saved.url ? (
              <SettingRow
                icon="trash-outline"
                label={t('Forget Kodi')}
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
