/** Which library songs the proxy put there. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isImportedByNavifind } from '@/lib/navifind';

describe('isImportedByNavifind', () => {
  it('recognises the folder the proxy files its imports under', () => {
    assert.equal(isImportedByNavifind({ path: 'Navifind/Daft Punk/Daft Punk - Da Funk.m4a' }), true);
  });

  it('accepts the folder on disk in front of it', () => {
    assert.equal(isImportedByNavifind({ path: '/music/Navifind/Daft Punk/Daft Punk - Da Funk.m4a' }), true);
  });

  it('leaves the rest of the library alone', () => {
    assert.equal(isImportedByNavifind({ path: 'Daft Punk/Homework/01 - Daywalker.flac' }), false);
  });

  it('is not fooled by an artist of that name', () => {
    assert.equal(isImportedByNavifind({ path: 'Navifind Orchestra/Live/01.flac' }), false);
  });

  it('says no when the server sends no path', () => {
    assert.equal(isImportedByNavifind({}), false);
  });
});
