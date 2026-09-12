/**
 * Settings › Network shares: where a WebDAV share is added and forgotten.
 *
 * A share is an address, a name to reach it with, and a password. It is tried
 * before it is kept — an address that answers nothing is worth saying so at
 * once rather than at the first attempt to browse it — and the password goes
 * to the phone's secure store, never into the settings kept beside it.
 *
 * There is no scan and no library here on purpose: the folders are browsed as
 * they are (see `app/webdav/[id]`), so a share works the moment it is added
 * rather than after a collection has been read through over a network.
 */
import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { SettingRow, SettingsPage, settingsStyles, TextRow } from '@/components/SettingsUI';
import { useT } from '@/i18n';
import {
  forgetSource,
  saveSource,
  testSource,
  useWebdav,
  type DavSource,
} from '@/store/webdav';
import { useTheme } from '@/theme';

/** Room for a domain, a long path and an app password. */
const URL_MAX = 300;
const NAME_MAX = 60;
const PASS_MAX = 200;

/** A share's own name when nobody gave it one: the host it lives on, which is
 *  what somebody would have typed anyway. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export default function WebdavSettings() {
  const t = useT();
  useTheme();
  const sources = useWebdav((s) => s.sources);

  const [url, setUrl] = useState('');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  const ready = url.trim().length > 0 && user.trim().length > 0 && password.length > 0;

  /**
   * Tries the share, then keeps it. In that order: a password that is refused
   * is the likeliest mistake of the four fields, and finding out at the first
   * browse means going back to a screen somebody has already left.
   */
  async function add() {
    if (!ready || busy) return;
    setBusy(true);
    setSaid(null);
    const clean = url.trim().replace(/\/+$/, '');
    const source: DavSource = {
      id: `dav${Date.now().toString(36)}`,
      name: name.trim() || hostOf(clean) || t('Share'),
      url: clean,
      user: user.trim(),
    };
    try {
      if (!(await testSource(source, password))) {
        setSaid(t('That address did not answer, or the password was refused. Nothing was saved.'));
        return;
      }
      await saveSource(source, password);
      setSaid(t('Share added.'));
      setUrl('');
      setUser('');
      setPassword('');
      setName('');
    } catch {
      setSaid(t('That address could not be reached. Nothing was saved.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsPage title={t('Network shares')}>
      <ScrollView contentContainerStyle={settingsStyles.content} keyboardShouldPersistTaps="handled">
        <Text style={settingsStyles.sectionDescription}>
          {t(
            'A WebDAV share — Nextcloud, ownCloud, a NAS — browsed as folders. Nothing is scanned and nothing is copied: what you open plays straight from it, so a share works the moment it is added.',
          )}
        </Text>

        {sources.length > 0 ? (
          <>
            <Text style={settingsStyles.sectionTitle}>{t('Your shares')}</Text>
            {sources.map((source) => (
              <View key={source.id}>
                <SettingRow
                  icon="folder-outline"
                  label={source.name}
                  description={source.url}
                  chevron
                  onPress={() => router.push(`/webdav/${source.id}`)}
                />
                <SettingRow
                  icon="trash-outline"
                  label={t('Forget this share')}
                  destructive
                  onPress={() => void forgetSource(source.id)}
                />
              </View>
            ))}
            <Text style={settingsStyles.sectionDescription}>
              {t('Forgetting a share takes its password with it. Nothing on the server is touched.')}
            </Text>
          </>
        ) : null}

        <Text style={settingsStyles.sectionTitle}>{t('Add a share')}</Text>
        <TextRow
          label={t('Address')}
          value={url}
          onChange={setUrl}
          maxLength={URL_MAX}
          placeholder="https://cloud.example.com/remote.php/dav/files/you"
        />
        <TextRow label={t('Username')} value={user} onChange={setUser} maxLength={NAME_MAX} />
        <TextRow
          label={t('Password')}
          description={t('An app password rather than your account one, where the server offers them.')}
          value={password}
          onChange={setPassword}
          maxLength={PASS_MAX}
        />
        <Text style={settingsStyles.sectionDescription}>
          {t(
            'On Nextcloud, make an app password under Settings › Security rather than using your account password: it opens the files and nothing else, and you can revoke it on its own.',
          )}
        </Text>
        <TextRow
          label={t('Name')}
          value={name}
          onChange={setName}
          maxLength={NAME_MAX}
          placeholder={hostOf(url.trim())}
        />
        <SettingRow
          icon="add-circle-outline"
          label={busy ? t('Trying…') : t('Add this share')}
          onPress={ready && !busy ? () => void add() : undefined}
        />
        {said ? <Text style={settingsStyles.sectionDescription}>{said}</Text> : null}
      </ScrollView>
    </SettingsPage>
  );
}

