/**
 * Reading tags over byte ranges, against a server that actually serves them.
 *
 * The parsers are pinned by `webdavTags.test.ts`, which hands them bytes. What
 * is left untested by that — and is where the bugs live — is the *walking*:
 * deciding what to ask for, asking for it, and finding the part that matters
 * without pulling the file. So this one stands a real HTTP server up, serves
 * files whose shape is the awkward one in each container, and goes through
 * `readRemoteTags` exactly as the app does.
 *
 * The two shapes are chosen on purpose:
 *
 * · a FLAC whose cover sits between the stream info and the comment, so the
 *   comment starts past the first read and a second range is unavoidable;
 * · an M4A whose `moov` is at the END, which is where a file that was not made
 *   for streaming puts it, and which a parser that only looks at the start
 *   misses entirely.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { readRemoteTags } from '@/lib/webdavTags';

const encoder = new TextEncoder();

function be32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function le32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

function bytes(...parts: (number[] | Uint8Array)[]): Uint8Array {
  const flat: number[] = [];
  for (const part of parts) for (const b of part) flat.push(b);
  return new Uint8Array(flat);
}

/** A FLAC: stream info, then a cover big enough to push the comment out of
 *  reach of the first read, then the comment. */
function flacWithCoverBeforeTheComment(): Uint8Array {
  const streamInfo = bytes([0x00, 0x00, 0x00, 0x22], new Uint8Array(34));
  const cover = bytes([0x06, 0x00, 0x40, 0x00], new Uint8Array(0x4000));
  const entries = ['TITLE=Xtal', 'ARTIST=Aphex Twin', 'ALBUM=Selected Ambient Works', 'TRACKNUMBER=1', 'DATE=1992'];
  const vendor = encoder.encode('reference libFLAC');
  const body: number[] = [...le32(vendor.length), ...vendor, ...le32(entries.length)];
  for (const entry of entries) {
    const e = encoder.encode(entry);
    body.push(...le32(e.length), ...e);
  }
  // Type 4, and the last block: nothing follows but audio.
  const comment = bytes([0x84, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff], body);
  return bytes(encoder.encode('fLaC'), streamInfo, cover, comment, new Uint8Array(2048));
}

/** One `ilst` entry: its name, then a `data` atom holding the value. */
function entry(field: string, value: Uint8Array): number[] {
  const data = [...be32(16 + value.length), 0x64, 0x61, 0x74, 0x61, 0, 0, 0, 1, 0, 0, 0, 0, ...value];
  const name = [...field].map((c) => c.charCodeAt(0));
  return [...be32(8 + data.length), ...name, ...data];
}

function atom(name: string, body: number[], extra: number[] = []): number[] {
  const chars = [...name].map((c) => c.charCodeAt(0));
  return [...be32(8 + extra.length + body.length), ...chars, ...extra, ...body];
}

/** An M4A with its index at the end, behind a large `mdat`. */
function m4aWithMoovAtTheEnd(): Uint8Array {
  const ftyp = atom('ftyp', [...encoder.encode('M4A ')], []);
  const mdat = atom('mdat', [...new Uint8Array(0x8000)]);
  const list = [
    ...entry('\xA9nam', encoder.encode('One More Time')),
    ...entry('\xA9ART', encoder.encode('Daft Punk')),
    ...entry('\xA9alb', encoder.encode('Discovery')),
    ...entry('\xA9day', encoder.encode('2001')),
    ...entry('trkn', new Uint8Array([0, 0, 0, 1, 0, 14])),
  ];
  // `meta` carries four bytes of version and flags before its children; the
  // atoms around it do not, and forgetting that is the classic way to lose an
  // MP4's tags.
  const meta = atom('meta', atom('ilst', list), [0, 0, 0, 0]);
  const moov = atom('moov', atom('udta', meta));
  return bytes(ftyp, mdat, moov);
}

describe('readRemoteTags over ranges', () => {
  const files = new Map<string, Uint8Array>([
    ['/song.flac', flacWithCoverBeforeTheComment()],
    ['/song.m4a', m4aWithMoovAtTheEnd()],
    ['/song.ogg', bytes(encoder.encode('OggS'), new Uint8Array(4096))],
  ]);
  /** Every range the server was asked for, to prove the file is not pulled. */
  let asked: { path: string; bytes: number }[] = [];
  let server: Server;
  let base = '';

  before(async () => {
    server = createServer((req, res) => {
      const file = files.get(req.url ?? '');
      if (!file) {
        res.writeHead(404).end();
        return;
      }
      const match = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
      if (!match) {
        // No range asked for: answer whole, which the reader must refuse.
        res.writeHead(200).end(Buffer.from(file));
        return;
      }
      const from = Number(match[1]);
      const to = Math.min(Number(match[2]), file.length - 1);
      if (from >= file.length) {
        res.writeHead(416).end();
        return;
      }
      const slice = file.subarray(from, to + 1);
      asked.push({ path: req.url ?? '', bytes: slice.length });
      res.writeHead(206, {
        'Content-Range': `bytes ${from}-${to}/${file.length}`,
        'Content-Length': String(slice.length),
      });
      res.end(Buffer.from(slice));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  after(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  it('reads a FLAC whose comment sits behind its cover', async () => {
    asked = [];
    const tags = await readRemoteTags(`${base}/song.flac`);
    assert.equal(tags?.title, 'Xtal');
    assert.equal(tags?.artist, 'Aphex Twin');
    assert.equal(tags?.album, 'Selected Ambient Works');
    assert.equal(tags?.track, 1);
    assert.equal(tags?.year, 1992);
    // And the point of all this: the cover was never fetched. The file is
    // 100 kB; what crossed the wire is a fraction of it.
    const pulled = asked.reduce((n, r) => n + r.bytes, 0);
    assert.ok(pulled < 8 * 1024, `${pulled} bytes crossed the wire`);
  });

  it('reads an M4A whose index is at the end of the file', async () => {
    asked = [];
    const tags = await readRemoteTags(`${base}/song.m4a`);
    assert.equal(tags?.title, 'One More Time');
    assert.equal(tags?.artist, 'Daft Punk');
    assert.equal(tags?.album, 'Discovery');
    assert.equal(tags?.year, 2001);
    assert.equal(tags?.track, 1);
    const pulled = asked.reduce((n, r) => n + r.bytes, 0);
    assert.ok(pulled < 8 * 1024, `${pulled} bytes crossed the wire`);
  });

  it('says nothing about a container it cannot read, rather than failing', async () => {
    assert.equal(await readRemoteTags(`${base}/song.ogg`), null);
  });

  it('gives up on a server that will not serve ranges', async () => {
    // The reader refuses a 200: answering whole is exactly what this exists to
    // avoid, and a share that does it would download every song in the folder.
    assert.equal(await readRemoteTags(`${base}/missing.flac`), null);
  });
});
