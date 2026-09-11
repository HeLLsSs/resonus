/**
 * Which of the saved tabs this profile can actually use.
 *
 * The bar is the user's list (Settings › Appearance › Navigation bar), and
 * until now every tab on it worked everywhere: what a profile has behind Home
 * or Search is different, but it has something. YouTube is the first one that
 * can be behind nothing at all — it is the Navifind proxy answering for a
 * YouTube account, and a server with no proxy in front of it has no such tab,
 * not even an empty one.
 *
 * So the list keeps the tab, saved and off by default like any other, and this
 * is what everything drawing the list asks first: the two bars, and the screen
 * that reorders them. It is here rather than in the bar because there are
 * three of those and they would each have grown the same exception.
 */
import { type TabSegment } from '@/lib/tabOrigin';

/** A row of the saved list, as everything here needs to read it. The list
 *  itself belongs to the settings store. */
export interface TabToggle {
  key: TabSegment;
  enabled: boolean;
}

/** The tabs this profile has something behind, kept or not. `proxy` is whether
 *  the Navifind switch is on for it. */
export function usableTabs<T extends TabToggle>(tabs: T[], proxy: boolean): T[] {
  return tabs.filter((tab) => tab.key !== 'youtube' || proxy);
}

/** And of those, the ones the user kept: what a bar draws, in their order. */
export function shownTabs<T extends TabToggle>(tabs: T[], proxy: boolean): T[] {
  return usableTabs(tabs, proxy).filter((tab) => tab.enabled);
}

/**
 * A drag in the list of usable tabs, said in the full list's terms.
 *
 * The reorder screen only shows what is usable, so its indices are the short
 * list's; what gets saved is the long one. A tab nobody can see keeps its slot
 * in the saved list and the rest move around it, so turning the proxy on later
 * brings it back where it was left rather than at the end.
 */
export function reorderUsable<T extends TabToggle>(
  all: T[],
  proxy: boolean,
  from: number,
  to: number,
): T[] {
  const usable = usableTabs(all, proxy);
  if (from < 0 || to < 0 || from >= usable.length || to >= usable.length) return all;
  const moved = usable.slice();
  const [taken] = moved.splice(from, 1);
  moved.splice(to, 0, taken);
  const shown = new Set(usable.map((tab) => tab.key));
  let next = 0;
  return all.map((tab) => (shown.has(tab.key) ? moved[next++] : tab));
}
