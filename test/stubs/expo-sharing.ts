/**
 * `expo-sharing`: whether there is a share sheet, and what was handed to it.
 * The file's text is copied at that moment, since the backup deletes its
 * copy as soon as the sheet closes.
 */
import { fileSystem } from './expo-file-system';

export const sharing = {
  available: true,
  /** Every uri shared, oldest first, with the text it held at the time. */
  shared: [] as { uri: string; text: string | undefined; options?: Record<string, unknown> }[],
  reset(): void {
    this.available = true;
    this.shared = [];
  },
};

export async function isAvailableAsync(): Promise<boolean> {
  return sharing.available;
}

export async function shareAsync(uri: string, options?: Record<string, unknown>): Promise<void> {
  sharing.shared.push({ uri, text: fileSystem.files.get(uri), options });
}
