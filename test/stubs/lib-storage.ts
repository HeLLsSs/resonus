/**
 * `@/lib/storage` over a map. A test reads and writes `storage.items` to
 * seed a key or to see what a store wrote; `storage.failing` makes every
 * read throw, which is what a broken KeyStore looks like.
 */
export const storage = {
  items: new Map<string, string>(),
  failing: false,
  reset(): void {
    this.items.clear();
    this.failing = false;
  },
};

export async function getItem(key: string): Promise<string | null> {
  if (storage.failing) throw new Error('KeyStore unavailable');
  return storage.items.get(key) ?? null;
}

export async function setItem(key: string, value: string): Promise<void> {
  storage.items.set(key, value);
}

export async function deleteItem(key: string): Promise<void> {
  storage.items.delete(key);
}
