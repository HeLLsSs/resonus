/** `@/lib/exportSong`: the one call the playlist export makes, counted. */
export const exportSong = { cleared: 0 };

export function clearExportCache(): void {
  exportSong.cleared++;
}
