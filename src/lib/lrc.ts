/**
 * LRC format (lyrics with `[mm:ss.xx]` timestamps). Used for `.lrc` files
 * next to local music, embedded USLT lyrics (which often contain timestamps),
 * and for caching server or LRCLIB lyrics to disk.
 * Text without timestamps also works: returned as unsynced lyrics.
 *
 * Enhanced LRC (the A2 extension) is read too: `<mm:ss.xx>` tags inside a
 * line give each word its own time, `[00:12.34] <00:12.34> Hello <00:12.80>
 * world <00:13.20>`, the last tag being where the last word ends. Lines with
 * no such tags are lines and nothing more, so a file can mix the two.
 */
import { type LyricLine, type LyricWord, type SongLyrics } from '@/api/subsonic';

/** LRC metadata tags that are ignored (except `offset`, which is applied). */
const META_RE = /^\[(ar|ti|al|au|by|la|re|ve|tool|length|id|#):[^\]]*\]$/i;
const STAMP_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/y;
/** A word's time, inside the line: the same clock in angle brackets. */
const WORD_RE = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;

/** The milliseconds a matched stamp stands for, whichever brackets it wore. */
function stampMs(m: RegExpExecArray): number {
  const frac = m[3] ?? '';
  // 1 digit = tenths, 2 = hundredths, 3 = milliseconds.
  const ms = frac ? parseInt(frac, 10) * [100, 10, 1][frac.length - 1] : 0;
  return (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) * 1000 + ms;
}

/**
 * The words of a line from the text after its stamps, each timed by the tag
 * in front of it (text before the first tag is timed by the line). Spacing is
 * kept the way the words read, not the way the tags were laid out: a space on
 * either side of a tag is one space at the end of the word before it, so a
 * tag inside a word (`<t>He<t>llo`) still spells the word. A tag with nothing
 * after it is an end marker and gives no word. Null when the line has no
 * tags at all: then it is a line, not a list of words.
 */
function parseWords(rest: string, lineStart: number): LyricWord[] | null {
  const words: LyricWord[] = [];
  let start = lineStart;
  let pos = 0;
  const push = (segment: string) => {
    const last = words[words.length - 1];
    if (last && /^\s/.test(segment)) last.text = `${last.text.trimEnd()} `;
    const text = segment.trim();
    if (text) words.push({ start, text: /\s$/.test(segment) ? `${text} ` : text });
  };
  WORD_RE.lastIndex = 0;
  for (let m = WORD_RE.exec(rest); m; m = WORD_RE.exec(rest)) {
    push(rest.slice(pos, m.index));
    start = stampMs(m);
    pos = m.index + m[0].length;
  }
  if (pos === 0) return null;
  push(rest.slice(pos));
  const last = words[words.length - 1];
  if (last) last.text = last.text.trimEnd();
  return words;
}

export function parseLrc(text: string): SongLyrics | null {
  const timed: LyricLine[] = [];
  const plain: LyricLine[] = [];
  let offset = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (META_RE.test(line)) continue;
    const off = line.match(/^\[offset:\s*([+-]?\d+)\s*\]$/i);
    if (off) {
      offset = parseInt(off[1], 10) || 0;
      continue;
    }
    // Timestamps at the start (a line can have several: choruses).
    const starts: number[] = [];
    let pos = 0;
    for (;;) {
      STAMP_RE.lastIndex = pos;
      const m = STAMP_RE.exec(line);
      if (!m) break;
      starts.push(stampMs(m));
      pos = STAMP_RE.lastIndex;
    }
    const rest = line.slice(pos).trim();
    if (starts.length === 0) {
      plain.push({ value: line });
      continue;
    }
    // Word times are absolute, so a chorus line written once with several
    // stamps can only be right for one of its repeats: the words go with the
    // stamp nearest the first of them, and the other repeats are plain lines.
    const words = parseWords(rest, starts[0]);
    const value = words ? words.map((w) => w.text).join('') : rest;
    const owner = words?.length
      ? starts.reduce((a, b) => (Math.abs(b - words[0].start) < Math.abs(a - words[0].start) ? b : a))
      : undefined;
    for (const start of starts) {
      timed.push(words && start === owner ? { start, value, words } : { start, value });
    }
  }

  if (timed.length > 0) {
    // Positive `offset` = lyrics should appear earlier (same convention as
    // OpenSubsonic offset).
    timed.sort((a, b) => a.start! - b.start!);
    return {
      synced: true,
      lines: timed.map((l) => ({
        ...l,
        start: Math.max(0, l.start! - offset),
        ...(l.words
          ? { words: l.words.map((w) => ({ ...w, start: Math.max(0, w.start - offset) })) }
          : {}),
      })),
    };
  }
  if (plain.length > 0) return { synced: false, lines: plain };
  return null;
}

/** `mm:ss.xx`, the way LRC writes a time, without its brackets. */
function stamp(ms: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const clamped = Math.max(0, Math.round(ms));
  const min = Math.floor(clamped / 60000);
  const sec = Math.floor((clamped % 60000) / 1000);
  const cs = Math.floor((clamped % 1000) / 10);
  return `${pad(min)}:${pad(sec)}.${pad(cs)}`;
}

/** Serializes to LRC text (or plain text if lyrics are unsynced). Lines that
 *  know their words write them enhanced, so a file read back says the same. */
export function serializeLrc(lyrics: SongLyrics): string {
  return lyrics.lines
    .map((l) => {
      if (!lyrics.synced || l.start === undefined) return l.value;
      const body = l.words?.length
        ? l.words.map((w) => `<${stamp(w.start)}>${w.text}`).join('')
        : l.value;
      return `[${stamp(l.start)}]${body}`;
    })
    .join('\n');
}
