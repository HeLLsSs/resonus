/**
 * The MD5 the web build signs in with, against the digests everybody knows.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { md5Hex } from '@/lib/md5';

describe('md5Hex', () => {
  it('matches the reference digests', () => {
    assert.equal(md5Hex(''), 'd41d8cd98f00b204e9800998ecf8427e');
    assert.equal(md5Hex('abc'), '900150983cd24fb0d6963f7d28e17f72');
    assert.equal(md5Hex('The quick brown fox jumps over the lazy dog'), '9e107d9d372bb6826bd81d3542a419d6');
  });

  it('hashes the UTF-8 bytes, and messages of every length around a block', () => {
    for (const text of ['pässwörd' + 'sel', 'é', 'a'.repeat(55), 'b'.repeat(56), 'c'.repeat(64), 'd'.repeat(119), 'e'.repeat(1000)]) {
      assert.equal(md5Hex(text), createHash('md5').update(text, 'utf8').digest('hex'), text.slice(0, 12));
    }
  });
});
