/** `@/lib/playShuffle`: counted, not played. */
export const playShuffleCalls = { count: 0 };

export async function playShuffle(): Promise<void> {
  playShuffleCalls.count++;
}
