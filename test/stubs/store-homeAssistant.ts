/**
 * `@/store/homeAssistant` as the three fields that make a webhook address,
 * and the two calls the `output` intent makes, written down instead of made.
 * The real one reaches for a house, a local HTTP server and a Cast session,
 * none of which a test of what is pushed or asked has any use for.
 */
import { create } from 'zustand';

import type { HaPlayer } from '../../src/lib/homeAssistant';

interface HomeAssistantState {
  enabled: boolean;
  url: string;
  token: string;
  webhookId: string;
  connected: boolean;
  entityId: string | null;
}

export const useHomeAssistant = create<HomeAssistantState>(() => ({
  enabled: false,
  url: '',
  token: '',
  webhookId: '',
  connected: false,
  entityId: null,
}));

export const ha = {
  /** What `haPlayerById` answers, by entity id. */
  players: new Map<string, HaPlayer>(),
  /** Every player `haConnect` was handed. */
  connected: [] as HaPlayer[],
  reset(): void {
    this.players.clear();
    this.connected = [];
  },
};

export async function haPlayerById(entityId: string): Promise<HaPlayer | null> {
  return ha.players.get(entityId) ?? null;
}

export async function haConnect(player: HaPlayer): Promise<boolean> {
  ha.connected.push(player);
  return true;
}
