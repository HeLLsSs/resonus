import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { commonStep, type CommonMemory } from '../src/lib/commonAccountAlert';
import type { CommonAccount } from '../src/lib/youtube';

const nothing: CommonMemory = { token: null, cookie: null };
const both = (token: CommonAccount['token'], cookie: CommonAccount['cookie']): CommonAccount => ({ user: 'proxy', token, cookie });

describe('commonStep', () => {
  it('says nothing while both links work', () => {
    const step = commonStep(nothing, both('ok', 'ok'));
    assert.deepEqual(step, { next: { token: 'ok', cookie: 'ok' }, report: [], dismiss: false });
  });

  it('reports a link the moment it drops, once', () => {
    const first = commonStep({ token: 'ok', cookie: 'ok' }, both('ok', 'expired'));
    assert.deepEqual(first.report, ['cookie']);
    assert.deepEqual(commonStep(first.next, both('ok', 'expired')).report, []);
  });

  it('reports the token as well when Google stops renewing it', () => {
    assert.deepEqual(commonStep({ token: 'ok', cookie: 'ok' }, both('refused', 'ok')).report, ['token']);
  });

  it('takes the notification away once everything works again', () => {
    assert.equal(commonStep({ token: 'ok', cookie: 'down' }, both('ok', 'ok')).dismiss, true);
  });

  it('learns nothing from a link never set up, or a proxy that could not tell', () => {
    const step = commonStep({ token: 'ok', cookie: 'ok' }, both('off', 'unreachable'));
    assert.deepEqual(step, { next: { token: 'ok', cookie: 'ok' }, report: [], dismiss: false });
    assert.deepEqual(commonStep(nothing, both('none', 'none')).report, []);
  });
});
