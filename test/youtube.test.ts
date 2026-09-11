/** What a YouTube tile leads to, what the proxy's refusals mean, and what it
 *  says about the account it is signed in with. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type Song, type YoutubeCard, type YoutubeShelf } from '@/api/subsonic';
import {
  accountRefusal,
  cardTarget,
  cleanAuthUser,
  cleanCookie,
  FIRST_ACCOUNT,
  hasSapisid,
  MUSIC_ORIGIN,
  openableShelves,
  readAccount,
  saveFailure,
  SIGN_IN_URL,
  signedIn,
} from '@/lib/youtube';

const card = (over: Partial<YoutubeCard>): YoutubeCard => ({ title: 'Something', ...over });

const song = (id: string): Song => ({ id, title: id });

const shelf = (over: Partial<YoutubeShelf>): YoutubeShelf => ({
  title: 'Shelf',
  items: [],
  songs: [],
  ...over,
});

describe('cardTarget', () => {
  it('opens a playlist by its playlist id', () => {
    const target = cardTarget(card({ type: 'playlist', playlistId: 'PL123', browseId: 'VLPL123' }));
    assert.deepEqual(target, { kind: 'playlist', id: 'PL123' });
  });

  it('takes the browse prefix off when the playlist id is all there is', () => {
    const target = cardTarget(card({ type: 'playlist', browseId: 'VLPL123' }));
    assert.deepEqual(target, { kind: 'playlist', id: 'PL123' });
  });

  it('prefers a record’s playlist id to the page its browse id names', () => {
    const target = cardTarget(card({ type: 'album', browseId: 'MPREb_x', playlistId: 'OLAK5uy_y' }));
    assert.deepEqual(target, { kind: 'playlist', id: 'OLAK5uy_y' });
  });

  it('plays a video as the track the proxy files it under', () => {
    const target = cardTarget(card({ type: 'video', videoId: 'abc' }));
    assert.deepEqual(target, { kind: 'song', id: 'yt_abc' });
  });

  it('leads nowhere for an artist or a channel, which nothing here can open', () => {
    assert.equal(cardTarget(card({ type: 'artist', browseId: 'UC1' })), null);
    assert.equal(cardTarget(card({ type: 'channel', browseId: 'UC1' })), null);
  });

  it('leads nowhere when the id that would open it is missing', () => {
    assert.equal(cardTarget(card({ type: 'playlist' })), null);
    assert.equal(cardTarget(card({ type: 'video' })), null);
  });
});

describe('openableShelves', () => {
  it('drops the tiles that lead nowhere and keeps the rest in place', () => {
    const [row] = openableShelves([
      shelf({
        items: [
          card({ type: 'playlist', playlistId: 'a' }),
          card({ type: 'artist', browseId: 'UC1' }),
          card({ type: 'playlist', playlistId: 'b' }),
        ],
      }),
    ]);
    assert.deepEqual(
      row.items.map((item) => item.playlistId),
      ['a', 'b'],
    );
  });

  it('drops a shelf that had nothing else on it', () => {
    const rows = openableShelves([shelf({ items: [card({ type: 'artist', browseId: 'UC1' })] })]);
    assert.deepEqual(rows, []);
  });

  it('keeps a shelf of tracks whole: every one of them can be played', () => {
    const rows = openableShelves([shelf({ songs: [song('yt_1'), song('yt_2')] })]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].songs.length, 2);
  });
});

describe('accountRefusal', () => {
  it('tells an account nobody configured from a session that has run out', () => {
    assert.equal(accountRefusal({ code: 101 }), 'none');
    assert.equal(accountRefusal({ code: 100 }), 'expired');
  });

  it('says nothing about anything else that went wrong', () => {
    assert.equal(accountRefusal({ code: 70 }), null);
    assert.equal(accountRefusal(new Error('offline')), null);
    assert.equal(accountRefusal(undefined), null);
  });
});

describe('readAccount', () => {
  it('takes the three things the proxy says about its account', () => {
    const account = readAccount({ source: 'stored', state: 'ok', name: 'Camille' });
    assert.deepEqual(account, { source: 'stored', state: 'ok', name: 'Camille' });
  });

  it('keeps an expired session apart from an account that was never given', () => {
    assert.equal(readAccount({ source: 'env', state: 'expired' }).state, 'expired');
    assert.equal(readAccount({ source: 'none', state: 'none' }).state, 'none');
  });

  it('has no name when the proxy could not read one', () => {
    assert.equal(readAccount({ source: 'env', state: 'ok', name: '  ' }).name, undefined);
    assert.equal(readAccount({ source: 'env', state: 'ok' }).name, undefined);
  });

  it('treats a word it does not know, or no answer at all, as a proxy to ask again', () => {
    const unknown = readAccount({ source: 'elsewhere', state: 'signed-in' });
    assert.equal(unknown.state, 'unreachable');
    assert.equal(unknown.source, 'none');
    assert.equal(readAccount(undefined).state, 'unreachable');
  });
});

describe('saveFailure', () => {
  it('tells a cookie YouTube refused from a YouTube nobody could reach', () => {
    assert.equal(saveFailure({ code: 100 }), 'refused');
    assert.equal(saveFailure({ code: 0 }), 'youtube');
  });

  it('blames neither when the proxy itself never got that far', () => {
    assert.equal(saveFailure({ code: 70 }), 'proxy');
    assert.equal(saveFailure(new Error('Network error (404)')), 'proxy');
  });
});

describe('cleanCookie', () => {
  it('takes off the header name that comes with a whole copied line', () => {
    assert.equal(cleanCookie('Cookie: SID=a; SAPISID=b'), 'SID=a; SAPISID=b');
    assert.equal(cleanCookie('cookie:SID=a'), 'SID=a');
  });

  it('unwraps a paste the browser put in quotes', () => {
    assert.equal(cleanCookie('"cookie: SID=a; HSID=b"'), 'SID=a; HSID=b');
    assert.equal(cleanCookie("'SID=a'"), 'SID=a');
  });

  it('closes up the line breaks a panel wrapped the header at', () => {
    assert.equal(cleanCookie('SID=a;\n  HSID=b;\n\tSSID=c'), 'SID=a; HSID=b; SSID=c');
  });

  it('drops the space and the semicolon left at either end', () => {
    assert.equal(cleanCookie('  SID=a; HSID=b;  '), 'SID=a; HSID=b');
  });

  it('leaves a quote that is only on one side where it is', () => {
    assert.equal(cleanCookie('SID=a"b'), 'SID=a"b');
  });
});

describe('hasSapisid', () => {
  it('recognises the pair a signed request is signed with', () => {
    assert.equal(hasSapisid('SID=a; SAPISID=b; HSID=c'), true);
    assert.equal(hasSapisid('__Secure-3PAPISID=b'), true);
  });

  it('refuses something shorter than the whole header', () => {
    assert.equal(hasSapisid('SID=a; HSID=b'), false);
    assert.equal(hasSapisid('APISID=b'), false);
    assert.equal(hasSapisid('SAPISID='), false);
    assert.equal(hasSapisid(''), false);
  });
});

describe('cleanAuthUser', () => {
  it('keeps the number out of whatever the header was copied as', () => {
    assert.equal(cleanAuthUser('X-Goog-AuthUser: 2'), '2');
    assert.equal(cleanAuthUser(' 1 '), '1');
  });

  it('means the first account when nothing was typed', () => {
    assert.equal(cleanAuthUser(''), FIRST_ACCOUNT);
    assert.equal(cleanAuthUser('none'), FIRST_ACCOUNT);
    assert.equal(FIRST_ACCOUNT, '0');
  });
});

describe('signedIn', () => {
  /** A jar as it is once YouTube has a session in it: shortened, but carrying
   *  the pair every signed request is signed with. */
  const session = 'VISITOR_INFO1_LIVE=x; SID=a; HSID=b; SAPISID=c';

  it('is over on YouTube Music with a session in the jar', () => {
    assert.equal(signedIn('https://music.youtube.com/', session), true);
    assert.equal(signedIn('https://music.youtube.com', session), true);
    assert.equal(signedIn('https://music.youtube.com/?cbrd=1', session), true);
  });

  it('is not over on the pages the sign-in goes through on the way', () => {
    const onTheWay = `${SIGN_IN_URL}&hl=en`;
    assert.equal(signedIn(onTheWay, session), false);
    assert.equal(signedIn('https://accounts.google.com/signin/challenge', session), false);
    assert.equal(signedIn('https://consent.youtube.com/m?continue=x', session), false);
    assert.equal(signedIn('https://www.youtube.com/', session), false);
  });

  it('is not over on a host that only reads like YouTube Music', () => {
    assert.equal(signedIn('https://music.youtube.com.example.org/', session), false);
    assert.equal(signedIn('https://notmusic.youtube.com/', session), false);
    assert.equal(signedIn('http://music.youtube.com/', session), false);
  });

  it('is not over while the jar carries no session, however far the page got', () => {
    // Google sets plenty on the way in, and none of it signs a request: a jar
    // without SAPISID is a page that has arrived and an account that has not.
    assert.equal(signedIn('https://music.youtube.com/', 'VISITOR_INFO1_LIVE=x; YSC=y'), false);
    assert.equal(signedIn('https://music.youtube.com/', 'SID=a; HSID=b'), false);
    assert.equal(signedIn('https://music.youtube.com/', ''), false);
    assert.equal(signedIn('https://music.youtube.com/', null), false);
    assert.equal(signedIn('https://music.youtube.com/', undefined), false);
  });

  it('starts on Google’s own page and ends on the host whose jar is read', () => {
    assert.ok(SIGN_IN_URL.startsWith('https://accounts.google.com/'));
    // `service=youtube` is what makes Google hand out YouTube's own cookies
    // rather than only google.com's, so the jar that is read has something in
    // it at the end.
    assert.ok(SIGN_IN_URL.includes('service=youtube'));
    assert.ok(SIGN_IN_URL.includes(encodeURIComponent(`${MUSIC_ORIGIN}/`)));
    assert.equal(signedIn(`${MUSIC_ORIGIN}/`, session), true);
  });
});
