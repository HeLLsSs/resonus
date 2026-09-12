/**
 * Reading what a WebDAV server answers: which entries come out of a PROPFIND,
 * which of them are music, and in what order they are shown.
 *
 * The samples are the shapes servers really send — Nextcloud's namespaced
 * `d:`, an Apache that namespaces with `D:`, and one with no prefix at all —
 * because that is the whole difficulty of reading this by hand.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isAudio, nameFromHref, parsePropfind, sortEntries, type DavEntry } from '@/lib/webdav';

const NEXTCLOUD = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:response>
    <d:href>/remote.php/dav/files/gnouet/Musique/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
    <d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/gnouet/Musique/Tool/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
    <d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/gnouet/Musique/Parabola.flac</d:href>
    <d:propstat><d:prop>
      <d:getcontentlength>48210331</d:getcontentlength>
      <d:getcontenttype>audio/flac</d:getcontenttype>
      <d:resourcetype/>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;

describe('parsePropfind', () => {
  const listed = parsePropfind(NEXTCLOUD, '/remote.php/dav/files/gnouet/Musique/');

  it('leaves the folder itself out of its own listing', () => {
    assert.deepEqual(
      listed.map((e) => e.name),
      ['Tool', 'Parabola.flac'],
    );
  });

  it('tells a folder from a file', () => {
    assert.deepEqual(
      listed.map((e) => e.isFolder),
      [true, false],
    );
  });

  it('reads the size and the type when the server gave them', () => {
    const file = listed[1];
    assert.equal(file.size, 48210331);
    assert.equal(file.contentType, 'audio/flac');
  });

  it('leaves the size out rather than guessing when there is none', () => {
    assert.equal(listed[0].size, undefined);
  });

  it('drops the folder wherever the server put it in the list', () => {
    // Servers are not required to answer with the folder first.
    const reversed = NEXTCLOUD.replace(
      /(<d:response>[\s\S]*?<\/d:response>)([\s\S]*)(<d:response>[\s\S]*?Parabola[\s\S]*?<\/d:response>)/,
      '$3$2$1',
    );
    const out = parsePropfind(reversed, '/remote.php/dav/files/gnouet/Musique/');
    assert.ok(!out.some((e) => e.name === 'Musique'));
  });

  it('reads a server that namespaces differently, and one that does not', () => {
    const upper = NEXTCLOUD.replace(/<d:/g, '<D:').replace(/<\/d:/g, '</D:');
    const bare = NEXTCLOUD.replace(/<d:/g, '<').replace(/<\/d:/g, '</');
    for (const flavour of [upper, bare]) {
      const out = parsePropfind(flavour, '/remote.php/dav/files/gnouet/Musique/');
      assert.deepEqual(
        out.map((e) => e.name),
        ['Tool', 'Parabola.flac'],
      );
    }
  });

  it('hands back nothing for an answer it cannot read, rather than throwing', () => {
    assert.deepEqual(parsePropfind('<html>401</html>', '/x/'), []);
  });
});

describe('nameFromHref', () => {
  it('unescapes what the server escaped', () => {
    assert.equal(nameFromHref('/dav/files/gnouet/Musique%20%C3%A9t%C3%A9/'), 'Musique été');
  });

  it('shows the raw segment rather than nothing when it cannot be unescaped', () => {
    assert.equal(nameFromHref('/dav/files/100%bad'), '100%bad');
  });
});

describe('isAudio', () => {
  const entry = (over: Partial<DavEntry>): DavEntry => ({
    name: 'x',
    href: '/x',
    isFolder: false,
    ...over,
  });

  it('believes the server when it says audio', () => {
    assert.equal(isAudio(entry({ name: 'track', contentType: 'audio/mpeg' })), true);
  });

  it('falls back to the name when the server said nothing', () => {
    assert.equal(isAudio(entry({ name: 'Parabola.flac' })), true);
    assert.equal(isAudio(entry({ name: 'cover.jpg' })), false);
  });

  it('is never true of a folder, whatever it is called', () => {
    assert.equal(isAudio(entry({ name: 'Album.mp3', isFolder: true })), false);
  });
});

describe('sortEntries', () => {
  it('puts folders first and then sorts by name, ignoring case and accents', () => {
    const mixed: DavEntry[] = [
      { name: 'zebra.mp3', href: '/z', isFolder: false },
      { name: 'Étoile', href: '/e', isFolder: true },
      { name: 'alpha.mp3', href: '/a', isFolder: false },
      { name: 'beta', href: '/b', isFolder: true },
    ];
    assert.deepEqual(
      sortEntries(mixed).map((e) => e.name),
      ['beta', 'Étoile', 'alpha.mp3', 'zebra.mp3'],
    );
  });

  it('does not touch the list it was given', () => {
    const given: DavEntry[] = [
      { name: 'b', href: '/b', isFolder: false },
      { name: 'a', href: '/a', isFolder: true },
    ];
    sortEntries(given);
    assert.equal(given[0].name, 'b');
  });
});
