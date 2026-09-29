/**
 * The ride screen's two shortcuts to music with no list to read: a word
 * said into the helmet, and the one radio station chosen in the settings.
 *
 * The voice goes through the phone's own speech dialog (Google's, on most
 * phones), which records and hands back the words; nothing here listens on
 * its own, and the app carries no microphone permission for it. What comes
 * back is either one of a few commands, in French or English whichever the
 * phone speaks, or a search: the songs found play, the first one now.
 */
import { getRadioStations } from '@/api/subsonic';
import { getStarred, search } from '@/api/data';
import { tg } from '@/i18n';
import { playShuffle } from '@/lib/playShuffle';
import { listen, speak } from '@/lib/rideMode';
import { useAuthStore } from '@/store/auth';
import { SOURCE_FAVORITES, usePlayerStore } from '@/store/player';
import { useRideMode } from '@/store/rideMode';

/** How many of the songs a search finds go into the queue. */
const SEARCH_QUEUE_SIZE = 50;

export type VoiceCommand =
  | { kind: 'toggle' | 'next' | 'previous' | 'favorites' | 'random' | 'radio' }
  | { kind: 'search'; query: string }
  | { kind: 'nothing' };

/** The words that are a command rather than something to look for, by command. */
const COMMANDS: [VoiceCommand['kind'], string[]][] = [
  ['toggle', ['pause', 'play', 'lecture', 'stop']],
  ['next', ['next', 'skip', 'suivant', 'suivante']],
  ['previous', ['previous', 'back', 'précédent', 'précédente', 'precedent']],
  ['favorites', ['favorites', 'favourites', 'favoris', 'mes favoris']],
  ['random', ['shuffle', 'random', 'aléatoire', 'aleatoire', 'au hasard']],
  ['radio', ['radio', 'la radio']],
];

/**
 * What a phrase asks for. A command is the whole phrase, give or take the
 * case and the accents: "next" skips, "next to you" is a song to find.
 */
export function interpretCommand(said: string): VoiceCommand {
  const text = said
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (!text) return { kind: 'nothing' };
  for (const [kind, words] of COMMANDS) {
    if (words.some((w) => w.normalize('NFD').replace(/[\u0300-\u036f]/g, '') === text)) {
      return { kind } as VoiceCommand;
    }
  }
  return { kind: 'search', query: said.trim() };
}

/** Plays the station chosen in the settings, if there is one. False when there is none or it is gone. */
export async function playRideRadio(): Promise<boolean> {
  const { radioStationId } = useRideMode.getState().config;
  const auth = useAuthStore.getState().auth;
  if (!radioStationId || !auth) return false;
  const station = (await getRadioStations(auth)).find((s) => s.id === radioStationId);
  if (!station) return false;
  await usePlayerStore.getState().playQueue(
    [{ id: station.id, title: station.name, url: station.streamUrl, artist: tg('Radio'), coverArt: station.coverArt }],
    0,
    station.name,
    '/radio',
  );
  return true;
}

/**
 * Listens once and does what was said. What happened is said back through
 * the helmet: a search that found nothing would otherwise be silence, which
 * on a bike reads as the button not having worked.
 */
export async function listenAndPlay(): Promise<void> {
  const command = interpretCommand(await listen());
  const player = usePlayerStore.getState();
  switch (command.kind) {
    case 'nothing':
      return;
    case 'toggle':
      player.toggle();
      return;
    case 'next':
      player.next();
      return;
    case 'previous':
      player.previous();
      return;
    case 'favorites': {
      const { songs } = await getStarred();
      if (songs.length > 0) await player.playQueue(songs, 0, SOURCE_FAVORITES, '/favorites', { shuffled: true });
      return;
    }
    case 'random':
      await playShuffle();
      return;
    case 'radio':
      if (!(await playRideRadio())) speak(tg('No radio station chosen'));
      return;
    case 'search': {
      const found = await search(command.query);
      const songs = found.songs.slice(0, SEARCH_QUEUE_SIZE);
      if (songs.length === 0) {
        speak(tg('Nothing found for {query}', { query: command.query }));
        return;
      }
      await player.playQueue(songs, 0, command.query);
    }
  }
}
