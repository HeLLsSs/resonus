/**
 * `@/lib/localLibrary`: only `hashKey`, which names per-profile storage keys.
 * Not the app's hash but a readable one, so a wrong key shows up in a
 * failure as the scope it was made from rather than as six digits.
 */
export function hashKey(s: string): string {
  return Buffer.from(s).toString('hex');
}
