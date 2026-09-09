/**
 * `expo-file-system` (the object API) over a map in memory. Enough of
 * `File`, `Directory` and `Paths` for a module to write a file, read one
 * back and delete it; what the app "picks" is whatever a test put in
 * `fileSystem.pick` first.
 */
export const fileSystem = {
  /** Text by uri, for everything written through `File`. */
  files: new Map<string, string>(),
  /** What the next `File.pickFileAsync` answers with. */
  pick: null as { name: string; text: string } | null,
  reset(): void {
    this.files.clear();
    this.pick = null;
  },
};

export const Paths = {
  cache: 'file:///cache',
  document: 'file:///documents',
};

function join(base: string | { uri: string }, name: string): string {
  const root = typeof base === 'string' ? base : base.uri;
  return `${root.replace(/\/$/, '')}/${name}`;
}

export class Directory {
  readonly uri: string;

  constructor(base: string | Directory, name?: string) {
    this.uri = name === undefined ? (typeof base === 'string' ? base : base.uri) : join(base, name);
  }

  get exists(): boolean {
    return true;
  }

  create(_options?: { intermediates?: boolean }): void {}
}

export class File {
  readonly uri: string;

  constructor(base: string | Directory, name?: string) {
    this.uri = name === undefined ? (typeof base === 'string' ? base : base.uri) : join(base, name);
  }

  static async pickFileAsync(): Promise<{ canceled: true } | { canceled: false; result: File }> {
    const picked = fileSystem.pick;
    if (!picked) return { canceled: true };
    const file = new File('file:///picked', picked.name);
    fileSystem.files.set(file.uri, picked.text);
    return { canceled: false, result: file };
  }

  get exists(): boolean {
    return fileSystem.files.has(this.uri);
  }

  get size(): number | null {
    const text = fileSystem.files.get(this.uri);
    return text === undefined ? null : Buffer.byteLength(text);
  }

  create(_options?: { overwrite?: boolean }): void {
    if (!fileSystem.files.has(this.uri)) fileSystem.files.set(this.uri, '');
  }

  write(text: string): void {
    fileSystem.files.set(this.uri, text);
  }

  async text(): Promise<string> {
    const text = fileSystem.files.get(this.uri);
    if (text === undefined) throw new Error(`no such file: ${this.uri}`);
    return text;
  }

  delete(): void {
    fileSystem.files.delete(this.uri);
  }
}
