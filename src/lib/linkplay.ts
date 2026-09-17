/**
 * LinkPlay speakers, WiiM among them, over their own HTTP API.
 *
 * A WiiM Mini has no Chromecast; what it has is an HTTP API on the speaker
 * itself (`httpapi.asp?command=…`), the one its own app uses: hand it a URL,
 * ask it where it is, pause it, move it, set its volume. And its multiroom:
 * one speaker plays and the others follow it in time, joined and left one at
 * a time. All of that is here, as commands and as the reading of what comes
 * back, kept pure so it can be tested without a speaker.
 *
 * The wire itself is the native module (`modules/linkplay`): the speaker only
 * answers over HTTPS with a certificate of LinkPlay's own that nothing else
 * would accept, and it announces itself by mDNS, which the system does best.
 *
 * Nothing here knows about the queue or the player store; that is
 * `store/linkplay.ts`.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

interface NativeLinkPlay {
  discover(timeoutMs: number): Promise<{ name: string; host: string; port: number }[]>;
  call(host: string, command: string): Promise<string>;
  startPolling(host: string, intervalMs: number): Promise<void>;
  stopPolling(): Promise<void>;
  addListener(event: 'status', listener: (e: { host: string; body?: string; error?: string }) => void): { remove: () => void };
}

const native = requireOptionalNativeModule<NativeLinkPlay>('LinkPlay');

export function linkPlayAvailable(): boolean {
  return native !== null;
}

/** How long a search listens for speakers announcing themselves. */
export const DISCOVER_MS = 3_000;

export class LinkPlayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinkPlayError';
  }
}

/** A speaker, as its own status describes it. */
export interface LinkPlayDevice {
  /** Its address on the network, which is what every command is sent to. */
  host: string;
  name: string;
  /** `WiiM_AMP`, `WiiM_Mini`…: the model, as the firmware names it. */
  model: string;
  uuid: string;
  /** In a multiroom group, following another speaker. */
  slave: boolean;
  /** Typed in by hand rather than found: kept across searches. */
  manual?: boolean;
}

/** Where a speaker is, as one poll reads it. */
export interface LinkPlayStatus {
  state: 'play' | 'pause' | 'stop' | 'load' | 'none';
  positionSec: number;
  durationSec: number;
  /** 0..1 */
  volume: number;
  muted: boolean;
}

/** A speaker following the one polled, as the leader lists it. */
export interface LinkPlaySlave {
  name: string;
  host: string;
}

// ── Reading answers ───────────────────────────────────────────────────────

/**
 * A device out of `getStatusEx`. Null for an answer that is not one: the
 * API answers something to almost anything, and only a status with a name
 * is a speaker.
 */
export function deviceFrom(host: string, raw: unknown): LinkPlayDevice | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.DeviceName === 'string' ? r.DeviceName.trim() : '';
  if (!name) return null;
  return {
    host,
    name,
    model: typeof r.project === 'string' ? r.project : '',
    uuid: typeof r.uuid === 'string' ? r.uuid : '',
    // `group` is "1" on a speaker that follows another one; `master_uuid`
    // names which. Either says the same thing.
    slave: String(r.group ?? '0') === '1' || (typeof r.master_uuid === 'string' && r.master_uuid !== ''),
  };
}

/** Where a speaker is, out of `getPlayerStatus`. Positions come in milliseconds, volume in percent. */
export function statusFrom(raw: unknown): LinkPlayStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const state = String(r.status ?? 'none');
  const ms = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n / 1000 : 0;
  };
  const vol = Number(r.vol);
  return {
    state: state === 'play' || state === 'pause' || state === 'stop' || state === 'load' ? state : 'none',
    positionSec: ms(r.curpos),
    durationSec: ms(r.totlen),
    volume: Number.isFinite(vol) ? Math.max(0, Math.min(1, vol / 100)) : 0,
    muted: String(r.mute ?? '0') === '1',
  };
}

/** The speakers following this one, out of `multiroom:getSlaveList`. */
export function slavesFrom(raw: unknown): LinkPlaySlave[] {
  if (!raw || typeof raw !== 'object') return [];
  const list = (raw as { slave_list?: unknown }).slave_list;
  if (!Array.isArray(list)) return [];
  const out: LinkPlaySlave[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    if (typeof s.ip !== 'string' || !s.ip) continue;
    out.push({ name: typeof s.name === 'string' && s.name ? s.name : s.ip, host: s.ip });
  }
  return out;
}

/** Some fields come hex-encoded (`Title`, `Artist`): "556E6B6E6F776E" is "Unknown". */
export function fromHex(value: string): string {
  if (!/^[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0) return value;
  let out = '';
  for (let i = 0; i < value.length; i += 2) out += String.fromCharCode(parseInt(value.slice(i, i + 2), 16));
  try {
    return decodeURIComponent(escape(out));
  } catch {
    return out;
  }
}

/** An address as somebody typed it: a host or an IP, nothing else. */
export function cleanHost(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/[/:].*$/, '');
}

// ── Commands ──────────────────────────────────────────────────────────────

export const cmd = {
  status: 'getStatusEx',
  player: 'getPlayerStatus',
  /** Plays this URL now, whatever was playing. */
  play: (url: string) => `setPlayerCmd:play:${url}`,
  pause: 'setPlayerCmd:pause',
  resume: 'setPlayerCmd:resume',
  stop: 'setPlayerCmd:stop',
  seek: (sec: number) => `setPlayerCmd:seek:${Math.max(0, Math.round(sec))}`,
  /** 0..1 in, percent out. */
  volume: (level: number) => `setPlayerCmd:vol:${Math.round(Math.max(0, Math.min(1, level)) * 100)}`,
  slaves: 'multiroom:getSlaveList',
  /**
   * Sent to the speaker that is to follow, naming the one to follow: from
   * then on it plays what the leader plays, in time with it.
   */
  join: (leaderHost: string) => `ConnectMasterAp:JoinGroupMaster:eth${leaderHost}:wifi0.0.0.0`,
  /** Sent to the leader: this follower is on its own again. */
  kick: (followerHost: string) => `multiroom:SlaveKickout:${followerHost}`,
  /** Sent to the leader: every follower is on its own again. */
  ungroup: 'multiroom:Ungroup',
} as const;

// ── The wire ──────────────────────────────────────────────────────────────

async function call(host: string, command: string): Promise<string> {
  if (!native) throw new LinkPlayError('LinkPlay is not available on this platform');
  try {
    return await native.call(host, command);
  } catch (e) {
    throw new LinkPlayError(e instanceof Error ? e.message : String(e));
  }
}

/** A command whose answer is JSON, parsed; one whose answer is "OK" comes back as is. */
export async function ask(host: string, command: string): Promise<unknown> {
  const text = await call(host, command);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.trim();
  }
}

/** The speakers announcing themselves on the network, each read for its name and model. */
export async function discover(): Promise<{ name: string; host: string }[]> {
  if (!native) return [];
  try {
    const found = await native.discover(DISCOVER_MS);
    const seen = new Set<string>();
    return found.filter((f) => {
      if (seen.has(f.host)) return false;
      seen.add(f.host);
      return true;
    });
  } catch {
    return [];
  }
}

/**
 * Asks the speaker where it is every `intervalMs`, from native code, so the
 * asking goes on with the screen locked (JavaScript timers do not). Each
 * answer, or the failure to get one, comes to `onStatus`; the return value
 * stops the asking.
 */
export function watchStatus(
  host: string,
  intervalMs: number,
  onStatus: (status: LinkPlayStatus | null, error?: string) => void,
): () => void {
  if (!native) return () => {};
  const sub = native.addListener('status', (e) => {
    if (e.host !== host) return;
    if (e.error !== undefined || e.body === undefined) {
      onStatus(null, e.error ?? 'No answer');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(e.body) as unknown;
    } catch {
      parsed = null;
    }
    onStatus(statusFrom(parsed), parsed === null ? 'Not a status' : undefined);
  });
  void native.startPolling(host, intervalMs);
  return () => {
    sub.remove();
    void native.stopPolling();
  };
}

/** One speaker, by address: what it says it is, or null when nothing there answers as one. */
export async function describe(host: string): Promise<LinkPlayDevice | null> {
  try {
    return deviceFrom(host, await ask(host, cmd.status));
  } catch {
    return null;
  }
}
