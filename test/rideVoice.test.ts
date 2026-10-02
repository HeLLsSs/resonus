/**
 * What a phrase said into the helmet asks for: one of the few commands, in
 * French or English, or a search for everything else. And the other way,
 * the status read out at the start of a ride as one sentence.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { tg } from '@/i18n';
import { interpretCommand, statusSentence } from '@/lib/rideVoice';

describe('interpretCommand', () => {
  it('reads a command in either language, whatever the case or accents', () => {
    assert.deepEqual(interpretCommand('Suivant'), { kind: 'next' });
    assert.deepEqual(interpretCommand('precedent'), { kind: 'previous' });
    assert.deepEqual(interpretCommand(' PAUSE '), { kind: 'toggle' });
    assert.deepEqual(interpretCommand('mes favoris'), { kind: 'favorites' });
    assert.deepEqual(interpretCommand('shuffle'), { kind: 'random' });
    assert.deepEqual(interpretCommand('la radio'), { kind: 'radio' });
    assert.deepEqual(interpretCommand('Statut'), { kind: 'status' });
  });

  it('takes anything else as a search, as said', () => {
    assert.deepEqual(interpretCommand('Next to You'), { kind: 'search', query: 'Next to You' });
    assert.deepEqual(interpretCommand('daft punk'), { kind: 'search', query: 'daft punk' });
  });

  it('asks for nothing when nothing was said', () => {
    assert.deepEqual(interpretCommand('  '), { kind: 'nothing' });
  });
});

/** The French dictionary as it ships, so the sentence is checked in the language it is said in. */
const FR: Record<string, string> = JSON.parse(readFileSync(new URL('../src/i18n/locales/fr.json', import.meta.url), 'utf8'));
const fr = (text: string, vars?: Record<string, string | number>) => tg(FR[text] ?? text, vars);

describe('statusSentence', () => {
  it('reads the battery, the output and what is left of the queue, in that order', () => {
    assert.equal(
      statusSentence({ battery: { level: 80, charging: false }, output: 'WiiM', remaining: 12 }),
      'battery at 80 %, playing on WiiM, 12 songs left in the queue.',
    );
  });

  it('says it in French', () => {
    assert.equal(
      statusSentence({ battery: { level: 80, charging: false }, output: 'WiiM', remaining: 12 }, fr),
      'batterie à 80 %, lecture sur WiiM, encore 12 titres dans la file.',
    );
  });

  it('leaves out the phone as the output and a battery not heard of yet', () => {
    assert.equal(statusSentence({ battery: null, output: '', remaining: 3 }), '3 songs left in the queue.');
  });

  it('says the battery is charging', () => {
    assert.equal(
      statusSentence({ battery: { level: 45, charging: true }, output: '', remaining: 1 }),
      'battery at 45 %, charging, one song left in the queue.',
    );
  });

  it('tells the last song from an empty queue', () => {
    assert.equal(statusSentence({ battery: null, output: '', remaining: 0 }), 'last song of the queue.');
    assert.equal(statusSentence({ battery: null, output: '', remaining: null }), 'nothing in the queue.');
  });
});
