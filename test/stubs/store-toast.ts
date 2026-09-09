/** `@/store/toast`: every message shown, oldest first. */
import { create } from 'zustand';

interface ToastState {
  messages: string[];
  show: (message: string, action?: { label: string; run: () => void }) => void;
  hide: () => void;
}

export const useToast = create<ToastState>((set) => ({
  messages: [],
  show: (message) => set((s) => ({ messages: [...s.messages, message] })),
  hide: () => {},
}));
