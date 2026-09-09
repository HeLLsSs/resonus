/**
 * Playlists as M3U files: what the reader makes of the files other players
 * write, that the writer's own files come back whole, and how an import
 * finds each entry on the server.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { Song } from '@/api/subsonic';
import { importM3u, MAX_ENTRIES, parseM3u, pickM3uFile, serialiseM3u, shareM3u } from '@/lib/m3u';

import { data } from './stubs/api-data';
import { subsonic } from './stubs/api-subsonic';
import { documentPicker } from './stubs/expo-document-picker';
import { fileSystem } from './stubs/expo-file-system';
import { sharing } from './stubs/expo-sharing';
import { serverProfile, useAuthStore } from './stubs/store-auth';
import { useToast } from './stubs/store-toast';

function song(overrides: Partial<Song> & { id: string }): Song {
  return { title: `Title ${overrides.id}`, ...overrides };
}

describe('parseM3u', () => {
  it('reads a plain file with EXTINF lines', () => {
    const parsed = parseM3u('#EXTM3U\n#EXTINF:225,Nina Simone - Feeling Good\nNina Simone/Feeling Good.mp3\n');
    assert.deepEqual(parsed, {
      name: undefined,
      truncated: false,
      entries: [
        { location: 'Nina Simone/Feeling Good.mp3', seconds: 225, artist: 'Nina Simone', title: 'Feeling Good' },
      ],
    });
  });

  it('accepts a file with no header and no tags: one path per line', () => {
    const parsed = parseM3u('a.mp3\nb.mp3\n');
    assert.deepEqual(
      parsed.entries.map((e) => e.location),
      ['a.mp3', 'b.mp3'],
    );
  });

  it('strips a byte order mark so the first line is still a tag', () => {
    const parsed = parseM3u('\uFEFF#EXTM3U\n#PLAYLIST:Mine\na.mp3\n');
    assert.equal(parsed.name, 'Mine');
  });

  it('handles CRLF and lone CR line endings and skips blank lines', () => {
    const parsed = parseM3u('#EXTM3U\r\n\r\n#EXTINF:10,One\r\na.mp3\r\n   \r\n#EXTINF:20,Two\rb.mp3\r\n');
    assert.deepEqual(
      parsed.entries.map((e) => [e.location, e.title]),
      [
        ['a.mp3', 'One'],
        ['b.mp3', 'Two'],
      ],
    );
  });

  it('leaves the duration out when the file says -1', () => {
    const [entry] = parseM3u('#EXTINF:-1,Live stream\nhttp://radio.example/stream\n').entries;
    assert.equal(entry.seconds, undefined);
    assert.equal(entry.title, 'Live stream');
  });

  it('rounds a fractional duration and tolerates a missing one', () => {
    const entries = parseM3u('#EXTINF:12.6,A\na.mp3\n#EXTINF:,B\nb.mp3\n').entries;
    assert.equal(entries[0].seconds, 13);
    assert.equal(entries[1].seconds, undefined);
  });

  it('lets attributes sit between the duration and the comma', () => {
    const [entry] = parseM3u('#EXTINF:90 tvg-id="x" group-title="y",Some Title\na.mp3\n').entries;
    assert.equal(entry.seconds, 90);
    assert.equal(entry.title, 'Some Title');
  });

  it('splits artist and title on the first dash only', () => {
    const [entry] = parseM3u('#EXTINF:1,AC - DC - Back In Black\na.mp3\n').entries;
    assert.equal(entry.artist, 'AC');
    assert.equal(entry.title, 'DC - Back In Black');
  });

  it('keeps a title with no dash as the title alone', () => {
    const [entry] = parseM3u('#EXTINF:1,Intro\na.mp3\n').entries;
    assert.equal(entry.artist, undefined);
    assert.equal(entry.title, 'Intro');
  });

  it('reads the playlist name, the album and our own id line, whatever their case', () => {
    const parsed = parseM3u('#playlist: Road trip \n#extalb:Greatest Hits\n#Resonus:id=abc123\nx.mp3\n');
    assert.equal(parsed.name, 'Road trip');
    assert.deepEqual(parsed.entries[0], { location: 'x.mp3', album: 'Greatest Hits', id: 'abc123' });
  });

  it('keeps an earlier name when a later PLAYLIST line is empty', () => {
    assert.equal(parseM3u('#PLAYLIST:First\n#PLAYLIST:\na.mp3\n').name, 'First');
  });

  it('ignores comments it does not know', () => {
    const parsed = parseM3u('#EXTM3U\n#EXTVLCOPT:network-caching=1000\n#SYMFONIUM:id=1\na.mp3\n');
    assert.deepEqual(parsed.entries, [{ location: 'a.mp3' }]);
  });

  it('describes only the next entry with the tags read so far', () => {
    const entries = parseM3u('#EXTINF:5,A\n#EXTALB:Alb\na.mp3\nb.mp3\n').entries;
    assert.equal(entries[0].album, 'Alb');
    assert.deepEqual(entries[1], { location: 'b.mp3' });
  });

  it('keeps a Windows path as written', () => {
    const [entry] = parseM3u('D:\\Music\\Artist\\Song.flac\n').entries;
    assert.equal(entry.location, 'D:\\Music\\Artist\\Song.flac');
  });

  it(`stops after ${MAX_ENTRIES} entries and says so`, () => {
    const lines = Array.from({ length: MAX_ENTRIES + 3 }, (_, i) => `song${i}.mp3`);
    const parsed = parseM3u(lines.join('\n'));
    assert.equal(parsed.entries.length, MAX_ENTRIES);
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.entries.at(-1)?.location, `song${MAX_ENTRIES - 1}.mp3`);
  });

  it(`is not truncated at exactly ${MAX_ENTRIES} entries`, () => {
    const lines = Array.from({ length: MAX_ENTRIES }, (_, i) => `song${i}.mp3`);
    assert.equal(parseM3u(lines.join('\n')).truncated, false);
  });
});

describe('serialiseM3u', () => {
  const songs: Song[] = [
    song({ id: 's1', title: 'Feeling Good', artist: 'Nina Simone', album: 'I Put a Spell on You', duration: 173.4, suffix: 'flac' }),
    song({ id: 's2', title: 'Untitled' }),
  ];

  it('writes the header, the name and one block per song', () => {
    const text = serialiseM3u('Evening', songs);
    assert.equal(
      text,
      [
        '#EXTM3U',
        '#PLAYLIST:Evening',
        '#EXTINF:173,Nina Simone - Feeling Good',
        '#EXTALB:I Put a Spell on You',
        '#RESONUS:id=s1',
        'Nina Simone/I Put a Spell on You/Feeling Good.flac',
        '#EXTINF:-1,Untitled',
        '#RESONUS:id=s2',
        'Unknown/Unknown/Untitled.mp3',
        '',
      ].join('\n'),
    );
  });

  it("uses the server's own path when the song has one", () => {
    const withPath = { ...songs[0], path: 'Library/Nina/01 - Feeling Good.flac' } as Song;
    assert.ok(serialiseM3u('x', [withPath]).includes('\nLibrary/Nina/01 - Feeling Good.flac\n'));
  });

  it('keeps every field on one line and out of the path separators', () => {
    const odd = song({ id: 's3', title: 'Line\none', artist: 'A/C', album: 'B\\D' });
    const text = serialiseM3u('Name\r\nwith break', [odd]);
    assert.ok(text.includes('#PLAYLIST:Name with break\n'));
    assert.ok(text.includes('#EXTINF:-1,A/C - Line one\n'));
    assert.ok(text.includes('\nA-C/B-D/Line one.mp3\n'));
  });

  it('comes back through parseM3u with the same songs', () => {
    const parsed = parseM3u(serialiseM3u('Evening', songs));
    assert.equal(parsed.name, 'Evening');
    assert.deepEqual(parsed.entries, [
      {
        location: 'Nina Simone/I Put a Spell on You/Feeling Good.flac',
        seconds: 173,
        artist: 'Nina Simone',
        title: 'Feeling Good',
        album: 'I Put a Spell on You',
        id: 's1',
      },
      // `-1` on the way out is no duration on the way back.
      { location: 'Unknown/Unknown/Untitled.mp3', seconds: undefined, title: 'Untitled', id: 's2' },
    ]);
  });
});

describe('shareM3u', () => {
  beforeEach(() => {
    sharing.available = true;
    sharing.shared = [];
    fileSystem.reset();
  });

  it('answers false when the phone has no share sheet', async () => {
    sharing.available = false;
    assert.equal(await shareM3u('x', []), false);
    assert.equal(sharing.shared.length, 0);
  });

  it('writes the file under a safe name and shares it as a playlist', async () => {
    assert.equal(await shareM3u('Road: trip / 2024?', [song({ id: 's1' })]), true);
    const [shared] = sharing.shared;
    assert.equal(shared.uri, 'file:///cache/export/Road trip - 2024.m3u8');
    assert.equal(shared.options?.mimeType, 'audio/x-mpegurl');
    assert.ok(fileSystem.files.get(shared.uri)?.startsWith('#EXTM3U\n'));
  });
});

describe('pickM3uFile', () => {
  beforeEach(() => {
    fileSystem.reset();
    useToast.setState({ messages: [] });
  });

  it('answers null when nobody chose', async () => {
    documentPicker.next = { canceled: true };
    assert.equal(await pickM3uFile(), null);
  });

  it('refuses a file too big to be a playlist, with a toast', async () => {
    documentPicker.next = { canceled: false, assets: [{ uri: 'file:///picked/huge.m3u8', name: 'huge.m3u8', size: 6 * 1024 * 1024 }] };
    assert.equal(await pickM3uFile(), null);
    assert.deepEqual(useToast.getState().messages, ['That file is too big to be a playlist.']);
  });

  it('hands back the text and the name without its extension', async () => {
    fileSystem.files.set('file:///picked/mine.M3U', '#EXTM3U\na.mp3\n');
    documentPicker.next = { canceled: false, assets: [{ uri: 'file:///picked/mine.M3U', name: 'mine.M3U' }] };
    assert.deepEqual(await pickM3uFile(), { name: 'mine', text: '#EXTM3U\na.mp3\n' });
  });
});

describe('importM3u', () => {
  const onServer = song({ id: 'srv1', title: 'Feeling Good', artist: 'Nina Simone', path: 'music/Nina Simone/Feeling Good.flac' } as Partial<Song> & { id: string });

  beforeEach(() => {
    data.reset();
    subsonic.songsById.clear();
    subsonic.proxyActive = false;
    useAuthStore.setState({ auth: serverProfile(), offline: false });
  });

  it('finds a song by our id before anything else and makes the playlist in file order', async () => {
    subsonic.songsById.set('srv1', onServer);
    subsonic.songsById.set('srv2', song({ id: 'srv2' }));
    const text = '#PLAYLIST:Mine\n#RESONUS:id=srv2\nb.mp3\n#RESONUS:id=srv1\na.mp3\n';
    const result = await importM3u(text, 'fallback');
    assert.deepEqual(result, { name: 'Mine', playlistId: 'pl-new', found: 2, total: 2, unresolved: [], truncated: false });
    assert.deepEqual(
      data.calls.map((c) => c.name),
      ['createPlaylist', 'reorderPlaylist'],
      'no search was needed',
    );
    assert.deepEqual(data.calls[1].args, ['pl-new', ['srv2', 'srv1']]);
  });

  it('falls back to the path, matched by its tail whatever the root', async () => {
    data.searchResults = [onServer];
    const result = await importM3u('D:\\Library\\Nina%20Simone\\Feeling Good.flac\n', 'fallback');
    assert.equal(result.found, 1);
    assert.equal(data.calls[0].name, 'searchSongs');
    assert.equal(data.calls[0].args[0], 'feeling good', 'searched by the file name, decoded and folded');
  });

  it('falls back to the title and artist, ignoring case and accents', async () => {
    data.searchResults = [song({ id: 'other', title: 'Feeling Good', artist: 'Someone Else' }), song({ id: 'srv1', title: 'Feeling Good', artist: 'Nina Simone' })];
    const result = await importM3u('#EXTINF:1,NINA SIMONÉ - feeling good\nnowhere.mp3\n', 'fallback');
    assert.equal(result.found, 1);
    assert.deepEqual(data.calls.at(-1)?.args, ['pl-new', ['srv1']], 'the artist ranks the title matches');
  });

  it('lists what it could not find, by title or by file name, and makes no playlist', async () => {
    const result = await importM3u('#EXTINF:1,Ghost - Song\nmissing.mp3\nAlbum/Other Song.mp3\n', 'From file');
    assert.equal(result.playlistId, undefined);
    assert.equal(result.name, 'From file');
    assert.deepEqual(result.unresolved, ['Ghost - Song', 'Other Song.mp3']);
    assert.equal(data.calls.filter((c) => c.name === 'createPlaylist').length, 0);
  });

  it('does not ask a Jellyfin server for a song by id', async () => {
    useAuthStore.setState({ auth: serverProfile({ serverType: 'jellyfin' }) });
    subsonic.songsById.set('srv1', onServer);
    const result = await importM3u('#RESONUS:id=srv1\nnowhere.mp3\n', 'x');
    assert.equal(result.found, 0);
  });

  it('leaves out online tracks the proxy adds to a search', async () => {
    subsonic.proxyActive = true;
    data.searchResults = [song({ id: 'yt_abc', title: 'Feeling Good' })];
    const result = await importM3u('#EXTINF:1,Feeling Good\nx.mp3\n', 'x');
    assert.equal(result.found, 0);
  });

  it('throws when the server fails rather than reporting nothing found', async () => {
    data.failure = new Error('down');
    await assert.rejects(importM3u('a.mp3\n', 'x'), /down/);
  });

  it('carries the truncation flag through', async () => {
    const lines = Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => `s${i}.mp3`);
    const result = await importM3u(lines.join('\n'), 'x');
    assert.equal(result.truncated, true);
    assert.equal(result.total, MAX_ENTRIES);
  });
});
