/**
 * `@/store/homeAssistant` as the three fields that make a webhook address.
 * The real one reaches for a house, a local HTTP server and a Cast session,
 * none of which a test of what is pushed has any use for.
 */
import { create } from 'zustand';

interface HomeAssistantState {
  enabled: boolean;
  url: string;
  token: string;
  webhookId: string;
}

export const useHomeAssistant = create<HomeAssistantState>(() => ({
  enabled: false,
  url: '',
  token: '',
  webhookId: '',
}));
