/**
 * Reading a tag's length from its first ten bytes, and running work a few at
 * a time. The parsing of the tag itself is the app's own and tested with it;
 * what is new here is deciding how much to ask a server for.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { id3Length, inBatches } from '@/lib/webdavTags';

/** The ten bytes an ID3 tag starts with, for a tag of `size` bytes. */
function header(size: number, magic = 'ID3'): Uint8Array {
  const head = new Uint8Array(10);
  head[0] = magic.charCodeAt(0);
  head[1] = magic.charCodeAt(1);
  head[2] = magic.charCodeAt(2);
  head[3] = 3;
  head[6] = (size >> 21) & 0x7f;
  head[7] = (size >> 14) & 0x7f;
  head[8] = (size >> 7) & 0x7f;
  head[9] = size & 0x7f;
  return head;
}

describe('id3Length', () => {
  it('reads a size written in seven-bit groups', () => {
    assert.equal(id3Length(header(1234)), 1234);
    assert.equal(id3Length(header(200000)), 200000);
  });

  it('says nothing for a file that does not start with a tag', () => {
    // A FLAC begins with "fLaC", an M4A with a size and "ftyp".
    assert.equal(id3Length(header(1234, 'fLa')), null);
  });

  it('says nothing when there are not ten bytes to read', () => {
    assert.equal(id3Length(new Uint8Array(4)), null);
  });

  it('says nothing for a tag that claims to be empty', () => {
    assert.equal(id3Length(header(0)), null);
  });

  it('ignores the top bit of each size byte, which is never part of the size', () => {
    const head = header(1234);
    head[6] |= 0x80;
    head[7] |= 0x80;
    head[8] |= 0x80;
    head[9] |= 0x80;
    assert.equal(id3Length(head), 1234);
  });
});

describe('inBatches', () => {
  it('runs everything', async () => {
    const done: number[] = [];
    await inBatches([1, 2, 3, 4, 5], 2, async (n) => {
      done.push(n);
    });
    assert.deepEqual(done.sort(), [1, 2, 3, 4, 5]);
  });

  it('never runs more at once than it was told to', async () => {
    let running = 0;
    let most = 0;
    await inBatches(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 1));
      running--;
    });
    assert.ok(most <= 3, `ran ${most} at once`);
  });

  it('does nothing, and does not hang, on an empty list', async () => {
    await inBatches([], 4, async () => {
      throw new Error('should not run');
    });
  });
});
