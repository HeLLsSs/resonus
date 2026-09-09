/** `expo-document-picker`: the pick a test decides on beforehand. */
export interface PickedAsset {
  uri: string;
  name: string;
  size?: number;
}

export type PickResult = { canceled: true } | { canceled: false; assets: PickedAsset[] };

export const documentPicker = {
  /** What the next `getDocumentAsync` answers with. */
  next: { canceled: true } as PickResult,
};

export async function getDocumentAsync(_options?: unknown): Promise<PickResult> {
  return documentPicker.next;
}
