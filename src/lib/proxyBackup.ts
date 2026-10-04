/**
 * The decisions behind the settings kept on the Navifind proxy, with nothing
 * in them that needs a phone: what is taken out before the copy leaves, what
 * is put back from this phone when the copy comes in, and whether the
 * settings in memory are still the ones a fresh install starts with. The
 * part that talks to the proxy is `lib/proxyBackupSync.ts`.
 */

/**
 * Field names that sign in somewhere: a profile's token, salt or password, its
 * proxy headers, a ListenBrainz token. `lib/backup.ts` already leaves these
 * out when asked to; this is the second look, made on whatever it produced,
 * so that a secret added to a blob later does not ride along by default.
 */
const SECRET_FIELD = /token|password|secret|cookie|salt|^headers$/i;

/** The ListenBrainz user goes with its token: the app treats the pair as one. */
const PAIRED_FIELDS = ['listenBrainzUser'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSecret(key: string): boolean {
  return SECRET_FIELD.test(key) || PAIRED_FIELDS.includes(key);
}

function withoutSecrets(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !isSecret(key)));
}

/**
 * A backup payload as it may be kept on the proxy: every profile and every
 * JSON-object blob without a field that signs in. A blob that is not a JSON
 * object (the language, an array of smart playlists) is left as it is.
 */
export function stripSecrets<T extends { profiles: unknown[]; data: Record<string, string> }>(payload: T): T {
  const data: Record<string, string> = {};
  for (const [key, raw] of Object.entries(payload.data)) {
    try {
      const parsed: unknown = JSON.parse(raw);
      data[key] = isRecord(parsed) ? JSON.stringify(withoutSecrets(parsed)) : raw;
    } catch {
      data[key] = raw;
    }
  }
  const profiles = payload.profiles.map((p) => (isRecord(p) ? withoutSecrets(p) : p));
  return { ...payload, profiles, data };
}

/**
 * A blob from the proxy with this phone's secrets put back into it: the copy
 * never has them, and writing it as it is would sign this phone out of
 * ListenBrainz on every restore.
 */
export function withLocalSecrets(incoming: string, local: string | null): string {
  if (!local) return incoming;
  try {
    const into: unknown = JSON.parse(incoming);
    const from: unknown = JSON.parse(local);
    if (!isRecord(into) || !isRecord(from)) return incoming;
    for (const [key, value] of Object.entries(from)) if (isSecret(key)) into[key] = value;
    return JSON.stringify(into);
  } catch {
    return incoming;
  }
}

/**
 * Settings that say nothing about the install: the store's own bookkeeping,
 * the language (chosen at first launch, global), and the two switches that
 * have to be on for the proxy to be reached at all.
 */
const NOT_A_CHOICE = new Set(['hydrated', 'language', 'navifind', 'backupToProxy']);

/**
 * Whether the settings in memory are still factory ones, which is what a
 * fresh install looks like: the one case where offering the proxy's copy can
 * only add, and not overwrite something somebody chose on this phone.
 */
export function settingsAreDefault(current: object, defaults: object): boolean {
  const now = current as Record<string, unknown>;
  for (const [key, value] of Object.entries(defaults)) {
    if (typeof value === 'function' || NOT_A_CHOICE.has(key)) continue;
    if (JSON.stringify(now[key]) !== JSON.stringify(value)) return false;
  }
  return true;
}
