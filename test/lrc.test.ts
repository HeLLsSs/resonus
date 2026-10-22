/**
 * The line of synced lyrics being sung at a moment of the song, which is
 * what goes on the car's screen (`lib/carLyrics.ts`).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { lineAt } from '@/lib/lrc';

const lines = [
  { start: 1_000, value: 'First line' },
  { start: 4_000, value: '' },
  { start: 6_000, value: '  Second line ' },
];

describe('lineAt', () => {
  it('has nothing before the first line', () => {
    assert.equal(lineAt(lines, 500), null);
  });

  it('gives the line whose start has passed, trimmed', () => {
    assert.deepEqual([lineAt(lines, 1_000), lineAt(lines, 3_999), lineAt(lines, 9_000)], ['First line', 'First line', 'Second line']);
  });

  it('has nothing in the gap an empty line marks', () => {
    assert.equal(lineAt(lines, 5_000), null);
  });

  it('has nothing for lyrics with no times', () => {
    assert.equal(lineAt([{ value: 'Plain' }], 10_000), null);
  });
});
