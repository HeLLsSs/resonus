/**
 * `@/store/auth` cut down to the session: who is signed in, the saved
 * profiles, and offline or not. `profileScopeId` is the app's own rule,
 * restated here because the real store cannot load without the phone.
 */
import { create } from 'zustand';

import { primaryUrl } from '../../src/lib/serverUrls';
import type { Profile, ServerProfile } from '../../src/store/auth';

export type { OfflineProfile, OfflineSource, Profile, ServerProfile } from '../../src/store/auth';

interface AuthState {
  auth: ServerProfile | null;
  profiles: Profile[];
  offline: boolean;
  hydrating: boolean;
}

export const useAuthStore = create<AuthState>(() => ({
  auth: null,
  profiles: [],
  offline: false,
  hydrating: false,
}));

export function profileScopeId(): string {
  const { auth, offline } = useAuthStore.getState();
  if (auth) return `${primaryUrl(auth)}|${auth.username}`;
  return offline ? 'local' : 'default';
}

/** A signed-in server profile with sensible defaults. */
export function serverProfile(overrides: Partial<ServerProfile> = {}): ServerProfile {
  return {
    _type: 'server',
    serverUrl: 'https://music.example',
    username: 'ana',
    urls: ['https://music.example'],
    token: 'tok',
    salt: 'salty',
    ...overrides,
  };
}
