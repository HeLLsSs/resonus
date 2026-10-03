/** Which liked songs are handed to the proxy on a run of the liked import. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fileKey, likedToSend, MAX_PER_RUN, pruneSent, RESEND_AFTER_MS } from '@/lib/likedImport';

const NOW = 100 * RESEND_AFTER_MS;

const song = (id: string, artist = 'Daft Punk', title = `Song ${id}`) => ({ id, artist, title });

describe('likedToSend', () => {
  it('keeps the YouTube songs, in the order YouTube gave them', () => {
    assert.deepEqual(likedToSend([song('yt_b'), song('sc_1'), song('al-9'), song('yt_a')], [], {}, NOW), ['yt_b', 'yt_a']);
  });

  it('leaves out a song the proxy has filed under the same name', () => {
    const filed = ['Daft Punk - Da Funk'];
    assert.deepEqual(likedToSend([song('yt_a', 'Daft Punk', 'Da Funk'), song('yt_b')], filed, {}, NOW), ['yt_b']);
  });

  it('matches the name as the proxy writes it on disk', () => {
    const filed = ['ac_dc - back in black_ live'];
    assert.deepEqual(likedToSend([song('yt_a', 'AC/DC', 'Back In Black: Live')], filed, {}, NOW), []);
  });

  it('does not ask again for a song handed over within the week', () => {
    const sent = { yt_a: NOW - RESEND_AFTER_MS + 1, yt_b: NOW - RESEND_AFTER_MS };
    assert.deepEqual(likedToSend([song('yt_a'), song('yt_b')], [], sent, NOW), ['yt_b']);
  });

  it('sends each song once', () => {
    assert.deepEqual(likedToSend([song('yt_a'), song('yt_a')], [], {}, NOW), ['yt_a']);
  });

  it('stops at the most a run sends', () => {
    const liked = Array.from({ length: MAX_PER_RUN + 5 }, (_, i) => song(`yt_${i}`));
    assert.equal(likedToSend(liked, [], {}, NOW).length, MAX_PER_RUN);
  });
});

describe('fileKey', () => {
  it('names a song with no artist as the proxy does', () => {
    assert.equal(fileKey(undefined, 'Intro'), 'inconnu - intro');
  });
});

describe('pruneSent', () => {
  it('forgets what was handed over long enough ago', () => {
    assert.deepEqual(pruneSent({ yt_old: NOW - RESEND_AFTER_MS, yt_new: NOW - 1 }, NOW), { yt_new: NOW - 1 });
  });
});
