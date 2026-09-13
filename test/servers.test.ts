/**
 * Wrapping an id with the server it belongs to, and getting both back.
 *
 * This is the whole of what makes a search across several servers safe: an id
 * that loses its server is an id the wrong library is asked about, and the
 * answer to that is not an error but somebody else's track. So the round trip
 * is worth pinning down, ids with punctuation in them included — Subsonic
 * servers mint all sorts, and Navidrome's contain dashes while a proxy's
 * contain colons and slashes.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { authForKey, foreignId, foreignSource, otherServers, parseForeign, serverKey, serverLabel } from '@/lib/servers';
import { serverProfile, useAuthStore } from './stubs/store-auth';

const KEY = serverKey({ serverUrl: 'https://music.example', username: 'gaetan' });

describe('serverKey', () => {
  it('is the same for the same account', () => {
    assert.equal(serverKey({ serverUrl: 'https://music.example', username: 'gaetan' }), KEY);
  });

  it('tells two accounts on one server apart', () => {
    assert.notEqual(serverKey({ serverUrl: 'https://music.example', username: 'someone' }), KEY);
  });

  it('follows the profile rather than the address it is reached at', () => {
    // `scopeUrl` is what a profile is filed under once its address has been
    // edited, so reaching the same account through another URL has to give the
    // same key or everything it owns would look like somebody else's.
    const moved = serverKey({
      serverUrl: 'https://tailscale.example',
      scopeUrl: 'https://music.example',
      username: 'gaetan',
    });
    assert.equal(moved, KEY);
  });

  it('holds no part of the address, which travels further than it should', () => {
    assert.ok(!KEY.includes('music.example'));
    assert.ok(!KEY.includes('gaetan'));
  });
});

describe('foreignId', () => {
  it('gives back exactly what went in', () => {
    for (const id of ['42', 'al-1a2b3c', 'yt_abc|def', 'tr:12/34', '']) {
      assert.deepEqual(parseForeign(foreignId(KEY, id)), { key: KEY, id });
    }
  });

  it('leaves an id that is already wrapped alone', () => {
    const once = foreignId(KEY, 'song-1');
    assert.equal(foreignId(KEY, once), once);
  });

  it('says nothing about an ordinary id, which is most of them', () => {
    assert.equal(parseForeign('song-1'), null);
    assert.equal(parseForeign(undefined), null);
    // A file on a WebDAV share wears its own prefix and is not this.
    assert.equal(parseForeign('dav:s1|Music/a.mp3'), null);
  });

  it('refuses a prefix with no server in it rather than inventing one', () => {
    assert.equal(parseForeign('srv:no-separator'), null);
  });
});

/** Two servers signed in, the first of them the active one. */
function signedIn() {
  const mine = serverProfile({ serverUrl: 'https://music.example', urls: ['https://music.example'], username: 'gaetan' });
  const theirs = serverProfile({ serverUrl: 'https://other.example', urls: ['https://other.example'], username: 'gaetan' });
  useAuthStore.setState({ auth: mine, profiles: [mine, theirs], offline: false });
  return { mine, theirs };
}

describe('otherServers', () => {
  it('is empty with one server, which is what hides the whole feature', () => {
    const mine = serverProfile();
    useAuthStore.setState({ auth: mine, profiles: [mine], offline: false });
    assert.deepEqual(otherServers(), []);
  });

  it('leaves out the one signed in', () => {
    const { theirs } = signedIn();
    assert.deepEqual(otherServers().map((p) => p.username + '@' + p.serverUrl), [
      theirs.username + '@' + theirs.serverUrl,
    ]);
  });

  it('is empty when nobody is signed in, rather than every profile at once', () => {
    useAuthStore.setState({ auth: null, profiles: [serverProfile()], offline: false });
    assert.deepEqual(otherServers(), []);
  });
});

describe('foreignSource', () => {
  it('gives back the server and the id it knows the track by', () => {
    const { theirs } = signedIn();
    const wrapped = foreignId(serverKey(theirs), 'track-9');
    const found = foreignSource(wrapped);
    assert.equal(found?.id, 'track-9');
    assert.equal(found?.auth.serverUrl, 'https://other.example');
  });

  it('says nothing once that profile has been forgotten', () => {
    const { theirs } = signedIn();
    const wrapped = foreignId(serverKey(theirs), 'track-9');
    const active = useAuthStore.getState().auth;
    assert.ok(active);
    useAuthStore.setState({ profiles: [active] });
    assert.equal(foreignSource(wrapped), null);
    assert.equal(authForKey(serverKey(theirs)), undefined);
  });
});

describe('serverLabel', () => {
  it('is the host, which is what somebody typed', () => {
    const { theirs } = signedIn();
    assert.equal(serverLabel(theirs), 'other.example');
  });

  it('adds the username when two profiles share a host', () => {
    const one = serverProfile({ serverUrl: 'https://music.example', urls: ['https://music.example'], username: 'gaetan' });
    const two = serverProfile({ serverUrl: 'https://music.example', urls: ['https://music.example'], username: 'leo' });
    useAuthStore.setState({ auth: one, profiles: [one, two], offline: false });
    assert.equal(serverLabel(two), 'music.example (leo)');
  });
});
