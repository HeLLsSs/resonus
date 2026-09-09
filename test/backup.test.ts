/**
 * Backup and restore: what leaves the phone (never a secret), what a file
 * is allowed to put back (only blobs their stores can read), and that a
 * passphrase-protected file opens with the right passphrase and no other.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { BackupError, exportBackup, pickBackup, previewProfiles, restoreBackup, unlockBackup, type BackupPayload, type PickedBackup } from '@/lib/backup';
import type { Profile } from '@/store/auth';

import { APP_VERSION } from './stubs/expo-constants';
import { fileSystem } from './stubs/expo-file-system';
import { sharing } from './stubs/expo-sharing';
import { hashKey } from './stubs/lib-localLibrary';
import { localQueries } from './stubs/lib-localQueries';
import { queryClient } from './stubs/lib-query';
import { storage } from './stubs/lib-storage';
import { serverProfile, useAuthStore } from './stubs/store-auth';
import { useEqualizer, usePins, useSortPrefs } from './stubs/store-hydrated';
import { useSettings } from './stubs/store-settings';

/** The profile as the phone keeps it, secrets and all. */
const ana = serverProfile({
  username: 'ana',
  urls: ['https://music.example', 'http://192.168.1.2:4533'],
  headers: { 'CF-Access-Client-Secret': 'shh' },
  password: 'plain',
  ndPassword: 'nd',
  jfToken: 'jf',
  serverType: 'navidrome',
});
const offline: Profile = { _type: 'offline', name: 'Phone', source: { mode: 'folder', uris: ['content://a'] } };

const anaScope = hashKey('https://music.example|ana');

/** A file's text as the picker hands it back, already parsed. */
async function pick(text: string): Promise<PickedBackup | null> {
  fileSystem.pick = { name: 'backup.json', text };
  return pickBackup();
}

async function pickError(text: string): Promise<BackupError['kind']> {
  try {
    await pick(text);
  } catch (e) {
    if (e instanceof BackupError) return e.kind;
    throw e;
  }
  throw new Error('expected a BackupError');
}

const plainFile = (extra: Record<string, unknown> = {}) => JSON.stringify({ version: 1, app: '1.0', createdAt: '2026-01-01T00:00:00Z', count: 1, profiles: [], data: {}, ...extra });

beforeEach(() => {
  fileSystem.reset();
  sharing.reset();
  storage.reset();
  useAuthStore.setState({ auth: null, profiles: [], offline: false });
});

describe('pickBackup', () => {
  it('answers null when nobody chose', async () => {
    assert.equal(await pickBackup(), null);
  });

  it('refuses text that is not JSON, or JSON that is not a backup', async () => {
    assert.equal(await pickError('{not json'), 'invalid');
    assert.equal(await pickError('[]'), 'invalid');
    assert.equal(await pickError('{"app":"1.0"}'), 'invalid');
    assert.equal(await pickError('{"version":"1","profiles":[],"data":{}}'), 'invalid');
  });

  it('refuses a file from a newer app', async () => {
    assert.equal(await pickError(plainFile({ version: 2 })), 'newer');
  });

  it('needs both halves of a file in the clear', async () => {
    assert.equal(await pickError(JSON.stringify({ version: 1, profiles: [] })), 'invalid');
    assert.equal(await pickError(JSON.stringify({ version: 1, profiles: {}, data: {} })), 'invalid');
  });

  it('describes the file, counting the profiles when the file did not', async () => {
    const picked = await pick(JSON.stringify({ version: 1, profiles: [{ serverUrl: 'https://s', username: 'u' }], data: {} }));
    assert.deepEqual(picked?.summary, { app: '', createdAt: '', count: 1, encrypted: false });
  });

  it('keeps the summary the file wrote', async () => {
    const picked = await pick(plainFile({ count: 7 }));
    assert.deepEqual(picked?.summary, { app: '1.0', createdAt: '2026-01-01T00:00:00Z', count: 7, encrypted: false });
  });

  describe('an encrypted envelope', () => {
    const salt = 'ab'.repeat(16);
    const sealed = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const envelope = (enc: Record<string, unknown>) => JSON.stringify({ version: 1, count: 1, encrypted: { salt, iterations: 10_000, sealed, ...enc } });

    it('is accepted whole, with nothing readable yet', async () => {
      const picked = await pick(envelope({}));
      assert.equal(picked?.summary.encrypted, true);
      assert.equal(picked?.payload, null);
    });

    it('is refused with a key stretch that is not a whole number within bounds', async () => {
      assert.equal(await pickError(envelope({ iterations: 0 })), 'invalid');
      assert.equal(await pickError(envelope({ iterations: 100_001 })), 'invalid');
      assert.equal(await pickError(envelope({ iterations: 1.5 })), 'invalid');
      assert.equal(await pickError(envelope({ iterations: '10000' })), 'invalid');
    });

    it('is refused with a salt that is not sixteen bytes of hex', async () => {
      assert.equal(await pickError(envelope({ salt: 'ab'.repeat(15) })), 'invalid');
      assert.equal(await pickError(envelope({ salt: 'zz'.repeat(16) })), 'invalid');
    });

    it('is refused with sealed data that is not base64', async () => {
      assert.equal(await pickError(envelope({ sealed: 'AAA' })), 'invalid');
      assert.equal(await pickError(envelope({ sealed: 'AAA!' })), 'invalid');
      assert.equal(await pickError(envelope({ sealed: 42 })), 'invalid');
    });

    it('is refused when it is not an object at all', async () => {
      assert.equal(await pickError(JSON.stringify({ version: 1, encrypted: 'yes' })), 'invalid');
    });
  });

  describe('the storage entries', () => {
    it('keeps only known keys whose blob is the shape their store reads', async () => {
      const data = {
        'resonus.language': 'fr',
        'resonus.sortPrefs': '{"albums":"name"}',
        [`resonus.settings.${anaScope}`]: '{"theme":"dark"}',
        [`resonus.smartPlaylists.${anaScope}`]: '[]',
        [`resonus.localPlaylists.${anaScope}`]: '{"not":"an array"}',
        [`resonus.pins.${anaScope}`]: 'not json',
        'resonus.equalizer': 42,
        'resonus.auth': '{"token":"stolen"}',
        'resonus.profiles': '[]',
        'resonus.settings.bad suffix': '{}',
        'resonus.language.x': 'fr',
      };
      const picked = await pick(plainFile({ data }));
      assert.deepEqual(picked?.payload?.data, {
        'resonus.language': 'fr',
        'resonus.sortPrefs': '{"albums":"name"}',
        [`resonus.settings.${anaScope}`]: '{"theme":"dark"}',
        [`resonus.smartPlaylists.${anaScope}`]: '[]',
      });
      assert.equal(picked?.payload?.skipped, 7);
    });

    it('does not take an empty language', async () => {
      const picked = await pick(plainFile({ data: { 'resonus.language': '' } }));
      assert.equal(picked?.payload?.skipped, 1);
    });
  });

  describe('the profiles', () => {
    it('never believes what a file says about signing in', async () => {
      const picked = await pick(plainFile({ profiles: [{ ...ana, token: 'evil', salt: 'evil' }] }));
      const [profile] = picked!.payload!.profiles;
      assert.equal(profile._type, 'server');
      if (profile._type !== 'server') return;
      assert.equal(profile.token, '');
      assert.equal(profile.salt, '');
      assert.equal(profile.password, undefined);
      assert.equal(profile.ndPassword, undefined);
      assert.equal(profile.jfToken, undefined);
      assert.deepEqual(profile.urls, ana.urls);
      assert.deepEqual(profile.headers, ana.headers, 'headers a file carries are kept');
      assert.equal(profile.serverType, 'navidrome');
    });

    it('gives a profile with no addresses its one address', async () => {
      const picked = await pick(plainFile({ profiles: [{ serverUrl: 'https://s', username: 'u', urls: [] }] }));
      const [profile] = picked!.payload!.profiles;
      assert.deepEqual(profile._type === 'server' ? profile.urls : null, ['https://s']);
    });

    it('drops headers that are not all text', async () => {
      const picked = await pick(plainFile({ profiles: [{ serverUrl: 'https://s', username: 'u', headers: { a: 1 } }] }));
      const [profile] = picked!.payload!.profiles;
      assert.equal(profile._type === 'server' ? profile.headers : 'x', undefined);
    });

    it('takes an offline profile with somewhere to read from, and leaves the rest', async () => {
      const profiles = [
        offline,
        { _type: 'offline', name: 'Empty', source: { mode: 'folder', uris: [] } },
        { _type: 'offline', name: 'Device', source: { mode: 'device', uris: ['ignored'] } },
        { _type: 'offline', source: { mode: 'device' } },
        { username: 'no url' },
        'nonsense',
        null,
      ];
      const picked = await pick(plainFile({ profiles }));
      assert.deepEqual(picked?.payload?.profiles, [offline, { _type: 'offline', name: 'Device', source: { mode: 'device' } }]);
    });
  });
});

describe('previewProfiles', () => {
  it('names each profile and says which ones the phone has', () => {
    useAuthStore.setState({ profiles: [serverProfile({ username: 'ana', urls: ['http://192.168.1.2:4533'] }), offline] });
    const payload: BackupPayload = {
      profiles: [ana, { ...ana, username: 'bob' }, offline, { _type: 'offline', name: 'Other', source: { mode: 'device' } }],
      data: {},
      skipped: 0,
    };
    assert.deepEqual(previewProfiles(payload), [
      { label: 'ana @ https://music.example', existing: true },
      { label: 'bob @ https://music.example', existing: false },
      { label: 'Phone', existing: true },
      { label: 'Other', existing: false },
    ]);
  });

  it('files a profile under its scope address, not the one in use', () => {
    const payload: BackupPayload = { profiles: [serverProfile({ serverUrl: 'http://10.0.0.1', urls: ['http://10.0.0.1'], scopeUrl: 'https://old.example' })], data: {}, skipped: 0 };
    assert.equal(previewProfiles(payload)[0].label, 'ana @ https://old.example');
  });
});

describe('exportBackup', () => {
  const settingsBlob = JSON.stringify({ theme: 'dark', listenBrainzToken: 'lb-secret', listenBrainzUser: 'ana' });

  beforeEach(() => {
    useAuthStore.setState({ profiles: [ana, offline] });
    storage.items.set('resonus.language', 'fr');
    storage.items.set('resonus.settings', settingsBlob);
    storage.items.set(`resonus.settings.${anaScope}`, settingsBlob);
    storage.items.set(`resonus.pins.${hashKey('local')}`, '{"a":1}');
    storage.items.set(`resonus.smartPlaylists.${hashKey('default')}`, '[]');
    storage.items.set('resonus.lastPlayed', '{"not":"taken"}');
    storage.items.set('resonus.auth', '{"token":"x"}');
  });

  /** What was shared, parsed. */
  async function exported(options: { includeTokens: boolean; passphrase: string }) {
    assert.equal(await exportBackup(options), true);
    const [shared] = sharing.shared;
    assert.equal(shared.options?.mimeType, 'application/json');
    return JSON.parse(shared.text ?? 'null') as Record<string, unknown>;
  }

  it('answers false with no share sheet and shares nothing', async () => {
    sharing.available = false;
    assert.equal(await exportBackup({ includeTokens: false, passphrase: '' }), false);
    assert.equal(sharing.shared.length, 0);
  });

  it('stamps the file and deletes the copy in the cache once shared', async () => {
    const file = await exported({ includeTokens: false, passphrase: '' });
    assert.equal(file.version, 1);
    assert.equal(file.app, APP_VERSION);
    assert.equal(file.count, 2);
    assert.ok(typeof file.createdAt === 'string' && !Number.isNaN(Date.parse(file.createdAt)));
    assert.equal(fileSystem.files.size, 0);
  });

  it('sends no secret with a profile, and no headers unless asked', async () => {
    const file = await exported({ includeTokens: false, passphrase: '' });
    const [server, local] = file.profiles as Record<string, unknown>[];
    assert.equal(server.token, '');
    assert.equal(server.salt, '');
    for (const secret of ['password', 'ndPassword', 'jfToken', 'headers']) assert.equal(secret in server && server[secret] !== undefined, false, secret);
    assert.deepEqual(server.urls, ana.urls);
    assert.equal(server.serverType, 'navidrome');
    assert.deepEqual(local, offline);
  });

  it('sends the headers, and only them, when asked for the tokens', async () => {
    const file = await exported({ includeTokens: true, passphrase: '' });
    const [server] = file.profiles as Record<string, unknown>[];
    assert.deepEqual(server.headers, ana.headers);
    assert.equal(server.token, '');
    assert.equal(server.password, undefined);
    assert.equal(server.ndPassword, undefined);
    assert.equal(server.jfToken, undefined);
  });

  it('collects the global keys and the scoped keys of every profile, local and none', async () => {
    const file = await exported({ includeTokens: false, passphrase: '' });
    assert.deepEqual(Object.keys(file.data as object).sort(), [
      'resonus.language',
      `resonus.pins.${hashKey('local')}`,
      'resonus.settings',
      `resonus.settings.${anaScope}`,
      `resonus.smartPlaylists.${hashKey('default')}`,
    ]);
  });

  it('strips the ListenBrainz token out of every settings blob unless asked', async () => {
    const without = await exported({ includeTokens: false, passphrase: '' });
    const data = without.data as Record<string, string>;
    assert.equal(data['resonus.settings'], '{"theme":"dark"}');
    assert.equal(data[`resonus.settings.${anaScope}`], '{"theme":"dark"}');
    sharing.reset();
    const withTokens = await exported({ includeTokens: true, passphrase: '' });
    assert.equal((withTokens.data as Record<string, string>)['resonus.settings'], settingsBlob);
  });

  it('seals both halves under a passphrase and opens them again with it', async () => {
    const file = await exported({ includeTokens: false, passphrase: 'correct horse' });
    assert.equal(file.profiles, undefined);
    assert.equal(file.data, undefined);
    const enc = file.encrypted as Record<string, unknown>;
    assert.match(String(enc.salt), /^[0-9a-f]{32}$/);
    assert.equal(enc.iterations, 10_000);
    assert.ok(!String(enc.sealed).includes('music.example'), 'nothing readable in the sealed blob');

    const picked = await pick(JSON.stringify(file));
    assert.equal(picked?.payload, null);
    await assert.rejects(unlockBackup(picked!, 'wrong'), (e: unknown) => e instanceof BackupError && e.kind === 'passphrase');
    const payload = await unlockBackup(picked!, 'correct horse');
    assert.deepEqual(payload.profiles.map((p) => (p._type === 'server' ? p.username : p.name)), ['ana', 'Phone']);
    assert.equal(payload.data['resonus.language'], 'fr');
    assert.equal(payload.skipped, 0);
  });

  it('opens with the passphrase typed in another normalisation form', async () => {
    const file = await exported({ includeTokens: false, passphrase: 'café' });
    const picked = await pick(JSON.stringify(file));
    const payload = await unlockBackup(picked!, 'café');
    assert.equal(payload.profiles.length, 2);
  });

  it('refuses to unlock a file that was never sealed', async () => {
    const picked = await pick(plainFile());
    await assert.rejects(unlockBackup(picked!, 'x'), (e: unknown) => e instanceof BackupError && e.kind === 'invalid');
  });
});

describe('restoreBackup', () => {
  it('writes the entries, adds only the profiles the phone lacks and has the stores read again', async () => {
    const onPhone = serverProfile({ username: 'ana', urls: ['http://192.168.1.2:4533'], headers: { keep: 'mine' } });
    useAuthStore.setState({ profiles: [onPhone] });
    const before = {
      settings: useSettings.getState().hydrations,
      pins: usePins.getState().hydrations,
      eq: useEqualizer.getState().hydrations,
      sort: useSortPrefs.getState().hydrations,
      favs: localQueries.favsCleared,
      playlists: localQueries.playlistsCleared,
      queries: queryClient.invalidated,
    };
    const result = await restoreBackup({
      profiles: [{ ...ana, headers: { steal: 'this' } }, offline],
      data: { 'resonus.language': 'de', 'resonus.sortPrefs': '{}' },
      skipped: 3,
    });
    assert.deepEqual(result, { added: 1, existing: 1, entries: 2, skipped: 3 });
    assert.equal(storage.items.get('resonus.language'), 'de');
    const profiles = useAuthStore.getState().profiles;
    assert.deepEqual(profiles, [onPhone, offline], "the phone's copy of ana is untouched");
    assert.deepEqual(JSON.parse(storage.items.get('resonus.profiles') ?? '[]'), profiles);
    assert.equal(useSettings.getState().hydrations, before.settings + 1);
    assert.equal(usePins.getState().hydrations, before.pins + 1);
    assert.equal(useEqualizer.getState().hydrations, before.eq + 1);
    assert.equal(useSortPrefs.getState().hydrations, before.sort + 1);
    assert.equal(localQueries.favsCleared, before.favs + 1);
    assert.equal(localQueries.playlistsCleared, before.playlists + 1);
    assert.equal(queryClient.invalidated, before.queries + 1);
  });
});
