/**
 * When YouTube counts as out through the proxy, and what gets said about it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SourceHealth, SourceState } from '@/api/subsonic';
import { outageReason, outageStep, youtubeVerdict } from '@/lib/outageAlert';

const h = (state: SourceState, deno = true): SourceHealth => ({ state, deno });
const paths = (invidious: SourceState, piped: SourceState, ytdlp: SourceState) => ({
  invidious: h(invidious),
  piped: h(piped),
  ytdlp: h(ytdlp),
});

describe('youtubeVerdict', () => {
  it('is down when every path is down', () => {
    assert.equal(youtubeVerdict(paths('down', 'down', 'down')), 'down');
  });
  it('counts a mirror that is not set up as down', () => {
    assert.equal(youtubeVerdict(paths('off', 'down', 'down')), 'down');
  });
  it('is up while yt-dlp alone answers', () => {
    assert.equal(youtubeVerdict(paths('off', 'off', 'ok')), 'up');
  });
  it('is not down when yt-dlp is not installed rather than failing', () => {
    assert.equal(youtubeVerdict(paths('down', 'down', 'off')), 'unknown');
  });
  it('knows nothing before anything was noted', () => {
    assert.equal(youtubeVerdict(paths('unknown', 'unknown', 'unknown')), 'unknown');
  });
});

describe('outageStep', () => {
  it('says so when YouTube goes out', () => {
    assert.deepEqual(outageStep('up', 'down'), { next: 'down', notify: 'down', dismiss: false });
  });
  it('says so the first time it is seen out', () => {
    assert.equal(outageStep(null, 'down').notify, 'down');
  });
  it('does not repeat itself while out', () => {
    assert.equal(outageStep('down', 'down').notify, null);
  });
  it('says so when YouTube comes back', () => {
    assert.deepEqual(outageStep('down', 'up'), { next: 'up', notify: 'up', dismiss: false });
  });
  it('says nothing when it was never out', () => {
    assert.equal(outageStep(null, 'up').notify, null);
  });
  it('keeps what was said when the proxy cannot tell', () => {
    assert.deepEqual(outageStep('down', 'unknown'), { next: 'down', notify: null, dismiss: false });
  });
  it('clears the alert quietly when a check by hand finds it back', () => {
    assert.deepEqual(outageStep('down', 'up', true), { next: 'up', notify: null, dismiss: true });
  });
});

describe('outageReason', () => {
  it('names each path and why', () => {
    const sources = { invidious: h('down'), piped: h('off'), ytdlp: h('down', false) };
    assert.equal(
      outageReason(sources, (text) => text),
      'Invidious: Not answering · Piped: Not configured · yt-dlp: deno is missing, so YouTube cannot be read',
    );
  });
});
