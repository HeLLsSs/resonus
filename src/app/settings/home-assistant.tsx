/**
 * Settings › Home Assistant: the address of the house's Home Assistant and a
 * token for it, which is all it takes for its media players to show up in
 * the output sheet (see `store/homeAssistant.ts`).
 *
 * The same for every profile, on purpose: the house does not change with
 * the server the app is signed in to, and a local profile's files reach a
 * player through the phone the same way they reach a Cast receiver. The
 * token is a secret and goes to the phone's secure store, the same place the
 * server password lives; on screen it is a hidden field, with no count of
 * characters over it for anybody looking over a shoulder.
 *
 * One button does both halves: the address and token are kept as typed, then
 * checked against Home Assistant, and the answer says what was found there,
 * since an address that answers but knows no player is the likelier mistake
 * than one that does not answer at all.
 */
import { useEffect, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';

import { SettingRow, SettingsPage, settingsStyles, TextRow, SwitchList } from '@/components/SettingsUI';
import { useT } from '@/i18n';
import { haVersion, HomeAssistantError, listPlayers, normalizeHaUrl } from '@/lib/homeAssistant';
import {
  ensureHaWebhookId,
  haDisconnect,
  setHomeAssistantConfig,
  setHomeAssistantEnabled,
  useHomeAssistant,
} from '@/store/homeAssistant';
import { colors, useTheme } from '@/theme';

/** Room for a domain with a path in front of Home Assistant. */
const URL_MAX = 200;
/** A long-lived token is a JWT of about two hundred characters; room for one pasted with stray spaces. */
const TOKEN_MAX = 400;

export default function HomeAssistantSettings() {
  // Repaints on a change of appearance or accent: a stack keeps this screen
  // mounted while you are on another one, out of reach of anything else.
  useTheme();
  const t = useT();
  const enabled = useHomeAssistant((s) => s.enabled);
  const savedUrl = useHomeAssistant((s) => s.url);
  const savedToken = useHomeAssistant((s) => s.token);
  const webhookId = useHomeAssistant((s) => s.webhookId);
  const hydrated = useHomeAssistant((s) => s.hydrated);
  const [url, setUrl] = useState(savedUrl);
  const [token, setToken] = useState(savedToken);
  const [busy, setBusy] = useState(false);
  /** What the last check found, under the button, until the next one. */
  const [result, setResult] = useState<string | null>(null);

  // Made the first time the screen is opened with the switch on, and kept:
  // the integration on the other side is set up with it. Not before what is
  // on disk is read, or the one read a moment later would replace it.
  useEffect(() => {
    if (enabled && hydrated) ensureHaWebhookId();
  }, [enabled, hydrated]);

  const saveAndTest = async () => {
    if (busy) return;
    const config = { url: normalizeHaUrl(url), token: token.trim() };
    // A session under way is against the address being replaced here, and the
    // speaker can only be told to stop while the app still knows how to reach
    // it: the sound is ended first, and the new address written after.
    if (config.url !== savedUrl || config.token !== savedToken) await haDisconnect();
    setHomeAssistantConfig(config.url, config.token);
    if (!config.url || !config.token) return;
    setBusy(true);
    setResult(null);
    try {
      const version = await haVersion(config);
      const players = await listPlayers(config);
      setResult(
        players.length === 1
          ? t('Home Assistant {version}: 1 media player can take a URL.', { version })
          : t('Home Assistant {version}: {n} media players can take a URL.', { version, n: players.length }),
      );
    } catch (e) {
      if (e instanceof HomeAssistantError && e.kind === 'unauthorized') {
        setResult(t('Home Assistant does not accept this token.'));
      } else {
        const reason = e instanceof HomeAssistantError ? e.message : '';
        setResult(reason ? `${t("Couldn't reach Home Assistant")} (${reason})` : t("Couldn't reach Home Assistant"));
      }
    } finally {
      setBusy(false);
    }
  };

  const forget = async () => {
    // Same order as above, and for the same reason: forgetting the address
    // first would leave the speaker playing with no way left to reach it.
    await haDisconnect();
    setHomeAssistantConfig('', '');
    setUrl('');
    setToken('');
    setResult(null);
  };

  return (
    <SettingsPage title="Home Assistant">
      <ScrollView contentContainerStyle={settingsStyles.content} keyboardShouldPersistTaps="handled">
        <Text style={settingsStyles.sectionDescription}>
          {t(
            'Play on the speakers Home Assistant knows about: Music Assistant, Chromecast, DLNA and Sonos players among them. They join the output list once the address and a token are in.',
          )}
        </Text>
        <SwitchList
          options={[
            {
              label: t('Use Home Assistant'),
              description: t('Lists its media players in the output sheet.'),
              value: enabled,
              onChange: setHomeAssistantEnabled,
            },
          ]}
        />
        {enabled ? (
          <>
        <TextRow
          label={t('Address')}
          value={url}
          placeholder="http://homeassistant.local:8123"
          maxLength={URL_MAX}
          onChange={setUrl}
        />
        <View style={[settingsStyles.cardBox, settingsStyles.textRow]}>
          <View style={settingsStyles.rowLabelBox}>
            <Text style={settingsStyles.rowLabel}>{t('Long-lived access token')}</Text>
            <Text style={settingsStyles.rowDescription}>
              {t('Made at the bottom of your profile page in Home Assistant.')}
            </Text>
          </View>
          <TextInput
            style={settingsStyles.textInput}
            value={token}
            onChangeText={setToken}
            secureTextEntry
            placeholder="eyJ…"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={TOKEN_MAX}
            returnKeyType="done"
            onSubmitEditing={() => void saveAndTest()}
          />
        </View>
        <SettingRow
          icon="checkmark-circle-outline"
          label={busy ? t('Testing…') : t('Save and test')}
          onPress={url.trim() && token.trim() && !busy ? () => void saveAndTest() : undefined}
        />
        {result ? <Text style={settingsStyles.sectionDescription}>{result}</Text> : null}
        <Text style={settingsStyles.sectionTitle}>{t('Card in Home Assistant')}</Text>
        <Text style={settingsStyles.sectionDescription}>
          {t(
            'The Resonus integration adds a media player Home Assistant can browse and play from, on this phone. Setting it up asks for this identifier, which is how what is playing here finds its way back to the card.',
          )}
        </Text>
        <View style={[settingsStyles.cardBox, settingsStyles.textRow]}>
          <View style={settingsStyles.rowLabelBox}>
            <Text style={settingsStyles.rowLabel}>{t('Webhook identifier')}</Text>
            <Text style={settingsStyles.rowDescription}>{t('Press and hold to copy it.')}</Text>
          </View>
          <Text selectable style={settingsStyles.rowValue}>
            {webhookId}
          </Text>
        </View>
        {savedUrl || savedToken ? (
          <SettingRow
            icon="trash-outline"
            label={t('Forget Home Assistant')}
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
