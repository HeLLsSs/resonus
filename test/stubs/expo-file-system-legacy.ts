/**
 * `expo-file-system/legacy` over a map in memory: the handful of calls a
 * store makes to keep one JSON file per profile. `legacyFileSystem.files` is
 * what was written, by uri, and what a test seeds a file with.
 */
export const legacyFileSystem = {
  files: new Map<string, string>(),
  reset(): void {
    this.files.clear();
  },
};

export const documentDirectory = 'file:///documents/';

export async function makeDirectoryAsync(_uri: string, _options?: { intermediates?: boolean }): Promise<void> {}

export async function getInfoAsync(uri: string): Promise<{ exists: boolean; uri: string }> {
  return { exists: legacyFileSystem.files.has(uri), uri };
}

export async function readAsStringAsync(uri: string): Promise<string> {
  const text = legacyFileSystem.files.get(uri);
  if (text === undefined) throw new Error(`no such file: ${uri}`);
  return text;
}

export async function writeAsStringAsync(uri: string, text: string): Promise<void> {
  legacyFileSystem.files.set(uri, text);
}

export async function deleteAsync(uri: string, _options?: { idempotent?: boolean }): Promise<void> {
  legacyFileSystem.files.delete(uri);
}
