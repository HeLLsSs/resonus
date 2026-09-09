/**
 * JS ↔ `HomeWidget` native module bridge (the Android home-screen widget).
 *
 * The widget draws itself from the last state pushed here: the launcher
 * redraws it on its own, app running or not, and its buttons talk to the
 * media session directly. JS only has to keep the picture current.
 *
 * The one thing that comes back is a tap on one of the queue rows of the
 * tall widget, which the media session has no key for: a `jump` event while
 * the app is alive, or a note left for it to collect when it was not
 * (`takePendingHomeWidgetJump`).
 *
 * On platforms without the module (web, iOS) everything is a no-op.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

const native = requireOptionalNativeModule('HomeWidget');

export const homeWidgetAvailable = !!native;

/** How many songs after the current one the tall widget can show. */
export const HOME_WIDGET_UPCOMING = 3;

export interface HomeWidgetUpcoming {
  id: string;
  title: string;
  artist?: string;
}

export interface HomeWidgetState {
  title?: string;
  artist?: string;
  /** http(s) or file://; anything else is drawn as the placeholder. */
  artworkUrl?: string;
  isPlaying: boolean;
  /** The current song's place in the queue: the rows count up from it. */
  index?: number;
  /** The next songs of the queue, at most `HOME_WIDGET_UPCOMING`. */
  upcoming?: HomeWidgetUpcoming[];
}

/** A queue row tapped: the song it showed and where it sat in the queue. */
export interface HomeWidgetJump {
  index: number;
  id: string;
}

export function updateHomeWidget(state: HomeWidgetState): void {
  // Nothing waits on it: the widget is a picture somewhere else, and the
  // player must not be held up by the system drawing it.
  void native?.update(JSON.stringify(state));
}

export function onHomeWidgetJump(cb: (e: HomeWidgetJump) => void): { remove: () => void } | undefined {
  return native?.addListener('jump', cb);
}

/** The row tapped while the app was closed, if any; read once and cleared. */
export function takePendingHomeWidgetJump(): HomeWidgetJump | null {
  return (native?.takePendingJump() as HomeWidgetJump | null | undefined) ?? null;
}
