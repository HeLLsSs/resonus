/**
 * Lyrics on the car screen: with "Lyrics on the car screen" on and Android
 * Auto on the car's screen, the line being sung takes the artist's place on
 * its playback screen, and the artist moves one line down (`applyLyricLine`
 * in modules/car-auto). Synced lyrics only: plain ones have no line to be at.
 *
 * The lyrics are the ones the player already fetches as each song starts
 * (`prefetchLyrics`), read out of the query cache; nothing is fetched here
 * that the lyrics card would not have fetched. It runs once a second while
 * music plays and the setting is on, and not at all otherwise.
 */
import { type SongLyrics } from '@/api/subsonic';
import { carAutoAvailable, setLyricLine } from '@/lib/carAuto';
import { lineAt } from '@/lib/lrc';
import { queryClient } from '@/lib/query';
import { isAndroidAutoConnected } from '@/lib/rideMode';
import { currentSong, usePlayerStore } from '@/store/player';
import { useSettings } from '@/store/settings';

/** How often the line is looked at. */
const TICK_MS = 1_000;

/**
 * How early a line goes up: the car takes a moment to redraw, and a line
 * that arrives as it is being sung reads as late.
 */
const LEAD_MS = 600;

/**
 * The shortest time between two lines sent: each is a whole new state for
 * the car to draw, and a quick run of short lines is better skipped to the
 * last of them than sent one by one.
 */
const MIN_GAP_MS = 2_000;

/** How often Android Auto being on the car's screen is asked again. */
const CAR_CHECK_MS = 10_000;

let timer: ReturnType<typeof setInterval> | undefined;
let sent: string | null = null;
let sentAt = 0;
let carOn = false;
let carCheckedAt = 0;

function show(line: string | null): void {
  if (line === sent) return;
  if (line !== null && Date.now() - sentAt < MIN_GAP_MS) return;
  sent = line;
  sentAt = Date.now();
  setLyricLine(line);
}

function tick(): void {
  if (Date.now() - carCheckedAt > CAR_CHECK_MS) {
    carOn = isAndroidAutoConnected();
    carCheckedAt = Date.now();
  }
  const state = usePlayerStore.getState();
  const song = currentSong(state);
  if (!carOn || !song) {
    show(null);
    return;
  }
  const lyrics = queryClient.getQueryData<SongLyrics | null>([
    'lyrics',
    song.id,
    useSettings.getState().lyricsSource,
  ]);
  show(lyrics?.synced ? lineAt(lyrics.lines, state.positionSec * 1000 + LEAD_MS) : null);
}

/** Starts or stops the ticking, to match the setting and the music playing. */
function sync(): void {
  const wanted = useSettings.getState().carLyrics && usePlayerStore.getState().isPlaying;
  if (wanted === !!timer) return;
  if (wanted) {
    carCheckedAt = 0;
    timer = setInterval(tick, TICK_MS);
    return;
  }
  clearInterval(timer);
  timer = undefined;
  // Paused, the line stays where it was; turned off, it goes.
  if (!useSettings.getState().carLyrics) show(null);
}

export function startCarLyrics(): void {
  if (!carAutoAvailable) return;
  usePlayerStore.subscribe((state, prev) => {
    if (state.isPlaying !== prev.isPlaying) sync();
    // A new song starts with no line until its first one comes.
    if (state.index !== prev.index || state.queue !== prev.queue) {
      sentAt = 0;
      show(null);
    }
  });
  useSettings.subscribe((state, prev) => {
    if (state.carLyrics !== prev.carLyrics) sync();
  });
  sync();
}
