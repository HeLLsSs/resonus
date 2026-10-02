/**
 * The ride screen's two shortcuts to music with no list to read: a word
 * said into the helmet, and the one radio station chosen in the settings.
 *
 * The voice goes through the phone's own speech dialog (Google's, on most
 * phones), which records and hands back the words; nothing here listens on
 * its own, and the app carries no microphone permission for it. What comes
 * back is either one of a few commands, in French or English whichever the
 * phone speaks, or a search: the songs found play, the first one now.
 *
 * The other way round too: the status read out when the intercom connects
 * (the battery, where the music goes, what is left of the queue), and again
 * on asking for it.
 */
import { getRadioStations } from '@/api/subsonic';
import { getStarred, search } from '@/api/data';
import { tg, type TFunction } from '@/i18n';
import { playShuffle } from '@/lib/playShuffle';
import { batteryState, listen, speak, type BatteryEvent } from '@/lib/rideMode';
import { applyTransport } from '@/lib/transport';
import { useAuthStore } from '@/store/auth';
import { currentOutput, SOURCE_FAVORITES, usePlayerStore } from '@/store/player';
import { useRideMode } from '@/store/rideMode';

/** How many of the songs a search finds go into the queue. */
const SEARCH_QUEUE_SIZE = 50;

export type VoiceCommand =
  | { kind: 'toggle' | 'next' | 'previous' | 'favorites' | 'random' | 'radio' | 'status' }
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
  ['status', ['status', 'statut', 'état', 'battery', 'batterie']],
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

/** What the status read out in the helmet is made of. */
export interface RideStatus {
  /** Nothing when the system has not said yet. */
  battery: BatteryEvent | null;
  /** The output's name; empty for the phone itself, which goes without saying. */
  output: string;
  /** Songs after the one playing; nothing for an empty queue. */
  remaining: number | null;
}

/**
 * The status as one sentence: the battery, the output when it is not the
 * phone, and how many songs are left. Short, since it is said over the
 * music at the start of a ride, and the pieces come in that order because
 * the battery is what the rider can do something about.
 */
export function statusSentence({ battery, output, remaining }: RideStatus, t: TFunction = tg): string {
  const parts: string[] = [];
  if (battery) {
    parts.push(
      battery.charging
        ? t('battery at {n} %, charging', { n: battery.level })
        : t('battery at {n} %', { n: battery.level }),
    );
  }
  if (output) parts.push(t('playing on {output}', { output }));
  if (remaining === null) parts.push(t('nothing in the queue'));
  else if (remaining === 0) parts.push(t('last song of the queue'));
  else if (remaining === 1) parts.push(t('one song left in the queue'));
  else parts.push(t('{n} songs left in the queue', { n: remaining }));
  return `${parts.join(', ')}.`;
}

/** The status as it is now, read off the phone, the player and the output. */
export function rideStatus(): RideStatus {
  const { queue, index } = usePlayerStore.getState();
  return {
    battery: batteryState(),
    output: currentOutput().name,
    remaining: queue.length === 0 ? null : Math.max(0, queue.length - index - 1),
  };
}

/** Says the status in the helmet, on asking for it. */
export function speakStatus(): void {
  speak(statusSentence(rideStatus()));
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
    case 'next':
    case 'previous':
      applyTransport(command.kind);
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
    case 'status':
      speakStatus();
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
