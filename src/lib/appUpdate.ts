/**
 * Updating Resonuls from inside Resonuls.
 *
 * The app is not on a store: it is an APK on GitHub, and whoever does not use
 * Obtainium finds out about a new version by going to look. Which means they
 * mostly don't, and reports keep arriving against versions fixed two releases
 * ago. So the app asks GitHub itself, a few times a day, and can fetch and hand
 * the APK to Android's installer.
 *
 * Two halves on purpose. Knowing there is an update costs nothing and is on by
 * default; installing one asks for a system permission and is only ever
 * reached by pressing Update.
 */
import Constants from 'expo-constants';
import { Directory, File, Paths } from 'expo-file-system';
import { requireOptionalNativeModule } from 'expo-modules-core';

import { getItem, setItem } from './storage';

const native = requireOptionalNativeModule<{
  canInstall: () => boolean;
  openInstallSettings: () => boolean;
  install: (fileUri: string) => boolean;
}>('ApkInstall');

const RELEASES_API = 'https://api.github.com/repos/HeLLsSs/resonus/releases/latest';
export const RELEASES_PAGE = 'https://github.com/HeLLsSs/resonus/releases/latest';

/**
 * Every six hours. It used to be a day, which sounds like plenty until you
 * notice what a day means to a music player: the process stays alive for as
 * long as Android lets it, so "once a day" was really "once, on the launch
 * after the last one expired", and someone who opens the app every morning to
 * press play could go a week without the question ever coming round. Six hours
 * lands at least once in a normal day's use, and it is still one request.
 */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const LAST_CHECK_KEY = 'update_last_check';

export interface Release {
  /** Without the leading `v`, to compare with the app's own version. */
  version: string;
  /** Where the APK is, or undefined for a release published without one. */
  apkUrl?: string;
  /** Bytes, for warning before spending them on mobile data. */
  size?: number;
  /** The release page, for when installing is not on the table. */
  pageUrl: string;
}

export function currentVersion(): string {
  return Constants.expoConfig?.version ?? '0.0.0';
}

/**
 * Semver order, enough for the tags this project publishes: `0.6.5`,
 * `0.6.5-beta.3`. Numbers compare as numbers, or `0.6.10` would sit below
 * `0.6.9`; a version with a prerelease tag sits BELOW the same version
 * without one, which is what makes 0.6.5 an update for someone on
 * 0.6.5-beta.3.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre] = v.replace(/^v/, '').split('-', 2);
    return { parts: core.split('.').map((n) => parseInt(n, 10) || 0), pre };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < Math.max(left.parts.length, right.parts.length); i++) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return comparePre(left.pre, right.pre);
}

/**
 * Two prerelease tags, `beta.3` against `beta.10`.
 *
 * Segment by segment, and a segment made of digits compares as a number, or
 * `beta.10` would sort below `beta.9` the way any two strings do. Nothing
 * reaches this today: `/releases/latest` never hands back a prerelease, so one
 * side of every comparison is a plain version. It is here for the day someone
 * adds a beta channel and does not think to look.
 */
function comparePre(a: string, b: string): -1 | 0 | 1 {
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i];
    const y = right[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    if (numeric) return Number(x) < Number(y) ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * The newest published release.
 *
 * `/releases/latest` leaves pre-releases out by itself, so the betas this
 * project publishes never reach anybody who did not go looking for them.
 *
 * Throws when GitHub could not be reached or refused (it rate-limits by IP,
 * and a phone behind a busy NAT can meet that). Not the same as finding
 * nothing, which is what `null` is for: telling someone they are on the latest
 * version when in fact nobody managed to ask is the one answer here that is
 * worse than no answer.
 */
async function fetchLatest(): Promise<Release | null> {
  const res = await fetch(RELEASES_API, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const body = (await res.json()) as {
    tag_name?: string;
    html_url?: string;
    assets?: { name?: string; browser_download_url?: string; size?: number }[];
  };
  const tag = body.tag_name;
  if (!tag) return null;
  const apk = body.assets?.find((a) => a.name?.endsWith('.apk'));
  return {
    version: tag.replace(/^v/, ''),
    apkUrl: apk?.browser_download_url,
    size: apk?.size,
    pageUrl: body.html_url ?? RELEASES_PAGE,
  };
}

/**
 * The release worth telling someone about, or null when this is already it.
 *
 * Throws if the asking failed, which the caller that has somebody waiting for
 * an answer needs to tell apart. `force` is the button in Settings; without it
 * the day's throttle applies and nobody is waiting.
 */
export async function checkForUpdate(force = false): Promise<Release | null> {
  if (!force) {
    const last = Number((await getItem(LAST_CHECK_KEY).catch(() => null)) ?? 0);
    if (Date.now() - last < CHECK_EVERY_MS) return null;
  }
  const latest = await fetchLatest();
  // Only a check that reached GitHub counts against the throttle: one that
  // failed on a dead network would otherwise buy silence for a whole day.
  if (latest) void setItem(LAST_CHECK_KEY, String(Date.now())).catch(() => {});
  if (!latest) return null;
  return compareVersions(latest.version, currentVersion()) > 0 ? latest : null;
}

/** Where the APK is downloaded to. Its own folder: the provider shares it. */
function updatesDir() {
  const dir = new Directory(Paths.cache, 'updates');
  dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/**
 * Downloads the APK, reporting progress from 0 to 1.
 *
 * The folder is emptied first: a cancelled or superseded download is 57 MB of
 * somebody's storage, and the only copy worth keeping is the one being
 * installed right now.
 */
export async function downloadApk(
  release: Release,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<string | null> {
  if (!release.apkUrl) return null;
  const dir = updatesDir();
  for (const entry of dir.list()) entry.delete();
  const file = await File.downloadFileAsync(release.apkUrl, dir, {
    signal,
    onProgress: ({ bytesWritten, totalBytes }) => {
      const total = totalBytes > 0 ? totalBytes : (release.size ?? 0);
      if (total > 0) onProgress(Math.min(1, bytesWritten / total));
    },
  });
  return file.uri;
}

/** Throws away whatever a previous run left behind. */
export function clearDownloadedApk(): void {
  try {
    const dir = new Directory(Paths.cache, 'updates');
    if (dir.exists) dir.delete();
  } catch {
    // Cache: the system clears it too, and failing to is not worth a word.
  }
}

/** Is installing possible at all on this build? */
export function canInstallApks(): boolean {
  return !!native;
}

/** Has the user granted "install unknown apps" to Resonuls? */
export function canInstallNow(): boolean {
  try {
    return native?.canInstall() ?? false;
  } catch {
    return false;
  }
}

/** Opens the system screen holding that toggle. */
export function openInstallSettings(): void {
  try {
    native?.openInstallSettings();
  } catch {
    // No such screen on this device: the release page is the way out.
  }
}

/** Hands the APK to Android's installer. False if nothing opened. */
export function installApk(fileUri: string): boolean {
  try {
    return native?.install(fileUri) ?? false;
  } catch {
    return false;
  }
}
