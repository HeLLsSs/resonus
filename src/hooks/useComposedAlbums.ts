/**
 * The records an artist composed on, for the artist screen and its
 * discography.
 *
 * `getArtist` files a record under whoever performed it, so a composer's
 * screen came up with no albums at all when nothing in the library was theirs
 * as album artist, which for most composers is every record. The native list
 * has a filter for the credit; this asks it, only for an artist the server
 * says holds the credit and only where the native API is open (see
 * `canUseNative`), and on any other server answers with nothing.
 *
 * One query key for both screens, so "Show all" on the shelf opens on what the
 * shelf already had. Capped at a shelf's worth times ten rather than paged:
 * a composer with more records than that is one for the discography's own
 * list, and it reads the same cache.
 */
import { useQuery } from '@tanstack/react-query';

import { canUseNative, listAlbumsFiltered } from '@/api/navidrome';
import { type Album } from '@/api/subsonic';
import { useAuthStore } from '@/store/auth';
import { enabledFolderIds } from '@/store/libraries';

const COMPOSED_CAP = 200;

export function useComposedAlbums(artistId: string | undefined, composer: boolean) {
  const auth = useAuthStore((s) => s.auth);
  const offline = useAuthStore((s) => s.offline);
  return useQuery<Album[]>({
    queryKey: ['composerAlbums', artistId],
    queryFn: () =>
      canUseNative(auth) && artistId
        ? listAlbumsFiltered(
            auth,
            { composerId: artistId },
            'max_year',
            COMPOSED_CAP,
            0,
            enabledFolderIds(auth),
          )
        : Promise.resolve([]),
    enabled: !!artistId && composer && !offline && canUseNative(auth),
  });
}
