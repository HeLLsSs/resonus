/**
 * Reading a tag's length from its first ten bytes, and running work a few at
 * a time. The parsing of the tag itself is the app's own and tested with it;
 * what is new here is deciding how much to ask a server for.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { id3Length, inBatches, parseIlst, parseVorbisComment } from '@/lib/webdavTags';

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

/** A Vorbis comment block: a vendor string, a count, then `KEY=value` entries. */
function vorbis(entries: string[], vendor = 'reference libFLAC'): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const le = (n: number) => new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
  const vendorBytes = encoder.encode(vendor);
  parts.push(le(vendorBytes.length), vendorBytes, le(entries.length));
  for (const entry of entries) {
    const bytes = encoder.encode(entry);
    parts.push(le(bytes.length), bytes);
  }
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe('parseVorbisComment', () => {
  it('reads what a FLAC says about itself', () => {
    const tags = parseVorbisComment(
      vorbis(['TITLE=Xtal', 'ARTIST=Aphex Twin', 'ALBUM=Selected Ambient Works', 'TRACKNUMBER=1', 'DATE=1992-11-09']),
    );
    assert.equal(tags.title, 'Xtal');
    assert.equal(tags.artist, 'Aphex Twin');
    assert.equal(tags.album, 'Selected Ambient Works');
    assert.equal(tags.track, 1);
    assert.equal(tags.year, 1992);
  });

  it('does not care how a tagger spelled the key', () => {
    // The standard only asks for case-insensitivity, and taggers disagree:
    // all three of these turn up in the same folder.
    assert.equal(parseVorbisComment(vorbis(['Title=Tha'])).title, 'Tha');
    assert.equal(parseVorbisComment(vorbis(['title=Tha'])).title, 'Tha');
    assert.equal(parseVorbisComment(vorbis(['TITLE=Tha'])).title, 'Tha');
  });

  it('takes the track out of "3/12" and leaves the total', () => {
    assert.equal(parseVorbisComment(vorbis(['TRACKNUMBER=3/12'])).track, 3);
  });

  it('keeps accents, which is the whole reason it is UTF-8', () => {
    assert.equal(parseVorbisComment(vorbis(['ARTIST=Édith Piaf'])).artist, 'Édith Piaf');
  });

  it('reads an album artist under either of its two spellings', () => {
    assert.equal(parseVorbisComment(vorbis(['ALBUMARTIST=VA'])).albumArtist, 'VA');
    assert.equal(parseVorbisComment(vorbis(['ALBUM ARTIST=VA'])).albumArtist, 'VA');
  });

  it('stops at the end of the buffer rather than trusting the count', () => {
    const block = vorbis(['TITLE=Xtal']);
    // A count that claims far more than the block holds: a truncated file, or
    // a corrupt one. It must not throw and must keep what it did read.
    block[4 + 'reference libFLAC'.length] = 0xff;
    assert.doesNotThrow(() => parseVorbisComment(block));
  });

  it('says nothing about a block too short to hold anything', () => {
    assert.deepEqual(parseVorbisComment(new Uint8Array(3)), {});
  });
});

/** One `ilst` entry: its name, then a `data` atom carrying the value. */
function ilstEntry(field: string, value: Uint8Array): Uint8Array {
  const data = new Uint8Array(16 + value.length);
  const size = data.length;
  data.set([(size >> 24) & 0xff, (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff], 0);
  data.set([0x64, 0x61, 0x74, 0x61], 4); // "data"
  data.set(value, 16);

  const entry = new Uint8Array(8 + data.length);
  const whole = entry.length;
  entry.set([(whole >> 24) & 0xff, (whole >> 16) & 0xff, (whole >> 8) & 0xff, whole & 0xff], 0);
  for (let i = 0; i < 4; i++) entry[4 + i] = field.charCodeAt(i);
  entry.set(data, 8);
  return entry;
}

function ilst(entries: Uint8Array[]): Uint8Array {
  const total = entries.reduce((n, e) => n + e.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const entry of entries) {
    out.set(entry, at);
    at += entry.length;
  }
  return out;
}

describe('parseIlst', () => {
  const text = (value: string) => new TextEncoder().encode(value);

  it('reads what an M4A says about itself', () => {
    const tags = parseIlst(
      ilst([
        ilstEntry('\xA9nam', text('One More Time')),
        ilstEntry('\xA9ART', text('Daft Punk')),
        ilstEntry('\xA9alb', text('Discovery')),
        ilstEntry('aART', text('Daft Punk')),
        ilstEntry('\xA9day', text('2001-03-12')),
        ilstEntry('trkn', new Uint8Array([0, 0, 0, 1, 0, 14])),
      ]),
    );
    assert.equal(tags.title, 'One More Time');
    assert.equal(tags.artist, 'Daft Punk');
    assert.equal(tags.album, 'Discovery');
    assert.equal(tags.albumArtist, 'Daft Punk');
    assert.equal(tags.year, 2001);
    assert.equal(tags.track, 1);
  });

  it('stops at a length that runs past the buffer instead of reading on', () => {
    const entry = ilstEntry('\xA9nam', text('Aerodynamic'));
    entry[3] = 0xff; // a size far beyond what is there
    assert.doesNotThrow(() => parseIlst(entry));
    assert.deepEqual(parseIlst(entry), {});
  });

  it('ignores an entry with no data atom in it', () => {
    const entry = ilstEntry('\xA9nam', text('Digital Love'));
    entry[8 + 4] = 0x78; // "data" becomes "xata"
    assert.deepEqual(parseIlst(entry), {});
  });

  it('says nothing about an empty list', () => {
    assert.deepEqual(parseIlst(new Uint8Array(0)), {});
  });
});
