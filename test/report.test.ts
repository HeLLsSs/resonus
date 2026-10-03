/**
 * The problem report: that nothing leading to the server or the account
 * leaves the phone, that a GitHub link stays under the length GitHub takes,
 * and that the sections come in the order they are read.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildReport,
  ISSUE_BODY_MAX,
  ISSUE_URL_MAX,
  issueUrl,
  MAIL_BODY_MAX,
  mailtoUrl,
  redact,
  REPORT_EMAIL,
  type ReportInput,
} from '@/lib/report';

const input = (over: Partial<ReportInput> = {}): ReportInput => ({
  text: 'Playback stops after a minute',
  version: '1.8.3 (95)',
  device: 'Android 14 (API 34), samsung SM-S911B',
  serverType: 'navidrome',
  crashLog: [],
  carLog: '',
  ...over,
});

describe('redact', () => {
  it('replaces the host of an address, credentials and port included', () => {
    assert.equal(
      redact('GET https://ana:pw@music.example.com:4533/rest/ping.view'),
      'GET https://<host>/rest/ping.view',
    );
  });

  for (const key of ['u', 't', 's', 'p', 'apiKey', 'token']) {
    it(`empties the value of ${key}=`, () => {
      assert.equal(redact(`/rest/stream.view?id=7&${key}=secret42&f=json`), `/rest/stream.view?id=7&${key}=<redacted>&f=json`);
    });
  }

  it('leaves a parameter that only ends like a sensitive one', () => {
    assert.equal(redact('menu=open'), 'menu=open');
  });

  it('takes out cookie and authorization headers and bearer tokens', () => {
    const out = redact('Cookie: session=abc123\nAuthorization: Bearer xyz\nsent Bearer qwe.rty');
    assert.equal(out, 'Cookie: <redacted>\nAuthorization: <redacted>\nsent Bearer <redacted>');
  });

  it('replaces a bare IPv4 address', () => {
    assert.equal(redact('timeout reaching 192.168.1.20:4533'), 'timeout reaching <host>');
  });

  it('takes out the given secrets and the host of a given address, wherever they are', () => {
    const out = redact('ana cannot reach music.example.com from home', ['ana', 'https://music.example.com:4533/']);
    assert.equal(out, '<redacted> cannot reach <redacted> from home');
  });
});

describe('buildReport', () => {
  it('never carries the server, the username or a stream URL', () => {
    const url = 'https://ana:pw@music.example.com/rest/stream.view?id=1&u=ana&t=deadbeef&s=salty&p=enc:7077';
    const { title, body } = buildReport(
      input({
        text: `It broke on ${url}`,
        crashLog: [`Error: fetch failed ${url}`],
        carLog: `play ${url}\nCookie: jam=1`,
        secrets: ['ana', 'https://music.example.com'],
      }),
      MAIL_BODY_MAX,
    );
    for (const leak of ['music.example.com', 'ana', 'deadbeef', 'salty', 'enc:7077', 'jam=1', url]) {
      assert.ok(!`${title}\n${body}`.includes(leak), `leaked ${leak}`);
    }
  });

  it('keeps a GitHub link under the length GitHub takes', () => {
    const report = buildReport(
      input({
        text: `${'é'.repeat(200)}\n${'word '.repeat(3000)}`,
        crashLog: Array.from({ length: 20 }, (_, i) => `Error ${i}\n${'    at frame (file.js:1:2)\n'.repeat(80)}`),
        carLog: Array.from({ length: 500 }, (_, i) => `line ${i} 😀`).join('\n'),
      }),
      ISSUE_BODY_MAX,
    );
    assert.ok(issueUrl(report).length <= ISSUE_URL_MAX, `${issueUrl(report).length} characters`);
  });

  it('puts the text, the environment, the crashes and the car log in that order, newest first', () => {
    const { body } = buildReport(
      input({ crashLog: ['newest crash', 'older crash'], carLog: 'old line\nnew line' }),
      MAIL_BODY_MAX,
    );
    const at = (s: string) => body.indexOf(s);
    const order = ['Playback stops', '### Environment', 'newest crash', 'older crash', '### Android Auto', 'new line', 'old line'].map(at);
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
  });
});

describe('links', () => {
  it('opens a bug issue on the repository', () => {
    assert.equal(
      issueUrl({ title: 'a b', body: 'c&d' }),
      'https://github.com/HeLLsSs/resonus/issues/new?title=a%20b&body=c%26d&labels=bug',
    );
  });

  it('writes to the report address', () => {
    assert.equal(mailtoUrl({ title: 'a', body: 'b' }), `mailto:${REPORT_EMAIL}?subject=a&body=b`);
  });
});
