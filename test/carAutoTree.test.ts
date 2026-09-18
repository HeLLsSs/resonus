/**
 * The shape of the car's tabs: what a section is cut to, which headings
 * survive, which drawers of the Library are worth a row, and how a search
 * answers with the phone's rows and the library's as one list.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CarNode } from '@/lib/carAuto';
import { drawerLayout, overflowsHome, resumeFraction, searchRows, shelfId, tabLayout } from '@/lib/carAutoLayout';

function row(id: string, title = id): CarNode {
  return { id, title, playable: true };
}

describe('resumeFraction', () => {
  it('is the share of the song already heard', () => {
    assert.equal(resumeFraction(30_000, 120), 0.25);
  });

  it('says nothing when the song has no duration to measure against', () => {
    assert.equal(resumeFraction(30_000, undefined), undefined);
    assert.equal(resumeFraction(30_000, 0), undefined);
  });

  it('says nothing for a resume point at the very start', () => {
    assert.equal(resumeFraction(0, 120), undefined);
  });

  it('fills the bar rather than overflowing it when the position is past the end', () => {
    assert.equal(resumeFraction(300_000, 120), 1);
  });
});

describe('tabLayout', () => {
  it('keeps the sections in order and cuts each to its ceiling', () => {
    const rows = tabLayout([
      { heading: 'Continue listening', nodes: [row('a'), row('b'), row('c')], max: 2 },
      { nodes: [row('shuffle')] },
      { heading: 'Made for you', nodes: [row('m1')], max: 4 },
    ]);
    assert.deepEqual(
      rows.map((n) => n.id),
      ['a', 'b', 'shuffle', 'm1'],
    );
  });

  it('puts the heading on every row of a section and on no other', () => {
    const rows = tabLayout([
      { heading: 'Pinned', nodes: [row('p1'), row('p2')] },
      { nodes: [row('plain')] },
    ]);
    assert.deepEqual(
      rows.map((n) => n.group),
      ['Pinned', 'Pinned', undefined],
    );
  });

  it('leaves an empty section out, heading included', () => {
    const rows = tabLayout([
      { heading: 'Continue listening', nodes: [], max: 3 },
      { heading: 'Recently added', nodes: [row('al')] },
    ]);
    assert.deepEqual(rows.map((n) => n.group), ['Recently added']);
  });

  it('does not touch the rows it was given', () => {
    const given = row('x');
    tabLayout([{ heading: 'H', nodes: [given] }]);
    assert.equal(given.group, undefined);
  });
});

describe('drawerLayout', () => {
  const drawer = (id: string): CarNode => ({ id, title: id, playable: false, contentStyle: 'list' });

  it('drops a drawer that opens onto nothing and keeps the rest', () => {
    const rows = drawerLayout([
      { node: drawer('lib:playlists'), count: null },
      { node: drawer('lib:genres'), count: 0 },
      { node: drawer('lib:queues'), count: 3 },
    ]);
    assert.deepEqual(
      rows.map((n) => n.id),
      ['lib:playlists', 'lib:queues'],
    );
  });
});

describe('overflowsHome', () => {
  it('is true only past the ceiling', () => {
    assert.equal(overflowsHome(3, 3), false);
    assert.equal(overflowsHome(4, 3), true);
    assert.equal(overflowsHome(0, 3), false);
  });
});

describe('searchRows', () => {
  const HEADINGS = { song: 'Songs', album: 'Albums', artist: 'Artists', playlist: 'Playlists' };
  const rows = (query: string, local: CarNode[], found: CarNode[]) =>
    searchRows(query, local, found, HEADINGS);

  it('groups each kind under its heading and puts the phone first within one', () => {
    const out = rows(
      'moon',
      [row('album:local', 'Moonlight')],
      [row('track|found|s1', 'Moon Song'), row('album:server', 'Moon River')],
    );
    assert.deepEqual(
      out.map((n) => [n.id, n.group]),
      [
        ['album:local', 'Albums'],
        ['album:server', 'Albums'],
        ['track|found|s1', 'Songs'],
      ],
    );
  });

  it('leads with the kind that names exactly what was typed', () => {
    const out = rows(
      'björk',
      [],
      [row('track|found|s1', 'Bjork Live'), row('artist:1', 'Bjork'), row('album:1', 'Bjork Sings')],
    );
    assert.deepEqual(
      out.map((n) => n.id),
      ['artist:1', 'track|found|s1', 'album:1'],
    );
  });

  it('draws a song the two both hold once, as the phone holds it', () => {
    const out = rows('x', [row('track|album:1|s1', 'X')], [row('track|found|s1', 'X')]);
    assert.deepEqual(
      out.map((n) => n.id),
      ['track|album:1|s1'],
    );
  });

  it('leaves what is of no kind unheaded and last', () => {
    const out = rows('jazz', [row('genre:jazz', 'Jazz'), row('album:1', 'Jazz Songs')], []);
    assert.deepEqual(
      out.map((n) => [n.id, n.group]),
      [
        ['album:1', 'Albums'],
        ['genre:jazz', undefined],
      ],
    );
  });

  it('does not touch the rows it was given', () => {
    const given = row('album:1', 'A');
    rows('a', [given], []);
    assert.equal(given.group, undefined);
  });
});

describe('shelfId', () => {
  it('is the same id wherever the shelf sits on the page', () => {
    assert.equal(shelfId('Nouveautés', new Set()), shelfId('Nouveautés', new Set()));
  });

  it('carries nothing a track mediaId is split on', () => {
    assert.equal(shelfId('Mixes | for you', new Set()), 'yt:shelf:mixes-for-you');
  });

  it('tells two shelves of one name apart', () => {
    const taken = new Set<string>();
    assert.equal(shelfId('Covers', taken), 'yt:shelf:covers');
    assert.equal(shelfId('Covers', taken), 'yt:shelf:covers-2');
  });

  it('still names a shelf whose title is of no letters at all', () => {
    assert.equal(shelfId('♪♪♪', new Set()), 'yt:shelf:untitled');
  });

  it('leaves no dangling dash on a title cut to length', () => {
    const id = shelfId('a'.repeat(39) + ' and then some', new Set());
    assert.equal(id, `yt:shelf:${'a'.repeat(39)}`);
  });
});
