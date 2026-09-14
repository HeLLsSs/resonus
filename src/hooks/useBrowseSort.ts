/**
 * The order a Browse screen is showing, remembered between visits.
 *
 * The three Browse screens — Albums, Artists, Songs — ask the server for an
 * order rather than sorting a list they hold, so this keeps a field and no
 * direction. What it settles is the awkward part: these screens are reached
 * two ways, and the two mean different things.
 *
 * **From a Home shelf**, the address carries the order the shelf was showing:
 * "Most played albums" opens that list under that heading. That order wins for
 * the visit and is deliberately *not* saved — you asked for that shelf, not for
 * a new default. Remembering it would make the next shelf lie about its own
 * title, which is why this screen kept nothing at all until now.
 *
 * **From the menu**, with no order in the address, what you last chose applies.
 * And choosing one by hand is what saves it, under the same store every other
 * list uses (`store/sortPrefs`), so it travels in a backup with the rest.
 *
 * `allowed` is for the Songs screen, whose menu depends on what the server can
 * actually order by: a saved order the server no longer offers is dropped
 * rather than sent and refused.
 */
import { useCallback, useState } from 'react';

import { useSortPrefs, type BrowseSortField } from '@/store/sortPrefs';

export function useBrowseSort<T extends BrowseSortField>(
  key: string,
  fallback: T,
  fromShelf: T | undefined,
  allowed?: readonly T[],
): [T, (next: T) => void] {
  const stored = useSortPrefs((s) => s.prefs[key]?.field);
  const setPref = useSortPrefs((s) => s.setPref);
  // Captured on arrival, and state rather than a ref because it is read while
  // rendering: the shelf that opened this screen is a fact about this visit,
  // and it must not change under you if the saved order is written from
  // somewhere else while you are looking.
  const [shelf] = useState(fromShelf);
  // Once you have chosen here, the shelf has had its say.
  const [chosen, setChosen] = useState(false);

  const saved =
    stored !== undefined && (!allowed || allowed.includes(stored as T)) ? (stored as T) : undefined;
  const sort = !chosen && shelf !== undefined ? shelf : (saved ?? fallback);

  const choose = useCallback(
    (next: T) => {
      setChosen(true);
      // The default is the screen's own, not the global one: picking the order
      // a screen already opens in should leave nothing behind rather than be
      // written down as a preference.
      setPref(key, { field: next, dir: 'asc' }, { field: fallback, dir: 'asc' });
    },
    [key, fallback, setPref],
  );

  return [sort, choose];
}
