/** `@/lib/localQueries`: the two caches a restore empties, counted. */
export const localQueries = { favsCleared: 0, playlistsCleared: 0 };

export function clearLocalFavs(): void {
  localQueries.favsCleared++;
}

export function clearLocalPlaylists(): void {
  localQueries.playlistsCleared++;
}
