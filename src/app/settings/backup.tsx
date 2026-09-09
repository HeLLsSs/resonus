/**
 * Settings › Backup & restore: the profiles and preferences as one file, out
 * to wherever the share sheet goes and back in from the file picker.
 *
 * What is in the file, and what is deliberately not, is decided in
 * `lib/backup.ts`. This screen only asks the two questions that are the
 * user's to answer (whether the tokens and proxy headers go along, and
 * whether the file is locked with a passphrase), shows what a picked file
 * holds before anything is written, profile by profile, and says afterwards
 * what changed.
 */
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { Field, SettingRow, SettingsPage, settingsStyles, SwitchList, TextRow } from '@/components/SettingsUI';
import { useT, type TFunction } from '@/i18n';
import {
  BackupError,
  exportBackup,
  pickBackup,
  previewProfiles,
  restoreBackup,
  unlockBackup,
  type PickedBackup,
  type RestoreResult,
} from '@/lib/backup';
import { useToast } from '@/store/toast';
import { useTheme } from '@/theme';

/** Room for a sentence; a passphrase is typed twice, once here and once on
 *  the other phone, and a long one is the one that gets mistyped. */
const PASSPHRASE_MAX = 64;

/** About five rows of the profile list before it scrolls on its own, so a
 *  file with many accounts does not push the Restore row off the screen. */
const PROFILE_LIST_MAX_HEIGHT = 264;

function errorText(t: TFunction, e: unknown): string {
  if (!(e instanceof BackupError)) return t("Couldn't read the file");
  switch (e.kind) {
    case 'invalid':
      return t('That file is not a backup');
    case 'newer':
      return t('This backup was made by a newer version of the app');
    case 'passphrase':
      return t('Wrong passphrase');
    case 'unreadable':
      return t("Couldn't read the file");
  }
}

export default function BackupSettings() {
  // Repaints on a change of appearance or accent: a stack keeps this screen
  // mounted while you are on another one, out of reach of anything else.
  useTheme();
  const t = useT();
  const toast = useToast((s) => s.show);
  const [includeTokens, setIncludeTokens] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  // A file that has been picked and read, waiting to be unlocked if it is
  // encrypted, then confirmed.
  const [picked, setPicked] = useState<PickedBackup | null>(null);
  const [unlockWith, setUnlockWith] = useState('');
  const [restored, setRestored] = useState<RestoreResult | null>(null);

  const runExport = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (!(await exportBackup({ includeTokens, passphrase: passphrase.trim() }))) {
        toast(t('Sharing is not available on this device'));
      }
    } catch {
      toast(t("Couldn't write the backup"));
    } finally {
      setBusy(false);
    }
  };

  const runPick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await pickBackup();
      if (next) {
        setPicked(next);
        setUnlockWith('');
        setRestored(null);
      }
    } catch (e) {
      toast(errorText(t, e));
    } finally {
      setBusy(false);
    }
  };

  // Its own step, and not folded into the restore: the profiles are inside
  // the sealed part, and they have to be shown before they are written.
  const runUnlock = async () => {
    if (busy || !picked) return;
    setBusy(true);
    try {
      const payload = await unlockBackup(picked, unlockWith.trim());
      setPicked({ ...picked, payload });
      setUnlockWith('');
    } catch (e) {
      toast(errorText(t, e));
    } finally {
      setBusy(false);
    }
  };

  const runRestore = async () => {
    if (busy || !picked?.payload) return;
    setBusy(true);
    try {
      const result = await restoreBackup(picked.payload);
      setRestored(result);
      setPicked(null);
      toast(t('Backup restored'));
    } catch (e) {
      toast(errorText(t, e));
    } finally {
      setBusy(false);
    }
  };

  const createdAt = picked?.summary.createdAt ? new Date(picked.summary.createdAt) : null;
  const preview = picked?.payload ? previewProfiles(picked.payload) : null;
  const canUnlock = !busy && unlockWith.trim().length > 0;

  return (
    <SettingsPage title={t('Backup & restore')}>
      <ScrollView contentContainerStyle={settingsStyles.content} keyboardShouldPersistTaps="handled">
        <Text style={settingsStyles.sectionDescription}>
          {t(
            'Your profiles and every setting, pin and smart playlist kept under them, as one file. Downloads, play history and listening stats stay on this device.',
          )}
        </Text>

        <Text style={settingsStyles.sectionTitle}>{t('Export')}</Text>
        <SwitchList
          options={[
            {
              label: t('Include tokens and proxy headers'),
              description: t(
                'On, the ListenBrainz token and the custom headers of each profile go into the file, a proxy secret set as a header among them. Off, both are left out and have to be entered again.',
              ),
              value: includeTokens,
              onChange: setIncludeTokens,
            },
          ]}
        />
        <TextRow
          label={t('Passphrase')}
          description={
            passphrase.trim()
              ? t('The file is encrypted with it; you will need it to restore.')
              : t('Optional. Without one the file is saved as plain JSON: keep it somewhere private.')
          }
          value={passphrase}
          maxLength={PASSPHRASE_MAX}
          onChange={setPassphrase}
        />
        <SettingRow
          icon="share-outline"
          label={busy ? t('Working…') : t('Export a backup')}
          description={t(
            'Passwords never leave the phone: a restored profile asks you to sign in again. Headers and tokens go only with the switch above.',
          )}
          onPress={busy ? undefined : () => void runExport()}
        />

        <Text style={settingsStyles.sectionTitle}>{t('Restore')}</Text>
        <Text style={settingsStyles.sectionDescription}>
          {t(
            'Profiles already on this phone are left as they are: a file can only add new ones. Settings in the file replace the ones here. After restoring, sign in to each new profile from the profile list.',
          )}
        </Text>
        <SettingRow
          icon="folder-open-outline"
          label={t('Restore from a file')}
          chevron
          onPress={busy ? undefined : () => void runPick()}
        />

        {picked ? (
          <>
            <Text style={settingsStyles.sectionTitle}>{t('In this file')}</Text>
            <Field
              label={t('Created')}
              value={createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt.toLocaleString() : '—'}
            />
            <Field label={t('App version')} value={picked.summary.app || '—'} />
            {preview ? (
              <>
                <Text style={settingsStyles.groupTitle}>{t('Profiles')}</Text>
                <ScrollView
                  style={[settingsStyles.cardBox, { maxHeight: PROFILE_LIST_MAX_HEIGHT }]}
                  nestedScrollEnabled
                >
                  {preview.map((p, i) => (
                    <View
                      key={`${p.label}-${i}`}
                      style={[settingsStyles.row, i > 0 && settingsStyles.rowBorder]}
                    >
                      <View style={settingsStyles.rowLabelBox}>
                        <Text style={settingsStyles.rowLabel} numberOfLines={1}>
                          {p.label}
                        </Text>
                      </View>
                      <Text style={settingsStyles.rowValue}>{p.existing ? t('Already here') : t('New')}</Text>
                    </View>
                  ))}
                </ScrollView>
                <SettingRow
                  icon="download-outline"
                  label={busy ? t('Restoring…') : t('Restore this backup')}
                  onPress={busy ? undefined : () => void runRestore()}
                />
              </>
            ) : (
              <>
                <Field label={t('Profiles')} value={String(picked.summary.count)} />
                <TextRow
                  label={t('Passphrase')}
                  description={t('This backup is encrypted.')}
                  value={unlockWith}
                  maxLength={PASSPHRASE_MAX}
                  onChange={setUnlockWith}
                />
                <SettingRow
                  icon="lock-open-outline"
                  label={busy ? t('Working…') : t('Unlock this backup')}
                  onPress={canUnlock ? () => void runUnlock() : undefined}
                />
              </>
            )}
            <SettingRow
              icon="close-outline"
              label={t('Cancel')}
              onPress={busy ? undefined : () => setPicked(null)}
            />
          </>
        ) : null}

        {restored ? (
          <>
            <Text style={settingsStyles.sectionTitle}>{t('Restored')}</Text>
            <Field label={t('Profiles added')} value={String(restored.added)} />
            <Field label={t('Profiles already on this phone')} value={String(restored.existing)} />
            <Field label={t('Settings entries written')} value={String(restored.entries)} />
            {restored.skipped > 0 ? (
              <Field label={t('Entries skipped as unreadable')} value={String(restored.skipped)} />
            ) : null}
            {restored.added > 0 ? (
              <Text style={settingsStyles.sectionDescription}>
                {t('The new profiles have no password yet: sign in to each one from the profile list.')}
              </Text>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </SettingsPage>
  );
}
