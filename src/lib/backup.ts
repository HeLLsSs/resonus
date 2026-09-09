/**
 * Backup and restore of what the app knows that is not music: the profiles
 * and every preference kept under them (Settings › Backup & restore).
 *
 * One JSON file, made of two parts. `profiles` is the saved account list as
 * `store/auth` keeps it, minus everything that signs in: no token, salt or
 * password ever leaves the phone, so a restored profile asks to be signed
 * into again. The custom headers go only when asked for, since a proxy in
 * front of the server may be passed its secret that way. `data` is the raw
 * storage under each key worth carrying over, copied as the string it is on
 * disk: the stores already know how to read their own blobs, and a copy that
 * is not reinterpreted cannot be reinterpreted wrongly. SecureStore cannot
 * list its keys, so the two lists below are the whole of what is taken, and a
 * new per-profile key belongs here as much as it does in `lib/profileData.ts`.
 *
 * Per-profile keys hang off `hashKey('<primary url>|<user>')`, which is made of
 * fields the backup carries, so the same profile restored on another phone
 * lands its settings under the same name and finds them at once.
 *
 * On the way back in, a file is not trusted further than it has to be: each
 * blob is checked for the shape its store expects before it is written, and
 * a profile already on the phone is left exactly as it is. A file can add
 * profiles, not reach into one that is there, so a crafted file cannot send
 * an account's requests, or its headers, somewhere else.
 *
 * With a passphrase, `profiles` and `data` travel as one AES-GCM blob. The key
 * is a SHA-256 of the passphrase and a random salt, folded ten thousand times:
 * expo-crypto has no PBKDF2, and this stands in for it. It is a real cipher
 * with a modest key stretch, not a vault, and the screen says as much.
 */
import Constants from 'expo-constants';
import {
  AESEncryptionKey,
  AESSealedData,
  aesDecryptAsync,
  aesEncryptAsync,
  CryptoDigestAlgorithm,
  digest,
  getRandomBytes,
} from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { hashKey } from '@/lib/localLibrary';
import { clearLocalFavs, clearLocalPlaylists } from '@/lib/localQueries';
import { queryClient } from '@/lib/query';
import { primaryUrl } from '@/lib/serverUrls';
import { getItem, setItem } from '@/lib/storage';
import { type OfflineSource, type Profile, type ServerProfile, useAuthStore } from '@/store/auth';
import { useAutoDownloads } from '@/store/autoDownloads';
import { useEqualizer } from '@/store/equalizer';
import { usePins } from '@/store/pins';
import { useSettings } from '@/store/settings';
import { useSmartPlaylists } from '@/store/smartPlaylists';
import { useSortPrefs } from '@/store/sortPrefs';

/** The list `store/auth` keeps the profiles under; it is not exported there. */
const PROFILES_KEY = 'resonus.profiles';

/**
 * What a key's blob parses to. Each store casts what it reads without looking
 * (`JSON.parse(raw) as SmartPlaylist[]`), so a restored value of the wrong
 * shape is not a bad setting but a crash on the next hydrate; the language
 * is the one value kept as a bare string rather than JSON.
 */
type Shape = 'array' | 'object' | 'string';

/**
 * Preferences kept per profile, each stored as `<key>.<hash>`. The recents
 * (`resonus.lastPlayed`) and the size cache (`resonus.librarySizes`) are
 * left out: one is history and the other is remade on the next visit.
 */
const SCOPED_KEYS = new Map<string, Shape>([
  ['resonus.settings', 'object'],
  ['resonus.pins', 'object'],
  ['resonus.smartPlaylists', 'array'],
  ['resonus.autodl', 'object'],
  ['resonus.localFavorites', 'object'],
  ['resonus.localPlaylists', 'array'],
]);

/**
 * Preferences kept once for the phone. The bare `resonus.settings` is the
 * shared blob from before settings were per profile, which a profile with
 * none of its own still inherits from (see `store/settings`).
 */
const GLOBAL_KEYS = new Map<string, Shape>([
  ['resonus.settings', 'object'],
  ['resonus.language', 'string'],
  ['resonus.sortPrefs', 'object'],
  ['resonus.equalizer', 'object'],
  ['resonus.libraries', 'object'],
]);

/** The two scopes that are nobody's account: the local profile, and no session. */
const FIXED_SCOPES = ['local', 'default'];

const FORMAT_VERSION = 1;
const KDF_ITERATIONS = 10_000;
/** The most a file may ask for: the key stretch is a loop of digests, and an
 *  unbounded count would be a way of hanging the app with one number. */
const MAX_KDF_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const SALT_HEX = /^[0-9a-f]{32}$/i;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** What the file looks like on disk. */
interface BackupFile {
  version: number;
  app: string;
  createdAt: string;
  /** How many profiles are inside, in the clear even when the rest is not,
   *  so a file can be described before its passphrase is asked for. */
  count: number;
  profiles?: unknown;
  data?: unknown;
  encrypted?: { salt: string; iterations: number; sealed: string };
}

/** The half of a file that is restored, once readable. */
export interface BackupPayload {
  profiles: Profile[];
  data: Record<string, string>;
  /** Storage entries the file had that were not taken: an unknown key, or a
   *  blob that is not what its store would expect to read. */
  skipped: number;
}

/** One line of the list shown before a restore: who, where, and whether the
 *  phone already has it (in which case it is left alone). */
export interface ProfilePreview {
  label: string;
  existing: boolean;
}

/** What the screen shows about a picked file before anything is written. */
export interface BackupSummary {
  app: string;
  createdAt: string;
  count: number;
  encrypted: boolean;
}

export interface PickedBackup {
  summary: BackupSummary;
  /** Already readable, or null until `unlockBackup` is given the passphrase. */
  payload: BackupPayload | null;
  file: BackupFile;
}

export interface RestoreResult {
  added: number;
  /** Profiles the phone already had, left as they were. */
  existing: number;
  /** Storage entries written. */
  entries: number;
  skipped: number;
}

export type BackupErrorKind = 'invalid' | 'newer' | 'passphrase' | 'unreadable';

export class BackupError extends Error {
  constructor(public readonly kind: BackupErrorKind) {
    super(kind);
  }
}

function appVersion(): string {
  return Constants.expoConfig?.version ?? '';
}

function scopeOf(profile: ServerProfile): string {
  return `${primaryUrl(profile)}|${profile.username}`;
}

/**
 * The profile as it may leave the phone: everything that signs in stays, and
 * the headers go only when asked for. They are what a profile behind a proxy
 * shows it (`CF-Access-Client-Secret`, an `Authorization` of its own), which
 * is a password by another name.
 */
function exportable(profile: Profile, includeTokens: boolean): Profile {
  if (profile._type === 'offline') return profile;
  const { serverUrl, username, urls, scopeUrl, autoUrl, serverType, plainAuth, headers, jfUserId, jfDeviceId } =
    profile;
  return {
    _type: 'server',
    serverUrl,
    username,
    urls,
    scopeUrl,
    autoUrl,
    serverType,
    plainAuth,
    headers: includeTokens ? headers : undefined,
    jfUserId,
    jfDeviceId,
    token: '',
    salt: '',
  };
}

/**
 * The ListenBrainz token is the one secret inside a settings blob (see
 * `lib/listenBrainz.ts`); it goes only when asked for, under the same switch
 * as the headers. The user name goes with it, since the app treats the pair
 * as one thing.
 */
function withoutListenBrainz(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    delete parsed.listenBrainzToken;
    delete parsed.listenBrainzUser;
    return JSON.stringify(parsed);
  } catch {
    return raw;
  }
}

function isSettingsKey(key: string): boolean {
  return key === 'resonus.settings' || key.startsWith('resonus.settings.');
}

/** Reads one key, taking a KeyStore failure as "nothing there". */
async function read(key: string): Promise<string | null> {
  try {
    return await getItem(key);
  } catch {
    return null;
  }
}

async function collect(includeTokens: boolean): Promise<BackupPayload> {
  const profiles = useAuthStore.getState().profiles;
  const scopes = new Set(FIXED_SCOPES);
  for (const p of profiles) if (p._type === 'server') scopes.add(scopeOf(p));
  const keys = [...GLOBAL_KEYS.keys()];
  for (const scope of scopes) {
    const hash = hashKey(scope);
    for (const key of SCOPED_KEYS.keys()) keys.push(`${key}.${hash}`);
  }
  const data: Record<string, string> = {};
  for (const key of keys) {
    const raw = await read(key);
    if (raw === null) continue;
    data[key] = !includeTokens && isSettingsKey(key) ? withoutListenBrainz(raw) : raw;
  }
  return { profiles: profiles.map((p) => exportable(p, includeTokens)), data, skipped: 0 };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<AESEncryptionKey> {
  // Normalised so the same passphrase typed on two keyboards is the same bytes.
  const pass = new TextEncoder().encode(passphrase.normalize('NFKC'));
  let block = new Uint8Array(0);
  for (let i = 0; i < iterations; i++) {
    const input = new Uint8Array(block.length + salt.length + pass.length);
    input.set(block);
    input.set(salt, block.length);
    input.set(pass, block.length + salt.length);
    block = new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, input));
  }
  return AESEncryptionKey.import(block);
}

async function seal(payload: BackupPayload, passphrase: string): Promise<BackupFile['encrypted']> {
  const salt = getRandomBytes(SALT_BYTES);
  const key = await deriveKey(passphrase, salt, KDF_ITERATIONS);
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  const sealed = await aesEncryptAsync(plain, key);
  return { salt: toHex(salt), iterations: KDF_ITERATIONS, sealed: await sealed.combined('base64') };
}

function backupFileName(): string {
  const day = new Date().toISOString().slice(0, 10);
  return `resonus-backup-${day}.json`;
}

/**
 * Writes the backup to the cache and hands it to the share sheet. False when
 * the phone has nothing to share with, which is the one case the caller has
 * to say something about; a dismissed sheet is not a failure.
 */
export async function exportBackup(options: {
  includeTokens: boolean;
  passphrase: string;
}): Promise<boolean> {
  if (!(await Sharing.isAvailableAsync())) return false;
  const payload = await collect(options.includeTokens);
  const file: BackupFile = {
    version: FORMAT_VERSION,
    app: appVersion(),
    createdAt: new Date().toISOString(),
    count: payload.profiles.length,
  };
  if (options.passphrase) {
    file.encrypted = await seal(payload, options.passphrase);
  } else {
    file.profiles = payload.profiles;
    file.data = payload.data;
  }
  const dir = new Directory(Paths.cache, 'backup');
  if (!dir.exists) dir.create({ intermediates: true });
  const out = new File(dir, backupFileName());
  out.create({ overwrite: true });
  out.write(JSON.stringify(file));
  try {
    await Sharing.shareAsync(out.uri, { mimeType: 'application/json', UTI: 'public.json' });
  } finally {
    // The copy that matters is wherever the sheet sent it; the one in the
    // cache is the profiles in the clear, and has no business outliving it.
    try {
      out.delete();
    } catch {
      // Already gone, or the cache was cleared under it: nothing left to hide.
    }
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((v) => typeof v === 'string');
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * A profile as the file describes it, taken field by field: nothing a file
 * says about signing in is believed, so a restored server profile is always
 * one to sign into again. Null for anything that is not a profile.
 */
function readProfile(value: unknown): Profile | null {
  if (!isRecord(value)) return null;
  if (value._type === 'offline') {
    if (typeof value.name !== 'string' || !isRecord(value.source)) return null;
    const src = value.source;
    let source: OfflineSource;
    if (src.mode === 'device') source = { mode: 'device' };
    else if (src.mode === 'folder' && isStringArray(src.uris) && src.uris.length > 0)
      source = { mode: 'folder', uris: src.uris };
    else return null;
    return { _type: 'offline', name: value.name, source };
  }
  if (typeof value.serverUrl !== 'string' || typeof value.username !== 'string') return null;
  return {
    _type: 'server',
    serverUrl: value.serverUrl,
    username: value.username,
    urls: isStringArray(value.urls) && value.urls.length > 0 ? value.urls : [value.serverUrl],
    scopeUrl: optionalString(value.scopeUrl),
    autoUrl: optionalBoolean(value.autoUrl),
    serverType: optionalString(value.serverType),
    plainAuth: optionalBoolean(value.plainAuth),
    headers: isStringRecord(value.headers) ? value.headers : undefined,
    jfUserId: optionalString(value.jfUserId),
    jfDeviceId: optionalString(value.jfDeviceId),
    token: '',
    salt: '',
  };
}

/**
 * Only keys this module would have written are taken back: a file is not
 * allowed to put a session (`resonus.auth`) or a profile list on the phone,
 * and the profiles go through `readProfile` instead. Null for any other key.
 */
function shapeOf(key: string): Shape | null {
  const global = GLOBAL_KEYS.get(key);
  if (global) return global;
  const dot = key.lastIndexOf('.');
  if (dot === -1 || !/^[A-Za-z0-9_-]+$/.test(key.slice(dot + 1))) return null;
  return SCOPED_KEYS.get(key.slice(0, dot)) ?? null;
}

/** Whether a blob is what its store will cast it to, so writing it back
 *  cannot break the next hydrate. */
function fits(raw: string, shape: Shape): boolean {
  if (shape === 'string') return raw.length > 0;
  try {
    const parsed: unknown = JSON.parse(raw);
    return shape === 'array' ? Array.isArray(parsed) : isRecord(parsed);
  } catch {
    return false;
  }
}

function readPayload(profiles: unknown, data: unknown): BackupPayload {
  if (!Array.isArray(profiles) || !isRecord(data)) throw new BackupError('invalid');
  const out: Record<string, string> = {};
  let skipped = 0;
  for (const [key, value] of Object.entries(data)) {
    const shape = shapeOf(key);
    if (shape && typeof value === 'string' && fits(value, shape)) out[key] = value;
    else skipped++;
  }
  const kept: Profile[] = [];
  for (const p of profiles) {
    const profile = readProfile(p);
    if (profile) kept.push(profile);
  }
  return { profiles: kept, data: out, skipped };
}

function parseBackup(text: string): BackupFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BackupError('invalid');
  }
  if (!isRecord(parsed) || typeof parsed.version !== 'number') throw new BackupError('invalid');
  if (parsed.version > FORMAT_VERSION) throw new BackupError('newer');
  const enc = parsed.encrypted;
  let encrypted: BackupFile['encrypted'];
  if (enc !== undefined) {
    // Checked here so that a corrupt envelope is reported as the broken file
    // it is, and not as a wrong passphrase once the cipher fails to open it.
    const { salt, iterations, sealed }: Record<string, unknown> = isRecord(enc) ? enc : {};
    if (
      typeof salt !== 'string' ||
      !SALT_HEX.test(salt) ||
      typeof iterations !== 'number' ||
      !Number.isInteger(iterations) ||
      iterations < 1 ||
      iterations > MAX_KDF_ITERATIONS ||
      typeof sealed !== 'string' ||
      sealed.length % 4 !== 0 ||
      !BASE64.test(sealed)
    ) {
      throw new BackupError('invalid');
    }
    encrypted = { salt, iterations, sealed };
  }
  if (!encrypted && (!Array.isArray(parsed.profiles) || !isRecord(parsed.data))) {
    throw new BackupError('invalid');
  }
  return {
    version: parsed.version,
    app: optionalString(parsed.app) ?? '',
    createdAt: optionalString(parsed.createdAt) ?? '',
    count:
      typeof parsed.count === 'number'
        ? parsed.count
        : Array.isArray(parsed.profiles)
          ? parsed.profiles.length
          : 0,
    profiles: parsed.profiles,
    data: parsed.data,
    encrypted,
  };
}

/**
 * Opens the system picker and reads what was chosen. Null when the picker was
 * dismissed; a `BackupError` for a file that is not a backup, one from a newer
 * app, or one that could not be read at all.
 */
export async function pickBackup(): Promise<PickedBackup | null> {
  const picked = await File.pickFileAsync();
  if (picked.canceled) return null;
  let text: string;
  try {
    text = await picked.result.text();
  } catch {
    throw new BackupError('unreadable');
  }
  const file = parseBackup(text);
  const summary: BackupSummary = {
    app: file.app,
    createdAt: file.createdAt,
    count: file.count,
    encrypted: !!file.encrypted,
  };
  return {
    summary,
    payload: file.encrypted ? null : readPayload(file.profiles, file.data),
    file,
  };
}

/** Decrypts a passphrase-protected file. A wrong passphrase fails the GCM
 *  tag, which is the only way of telling and is reported as such. */
export async function unlockBackup(picked: PickedBackup, passphrase: string): Promise<BackupPayload> {
  const enc = picked.file.encrypted;
  if (!enc) throw new BackupError('invalid');
  let text: string;
  try {
    const key = await deriveKey(passphrase, fromHex(enc.salt), enc.iterations);
    const bytes = await aesDecryptAsync(AESSealedData.fromCombined(enc.sealed), key);
    text = new TextDecoder().decode(bytes);
  } catch {
    throw new BackupError('passphrase');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BackupError('invalid');
  }
  if (!isRecord(parsed)) throw new BackupError('invalid');
  return readPayload(parsed.profiles, parsed.data);
}

/** The same test `store/auth` uses to tell two profiles apart. */
function sameProfile(a: Profile, b: Profile): boolean {
  if (a._type === 'offline' && b._type === 'offline') return a.name === b.name;
  if (a._type === 'server' && b._type === 'server') {
    if (a.username !== b.username) return false;
    if (primaryUrl(a) === primaryUrl(b)) return true;
    const au = a.urls ?? [a.serverUrl];
    const bu = b.urls ?? [b.serverUrl];
    return au.some((u) => bu.includes(u));
  }
  return false;
}

function isOnPhone(profile: Profile): boolean {
  return useAuthStore.getState().profiles.some((p) => sameProfile(p, profile));
}

/**
 * The file's profiles as the screen lists them before anything is written:
 * `user @ server` for an account, the name for an offline one, and whether
 * the phone has it already.
 */
export function previewProfiles(payload: BackupPayload): ProfilePreview[] {
  return payload.profiles.map((p) => ({
    label: p._type === 'offline' ? p.name : `${p.username} @ ${primaryUrl(p)}`,
    existing: isOnPhone(p),
  }));
}

/**
 * Writes the file's storage entries and adds its profiles to the list, then
 * has every store that read one of those keys read it again, so the screens
 * show the restored preferences without a restart.
 *
 * A profile the phone already has is left untouched, addresses and headers
 * included: pooling them with the file's would let a file that names one
 * shared address point an account, or the secret in its headers, at a server
 * of its choosing. The phone's copy is the one that was signed into.
 */
export async function restoreBackup(payload: BackupPayload): Promise<RestoreResult> {
  let entries = 0;
  for (const [key, value] of Object.entries(payload.data)) {
    await setItem(key, value);
    entries++;
  }

  const profiles = [...useAuthStore.getState().profiles];
  let added = 0;
  let existing = 0;
  for (const incoming of payload.profiles) {
    if (profiles.some((p) => sameProfile(p, incoming))) {
      existing++;
    } else {
      profiles.push(incoming);
      added++;
    }
  }
  await setItem(PROFILES_KEY, JSON.stringify(profiles));
  // The list alone: the session, the offline flags and everything else in the
  // store are the phone's and were not in the file.
  useAuthStore.setState({ profiles });

  // Each of these reads its own key under the active profile, so the restored
  // values of every other profile wait on disk for that profile's turn. The
  // libraries filter (`store/libraries`) reads once per launch and is not
  // asked again: it is applied on the next start. The local favourites and
  // playlists are module caches keyed by profile that re-read on demand.
  await Promise.all([
    useSettings.getState().hydrate(),
    usePins.getState().hydrate(),
    useSmartPlaylists.getState().hydrate(),
    useAutoDownloads.getState().hydrate(),
    useSortPrefs.getState().hydrate(),
    useEqualizer.getState().hydrate(),
  ]);
  clearLocalFavs();
  clearLocalPlaylists();
  void queryClient.invalidateQueries();
  return { added, existing, entries, skipped: payload.skipped };
}
