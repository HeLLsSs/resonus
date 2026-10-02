/**
 * The crash log's pure parts: how the file is kept under its cap, and how its
 * entries are read back for the diagnostics screen.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { crashEntries, trimLog } from '@/lib/crashLog';

const entry = (n: number) => `2026-10-02T10:00:0${n}.000Z  JS  Error: boom ${n}\n    at here\n\n`;

describe('trimLog', () => {
  it('leaves a short log alone', () => {
    const text = entry(1) + entry(2);
    assert.equal(trimLog(text, 1000), text);
  });

  it('drops the oldest half at an entry boundary once past the cap', () => {
    // Four entries of one length: the midpoint is where the third starts, and
    // the first boundary from there on is its end, so the fourth is kept whole.
    const text = entry(1) + entry(2) + entry(3) + entry(4);
    const kept = trimLog(text, text.length - 1);
    assert.equal(kept, entry(4));
  });

  it('cuts in the middle when there is no boundary to cut at', () => {
    assert.equal(trimLog('abcdefgh', 4), 'efgh');
  });
});

describe('crashEntries', () => {
  it('reads entries newest first, trimmed, without the blanks', () => {
    const entries = crashEntries(entry(1) + entry(2) + '\n\n');
    assert.deepEqual(entries, [entry(2).trim(), entry(1).trim()]);
  });

  it('keeps at most the limit', () => {
    assert.equal(crashEntries(entry(1) + entry(2) + entry(3), 2).length, 2);
  });

  it('is empty for an empty file', () => {
    assert.deepEqual(crashEntries(''), []);
  });
});
