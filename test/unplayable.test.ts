/**
 * Online tracks the player gave up on: how long they are left out of the
 * shuffles and mixes, and how they come back.
 *
 * The store is one for the whole run, so each test uses ids of its own.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { setPlainItem } from '@/lib/plainStorage';
import { expiry, prune, UNPLAYABLE_DAYS, useUnplayable, withoutUnplayable } from '@/store/unplayable';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('expiry', () => {
  it('is UNPLAYABLE_DAYS after the mark', () => {
    assert.equal(expiry(1_000), 1_000 + UNPLAYABLE_DAYS * DAY_MS);
  });
});

describe('prune', () => {
  it('drops what has run out and keeps the rest', () => {
    const now = 10 * DAY_MS;
    assert.deepEqual(prune({ yt_old: now - 1, yt_now: now, yt_live: now + 1 }, now), { yt_live: now + 1 });
  });

  it('gives back the same object when nothing has run out', () => {
    const entries = { yt_a: 5, sc_b: 6 };
    assert.equal(prune(entries, 4), entries);
  });
});

describe('useUnplayable', () => {
  it('leaves a marked track out of a pool, and only that one', () => {
    useUnplayable.getState().markUnplayable('yt_marked');
    const pool = [{ id: 'yt_marked' }, { id: 'yt_fine' }, { id: 'lib-1' }];
    assert.deepEqual(withoutUnplayable(pool), [{ id: 'yt_fine' }, { id: 'lib-1' }]);
  });

  it('answers isUnplayable for a marked track and not for another', () => {
    useUnplayable.getState().markUnplayable('yt_asked');
    const { isUnplayable } = useUnplayable.getState();
    assert.deepEqual([isUnplayable('yt_asked'), isUnplayable('yt_never')], [true, false]);
  });

  it('forgets a track that played after all', () => {
    useUnplayable.getState().markUnplayable('yt_forgiven');
    useUnplayable.getState().forget('yt_forgiven');
    assert.equal(useUnplayable.getState().isUnplayable('yt_forgiven'), false);
  });

  it('reads the saved list back without what has run out', async () => {
    const soon = Date.now() + DAY_MS;
    await setPlainItem('resonus.unplayable', JSON.stringify({ yt_stale: Date.now() - 1, yt_kept: soon }));
    await useUnplayable.getState().hydrate();
    assert.deepEqual(useUnplayable.getState().entries, { yt_kept: soon });
  });
});
