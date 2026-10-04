/**
 * The settings kept on the Navifind proxy, so that a reinstall finds them
 * again (Settings › Backup & restore).
 *
 * What is kept is the backup file of `lib/backup.ts` without anything that
 * signs in: no password or token, no proxy header, no ListenBrainz token
 * (`lib/proxyBackup.ts` takes a second look on top of the backup's own). One
 * document per account, which the proxy stores without reading.
 *
 * Saving happens 30 seconds after the last change of a setting, and when the
 * app goes to the background, with `backupToProxy` and Navifind on and the
 * app not offline. Never before the account has been past the offer below:
 * on a fresh install the first save would be factory settings written over
 * the very copy the install is about to be offered.
 *
 * The offer: once per account on this install, the first time the proxy can
 * be reached, if the settings are still factory ones and the proxy has a
 * copy, the app asks whether to restore it. Settings › Backup & restore can
 * restore it by hand at any time.
 */
import { Alert, AppState } from 'react-native';
import { create } from 'zustand';

import * as api from '@/api/subsonic';
import { tg } from '@/i18n';
import { BackupError, collect, readPayload, restoreBackup } from '@/lib/backup';
import { getPlainItem, setPlainItem } from '@/lib/plainStorage';
import { settingsAreDefault, stripSecrets, withLocalSecrets } from '@/lib/proxyBackup';
import { primaryUrl } from '@/lib/serverUrls';
import { getItem } from '@/lib/storage';
import { useAuthStore } from '@/store/auth';
import { useSettings } from '@/store/settings';

const SAVE_AFTER_MS = 30_000;
const STORAGE_KEY = 'proxy-backup';
const FORMAT_VERSION = 1;

/** What is remembered per account: whether the offer was made, and the last save. */
interface Memory {
  offered: boolean;
  savedAt: string | null;
}

/** When the proxy's copy of the active account was last saved, for the screen. */
export const useProxyBackup = create<{ savedAt: string | null }>(() => ({ savedAt: null }));

let memory: Record<string, Memory> | null = null;
let dirty = true;
let saving = false;
let offering = false;
/** The last document sent, per account, so an unchanged one is not sent again. */
const lastSent = new Map<string, string>();

/** The account to work for, or null when the proxy is not to be reached now. */
function ready(needSwitch = true): { auth: api.SubsonicAuth; profile: string } | null {
  const { auth, offline, hydrating } = useAuthStore.getState();
  const settings = useSettings.getState();
  // The setting and not `navifindActive()`: a subscriber hears the switch
  // before the settings store has passed it on to `lib/navifind`.
  if (!auth || offline || hydrating || !settings.hydrated || !settings.navifind) return null;
  if (needSwitch && !settings.backupToProxy) return null;
  return { auth, profile: `${primaryUrl(auth)}|${auth.username}` };
}

async function recall(profile: string): Promise<Memory> {
  if (!memory) {
    try {
      const parsed: unknown = JSON.parse((await getPlainItem(STORAGE_KEY)) ?? '{}');
      memory = parsed && typeof parsed === 'object' ? (parsed as Record<string, Memory>) : {};
    } catch {
      memory = {};
    }
  }
  return memory[profile] ?? { offered: false, savedAt: null };
}

async function remember(profile: string, next: Memory): Promise<void> {
  await recall(profile);
  memory = { ...memory, [profile]: next };
  if (ready(false)?.profile === profile) useProxyBackup.setState({ savedAt: next.savedAt });
  await setPlainItem(STORAGE_KEY, JSON.stringify(memory)).catch(() => {});
}

async function save(): Promise<void> {
  const start = ready();
  if (!start || saving) return;
  const known = await recall(start.profile);
  if (!known.offered) return;
  saving = true;
  dirty = false;
  try {
    const { profiles, data, ride } = stripSecrets(await collect(false));
    const json = JSON.stringify({ version: FORMAT_VERSION, profiles, data, ride });
    if (lastSent.get(start.profile) === json) return;
    const savedAt = await api.saveSettingsToProxy(start.auth, json);
    lastSent.set(start.profile, json);
    await remember(start.profile, { ...known, savedAt: savedAt ?? new Date().toISOString() });
  } catch {
    // No answer, or a document the proxy refused: the next change tries again.
    dirty = true;
  } finally {
    saving = false;
  }
}

/** Writes the proxy's copy over this phone's settings, keeping this phone's secrets. */
async function apply(settings: unknown): Promise<void> {
  if (typeof settings !== 'object' || settings === null) throw new BackupError('invalid');
  const doc = settings as Record<string, unknown>;
  const payload = readPayload(doc.profiles, doc.data, doc.ride);
  for (const [key, raw] of Object.entries(payload.data)) {
    payload.data[key] = withLocalSecrets(raw, await getItem(key).catch(() => null));
  }
  await restoreBackup(payload);
}

/** The app's question, as a promise of the answer. */
function confirmRestore(savedAt: string | null): Promise<boolean> {
  const date = savedAt ? new Date(savedAt) : null;
  return new Promise((resolve) => {
    Alert.alert(
      tg('Restore your settings from the server?'),
      date && !Number.isNaN(date.getTime())
        ? tg('Navifind has a copy of your settings saved on {date}. Restoring it replaces the settings on this phone.', {
            date: date.toLocaleString(),
          })
        : tg('Navifind has a copy of your settings. Restoring it replaces the settings on this phone.'),
      [
        { text: tg('Not now'), style: 'cancel', onPress: () => resolve(false) },
        { text: tg('Restore'), onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

async function offer(): Promise<void> {
  const start = ready();
  if (!start || offering || AppState.currentState !== 'active') return;
  const known = await recall(start.profile);
  if (known.offered) return;
  offering = true;
  try {
    const fresh = settingsAreDefault(useSettings.getState(), useSettings.getInitialState());
    const copy = fresh ? await api.loadSettingsFromProxy(start.auth) : null;
    if (copy && (await confirmRestore(copy.savedAt)) && ready()?.profile === start.profile) {
      await apply(copy.settings);
    }
    await remember(start.profile, { offered: true, savedAt: copy?.savedAt ?? known.savedAt });
  } catch {
    // No answer from the proxy: asked again the next time it can be reached.
  } finally {
    offering = false;
  }
}

/**
 * The manual "Restore from the server": false when the proxy has no copy for
 * this account. Throws when it cannot be reached or the copy cannot be read.
 */
export async function restoreFromProxy(): Promise<boolean> {
  const start = ready(false);
  if (!start) throw new Error('unreachable');
  const copy = await api.loadSettingsFromProxy(start.auth);
  if (!copy) return false;
  await apply(copy.settings);
  return true;
}

/** Once, at app start: saves after each change, and makes the offer when it is due. */
export function startProxyBackup(): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  useSettings.subscribe((s, prev) => {
    if (!s.hydrated) return;
    if (!prev.hydrated) {
      // A profile just read in: what is known of its copy, and its offer.
      const start = ready(false);
      if (start) void recall(start.profile).then((m) => useProxyBackup.setState({ savedAt: m.savedAt }));
    } else {
      dirty = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void save();
      }, SAVE_AFTER_MS);
    }
    void offer();
  });
  AppState.addEventListener('change', (state) => {
    if (state === 'active') void offer();
    else if (state === 'background' && dirty) {
      if (timer) clearTimeout(timer);
      timer = null;
      void save();
    }
  });
}
