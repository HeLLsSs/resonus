/**
 * What a phrase said into the helmet asks for: one of the few commands, in
 * French or English, or a search for everything else.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { interpretCommand } from '@/lib/rideVoice';

describe('interpretCommand', () => {
  it('reads a command in either language, whatever the case or accents', () => {
    assert.deepEqual(interpretCommand('Suivant'), { kind: 'next' });
    assert.deepEqual(interpretCommand('precedent'), { kind: 'previous' });
    assert.deepEqual(interpretCommand(' PAUSE '), { kind: 'toggle' });
    assert.deepEqual(interpretCommand('mes favoris'), { kind: 'favorites' });
    assert.deepEqual(interpretCommand('shuffle'), { kind: 'random' });
    assert.deepEqual(interpretCommand('la radio'), { kind: 'radio' });
  });

  it('takes anything else as a search, as said', () => {
    assert.deepEqual(interpretCommand('Next to You'), { kind: 'search', query: 'Next to You' });
    assert.deepEqual(interpretCommand('daft punk'), { kind: 'search', query: 'daft punk' });
  });

  it('asks for nothing when nothing was said', () => {
    assert.deepEqual(interpretCommand('  '), { kind: 'nothing' });
  });
});
