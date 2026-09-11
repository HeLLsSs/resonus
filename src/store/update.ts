/**
 * The state of "there is a newer Resonuls than this one".
 *
 * A store rather than component state because two places drive it: the check
 * that runs by itself on startup, and the button in Settings › About. Both end
 * at the same prompt, so the prompt has to live somewhere neither of them owns.
 *
 * The mechanics (GitHub, the download, the installer) are in
 * `src/lib/appUpdate.ts`; what is here is the order things happen in.
 */
import { Linking } from 'react-native';
import { create } from 'zustand';

import { tg } from '@/i18n';
import {
  canInstallApks,
  canInstallNow,
  checkForUpdate,
  downloadApk,
  installApk,
  openInstallSettings,
  RELEASES_PAGE,
  type Release,
} from '@/lib/appUpdate';
import { useToast } from './toast';

/**
 * - `offered`: the prompt is up, nothing has been downloaded.
 * - `permission`: the system's "install unknown apps" screen is open and we
 *   are waiting to be told the answer, which only arrives as the app coming
 *   back to the foreground (see `UpdatePrompt`).
 * - `downloading`: 57 MB with a progress bar and a way out.
 */
export type UpdatePhase = 'idle' | 'offered' | 'permission' | 'downloading';

/** Outside the state: cancelling is not something anything renders. */
let abort: AbortController | null = null;

interface UpdateState {
  phase: UpdatePhase;
  release: Release | null;
  /** 0 to 1 while downloading. */
  progress: number;
  /** A check somebody is waiting for, so the button can say it is working. */
  checking: boolean;
  /**
   * `ok` is whether GitHub answered at all, which is not the same as finding
   * nothing: a button that says "you're on the latest version" because the
   * request failed is worse than one that admits it could not look.
   */
  check: (force?: boolean) => Promise<{ ok: boolean; release: Release | null }>;
  /** Pressing Update: permission first, then the download. */
  start: () => void;
  /** Called when the system screen has been answered, either way. */
  resume: () => void;
  /** Dismissing the prompt or cancelling a download: both end here. */
  close: () => void;
}

export const useUpdate = create<UpdateState>((set, get) => ({
  phase: 'idle',
  release: null,
  progress: 0,
  checking: false,

  check: async (force = false) => {
    if (get().checking) return { ok: false, release: null };
    set({ checking: true });
    try {
      const release = await checkForUpdate(force);
      // A download already running outranks the news that started it.
      if (release && get().phase === 'idle') set({ release, phase: 'offered' });
      return { ok: true, release };
    } catch {
      return { ok: false, release: null };
    } finally {
      set({ checking: false });
    }
  },

  start: () => {
    const release = get().release;
    // No APK on the release, or a build without the native module: the release
    // page still does the job, one tap further away.
    if (!release?.apkUrl || !canInstallApks()) {
      set({ phase: 'idle' });
      void Linking.openURL(release?.pageUrl ?? RELEASES_PAGE);
      return;
    }
    // Asked before the download, not after: whoever is going to say no should
    // say it before spending 57 MB of somebody's data plan.
    if (!canInstallNow()) {
      set({ phase: 'permission' });
      openInstallSettings();
      return;
    }
    void download(set, get);
  },

  resume: () => {
    if (get().phase !== 'permission') return;
    if (canInstallNow()) {
      void download(set, get);
      return;
    }
    // Came back without granting it. Not an error and not worth a dialog: the
    // prompt goes away and the release page is in Settings › About.
    set({ phase: 'idle' });
    useToast.getState().show(tg('Installing updates needs permission'));
  },

  close: () => {
    // Aborting is a no-op when nothing is downloading, which is what lets one
    // method answer both the prompt and the progress bar.
    abort?.abort();
    abort = null;
    set({ phase: 'idle', progress: 0 });
  },
}));

/**
 * Fetch and hand over. The installer is the system's, and it asks again on its
 * own screen, so this ends the moment it opens: whether the update goes
 * through is between it and the user.
 */
async function download(
  set: (partial: Partial<UpdateState>) => void,
  get: () => UpdateState,
): Promise<void> {
  const release = get().release;
  if (!release) return;
  abort = new AbortController();
  const signal = abort.signal;
  set({ phase: 'downloading', progress: 0 });
  try {
    const uri = await downloadApk(release, (progress) => set({ progress }), signal);
    if (!uri) throw new Error('no apk in the release');
    set({ phase: 'idle', progress: 0 });
    if (!installApk(uri)) {
      useToast.getState().show(tg("Couldn't open the installer"));
      void Linking.openURL(release.pageUrl);
    }
  } catch {
    set({ phase: 'idle', progress: 0 });
    // Cancelling comes through here too, and somebody who just pressed Cancel
    // does not need to be told what they did.
    if (!signal.aborted) useToast.getState().show(tg("Couldn't download the update"));
  } finally {
    abort = null;
  }
}
