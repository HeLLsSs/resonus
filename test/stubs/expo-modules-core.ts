/**
 * `expo-modules-core` with one native module on offer, `IntentsApi`, which a
 * test drives by hand: commands go in through `emit`, and every state
 * broadcast the app sends comes out in `sent`.
 */
type Command = Record<string, string | number | boolean>;

export const intentsApi = {
  /** What `takePending` hands back on the next call. */
  pending: [] as Command[],
  /** Every state the app broadcast, oldest first. */
  sent: [] as Record<string, unknown>[],
  listeners: [] as ((command: Command) => void)[],
  /** A broadcast arriving from another app. */
  emit(command: Command): void {
    for (const cb of this.listeners) cb(command);
  },
  takePending(): Command[] {
    const out = this.pending;
    this.pending = [];
    return out;
  },
  async sendState(state: Record<string, unknown>): Promise<void> {
    this.sent.push(state);
  },
  addListener(_event: 'command', cb: (command: Command) => void): { remove: () => void } {
    this.listeners.push(cb);
    return { remove: () => this.listeners.splice(this.listeners.indexOf(cb), 1) };
  },
};

export function requireOptionalNativeModule<T>(name: string): T | null {
  return name === 'IntentsApi' ? (intentsApi as unknown as T) : null;
}
