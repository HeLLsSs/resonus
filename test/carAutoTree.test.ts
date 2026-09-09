/**
 * The shape of the car's tabs: what a section is cut to, which headings
 * survive, and which drawers of the Library are worth a row.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CarNode } from '@/lib/carAuto';
import { drawerLayout, overflowsHome, tabLayout } from '@/lib/carAutoLayout';

function row(id: string): CarNode {
  return { id, title: id, playable: true };
}

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
