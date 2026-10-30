/**
 * What the car says of the songs the guests put in the Jam: a title for one,
 * a count for a burst, one line per guest, in French as in English.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { tg } from '@/i18n';
import { additionSentences } from '@/lib/jamVoice';

/** The French dictionary as it ships, so the line is checked in the language it is said in. */
const FR: Record<string, string> = JSON.parse(readFileSync(new URL('../src/i18n/locales/fr.json', import.meta.url), 'utf8'));
const fr = (text: string, vars?: Record<string, string | number>) => tg(FR[text] ?? text, vars);

describe('additionSentences', () => {
  const burst = [
    { name: 'Léa', title: 'Hey Jude' },
    { name: 'Max', title: 'A' },
    { name: 'Max', title: 'B' },
  ];

  it('says the title for one song and a count for more, one line per guest in order', () => {
    assert.deepEqual(additionSentences(burst), ['Léa added Hey Jude', 'Max added 2 songs']);
  });

  it('speaks of a guest who has left since as a guest', () => {
    assert.deepEqual(additionSentences([{ name: '', title: 'X' }]), ['A guest added X']);
  });

  it('says it in French as the app does', () => {
    assert.deepEqual(additionSentences(burst, fr), ['Léa a ajouté Hey Jude', 'Max a ajouté 2 titres']);
  });
});
