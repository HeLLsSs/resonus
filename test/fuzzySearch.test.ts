/**
 * What counts as close enough to what somebody typed: how far a word may sit
 * from another, what a query is cut back to for a second try at the server,
 * and what the library answers with when the server found nothing.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Song } from '@/api/subsonic';
import { broadenQuery, fuzzyLibrary, nameScore, queryWords, slackFor, within } from '@/lib/fuzzySearch';

function song(id: string, title: string, artist: string, album = 'An Album'): Song {
  return {
    id,
    title,
    artist,
    album,
    artistId: `ar-${artist.toLowerCase().replace(/\W+/g, '')}`,
    albumId: `al-${album.toLowerCase().replace(/\W+/g, '')}`,
  };
}

describe('within', () => {
  it('is nothing between a word and itself', () => {
    assert.equal(within('muse', 'muse', 2), 0);
  });

  it('counts a letter typed wrong', () => {
    assert.equal(within('muse', 'muso', 2), 1);
  });

  it('counts two letters swapped as one slip', () => {
    assert.equal(within('beatels', 'beatles', 2), 1);
  });

  it('gives up on a word that is too far', () => {
    assert.equal(within('muse', 'metallica', 2), null);
  });

  it('gives up on a length difference it cannot close', () => {
    assert.equal(within('abc', 'abcdef', 2), null);
  });

  it('allows nothing at all when it is given no slack', () => {
    assert.equal(within('abc', 'abd', 0), null);
  });
});

describe('slackFor', () => {
  it('gives a short word no slack, where one edit reaches too far', () => {
    assert.equal(slackFor('the'), 0);
  });

  it('gives a middling word one', () => {
    assert.equal(slackFor('nirvana'.slice(0, 5)), 1);
  });

  it('gives a long word two', () => {
    assert.equal(slackFor('metallica'), 2);
  });
});

describe('queryWords', () => {
  it('folds the accents off and splits on the spaces', () => {
    assert.deepEqual(queryWords('  Édith   Piaf '), ['edith', 'piaf']);
  });
});

describe('nameScore', () => {
  it('scores a name typed exactly above one only reached', () => {
    const exact = nameScore('Beatles', ['beatles']);
    const slipped = nameScore('Beatles', ['beatels']);
    assert.ok(exact !== null && slipped !== null && exact < slipped);
  });

  it('answers for a word only started, as the server does', () => {
    assert.notEqual(nameScore('Metallica', ['metal']), null);
  });

  it('wants every word typed to find one, as the server does', () => {
    assert.equal(nameScore('Daft Punk', ['daft', 'elvis']), null);
  });

  it('finds a word wherever it sits in the name', () => {
    assert.notEqual(nameScore('The Rolling Stones', ['stones']), null);
  });

  it('says nothing for a name nothing in it was meant for', () => {
    assert.equal(nameScore('Daft Punk', ['metallica']), null);
  });

  it('puts the shorter of two matching names first', () => {
    const short = nameScore('Muse', ['muse']);
    const long = nameScore('Muse Of The Something', ['muse']);
    assert.ok(short !== null && long !== null && short < long);
  });
});

describe('broadenQuery', () => {
  it('cuts a long word back to its opening letters', () => {
    assert.equal(broadenQuery('Beatels'), 'beat');
  });

  it('keeps only the longest word, since every word has to match', () => {
    assert.equal(broadenQuery('the metalica'), 'meta');
  });

  it('leaves a short word alone: what is left would match everything', () => {
    assert.equal(broadenQuery('muse'), null);
  });

  it('asks nothing of an empty query', () => {
    assert.equal(broadenQuery('   '), null);
  });
});

describe('fuzzyLibrary', () => {
  const library = [
    song('1', 'Come Together', 'The Beatles', 'Abbey Road'),
    song('2', 'Something', 'The Beatles', 'Abbey Road'),
    song('3', 'Enter Sandman', 'Metallica', 'Metallica'),
  ];

  it('finds the artist behind a name typed wrong', () => {
    const found = fuzzyLibrary(library, 'Beatels');
    assert.deepEqual(
      found.artists.map((a) => a.name),
      ['The Beatles'],
    );
  });

  it('finds the album of a misspelled artist', () => {
    const found = fuzzyLibrary(library, 'Abey Road');
    assert.deepEqual(
      found.albums.map((a) => a.name),
      ['Abbey Road'],
    );
  });

  it('finds a song by its title typed wrong', () => {
    const found = fuzzyLibrary(library, 'Enter Sandmen');
    assert.deepEqual(
      found.songs.map((s) => s.id),
      ['3'],
    );
  });

  it('offers the closest name as a correction', () => {
    assert.equal(fuzzyLibrary(library, 'Beatels').suggestion, 'The Beatles');
  });

  it('offers no correction for a name already spelled right', () => {
    assert.equal(fuzzyLibrary(library, 'Metallica').suggestion, undefined);
  });

  it('answers with nothing for a name the library has never held', () => {
    const found = fuzzyLibrary(library, 'Stockhausen');
    assert.equal(found.artists.length + found.albums.length + found.songs.length, 0);
  });

  it('names each artist once, however many songs they have', () => {
    assert.equal(fuzzyLibrary(library, 'Beatles').artists.length, 1);
  });
});
