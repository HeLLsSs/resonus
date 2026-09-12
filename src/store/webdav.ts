/**
 * WebDAV shares, as places to browse and play from.
 *
 * A share is not a library: there is no catalogue, no scan, nothing read
 * through the phone before it can be used. The folders are the library, which
 * is what makes it work the day it is added rather than after somebody's whole
 * collection has been walked over a network.
 *
 * **The password is a credential.** It lives in the secure store, never in the
 * settings blob, never in a log, and never in an address: the player is handed
 * an `Authorization` header instead, so the URL that reaches the media session
 * — and from there every app that can read it — carries nothing.
 */
import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';

import { getItem, setItem } from '@/lib/storage';
import { parsePropfind, sortEntries, type DavEntry } from '@/lib/webdav';

/** A share as it is kept: everything but the password. */
export interface DavSource {
  /** Ours, so a share can be renamed or moved without losing its password. */
  id: string;
  /** What it is called in the app. */
  name: string;
  /** The folder the share opens on, without a trailing slash. */
  url: string;
  user: string;
}

interface WebdavState {
  sources: DavSource[];
  hydrated: boolean;
}

const KEY = 'resonus.webdav';
const secretKey = (id: string) => `resonus.webdav.${id}`;

export const useWebdav = create<WebdavState>(() => ({ sources: [], hydrated: false }));

export async function hydrateWebdav(): Promise<void> {
  try {
    const raw = await getItem(KEY);
    const sources = raw ? (JSON.parse(raw) as DavSource[]) : [];
    useWebdav.setState({ sources: Array.isArray(sources) ? sources : [], hydrated: true });
  } catch {
    useWebdav.setState({ sources: [], hydrated: true });
  }
}

/** The password for a share, from the secure store. */
export async function passwordFor(id: string): Promise<string | undefined> {
  try {
    return (await SecureStore.getItemAsync(secretKey(id))) ?? undefined;
  } catch {
    return undefined;
  }
}

/** What a request to this share has to carry. Basic, which is what every
 *  WebDAV server speaks and what Nextcloud's app passwords are made for. */
export async function authHeaderFor(id: string): Promise<Record<string, string>> {
  const source = useWebdav.getState().sources.find((s) => s.id === id);
  const password = await passwordFor(id);
  if (!source || !password) return {};
  return { Authorization: `Basic ${basic(source.user, password)}` };
}

/**
 * A Basic credential, base64 of `user:password`.
 *
 * `btoa` is the runtime's own, and it only knows bytes: a password with an
 * accent in it would throw. The pair is turned into UTF-8 bytes first, so a
 * password is whatever somebody actually typed rather than whatever survives
 * being latin-1.
 */
export function basic(user: string, password: string): string {
  const utf8 = unescape(encodeURIComponent(`${user}:${password}`));
  return globalThis.btoa(utf8);
}

/** Adds a share, or replaces one of the same id. The password goes to the
 *  secure store and nowhere else. */
export async function saveSource(source: DavSource, password: string): Promise<void> {
  await SecureStore.setItemAsync(secretKey(source.id), password);
  const rest = useWebdav.getState().sources.filter((s) => s.id !== source.id);
  const sources = [...rest, source];
  useWebdav.setState({ sources });
  await setItem(KEY, JSON.stringify(sources)).catch(() => {});
}

/** Forgets a share, password included. */
export async function forgetSource(id: string): Promise<void> {
  await SecureStore.deleteItemAsync(secretKey(id)).catch(() => {});
  const sources = useWebdav.getState().sources.filter((s) => s.id !== id);
  useWebdav.setState({ sources });
  await setItem(KEY, JSON.stringify(sources)).catch(() => {});
}

/** Where a share's folder lives, given the path walked from its root. */
export function urlFor(source: DavSource, path: string): string {
  const base = source.url.replace(/\/+$/, '');
  if (!path) return base;
  return `${base}/${path.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
}

/**
 * What is in a folder of a share, folders first.
 *
 * Throws on anything that is not a listing — a refused password, a folder that
 * is not there, a server that did not answer — because the screen asking has
 * something to say about each of those and nothing to show for any of them.
 */
export async function listFolder(source: DavSource, path: string): Promise<DavEntry[]> {
  const url = urlFor(source, path);
  const headers = await authHeaderFor(source.id);
  const res = await fetch(`${url}/`, {
    method: 'PROPFIND',
    headers: { ...headers, Depth: '1', 'Content-Type': 'application/xml' },
  });
  if (!res.ok && res.status !== 207) throw new Error(String(res.status));
  const xml = await res.text();
  // The href the server echoes is a path from its root, not the full address.
  const self = new URL(`${url}/`).pathname;
  return sortEntries(parsePropfind(xml, self));
}

/** Whether a share answers at all, for the screen that adds one. */
export async function testSource(source: DavSource, password: string): Promise<boolean> {
  try {
    const res = await fetch(`${source.url.replace(/\/+$/, '')}/`, {
      method: 'PROPFIND',
      headers: {
        Authorization: `Basic ${basic(source.user, password)}`,
        Depth: '0',
        'Content-Type': 'application/xml',
      },
    });
    return res.ok || res.status === 207;
  } catch {
    return false;
  }
}
