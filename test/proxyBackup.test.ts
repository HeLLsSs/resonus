/** What leaves the phone for the proxy's copy of the settings, what comes back, and when it is offered. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { settingsAreDefault, stripSecrets, withLocalSecrets } from '@/lib/proxyBackup';

describe('stripSecrets', () => {
  const payload = {
    profiles: [
      { _type: 'server', username: 'ana', serverUrl: 'https://music.example', token: 't', salt: 's', password: 'p', headers: { 'CF-Access-Client-Secret': 'shh' } },
      { _type: 'offline', name: 'Phone' },
    ],
    data: {
      'resonus.settings.abc': JSON.stringify({ navifind: true, listenBrainzToken: 'lb', listenBrainzUser: 'ana' }),
      'resonus.language': 'fr',
      'resonus.smartPlaylists.abc': '[{"id":"1"}]',
    },
    skipped: 0,
  };

  it('takes every sign-in field off the profiles', () => {
    assert.deepEqual(stripSecrets(payload).profiles, [
      { _type: 'server', username: 'ana', serverUrl: 'https://music.example' },
      { _type: 'offline', name: 'Phone' },
    ]);
  });

  it('takes the ListenBrainz token and its user out of a settings blob', () => {
    assert.equal(stripSecrets(payload).data['resonus.settings.abc'], '{"navifind":true}');
  });

  it('leaves a blob that is not a JSON object as it is', () => {
    const { data } = stripSecrets(payload);
    assert.deepEqual([data['resonus.language'], data['resonus.smartPlaylists.abc']], ['fr', '[{"id":"1"}]']);
  });
});

describe('withLocalSecrets', () => {
  it("puts this phone's ListenBrainz pair back into the proxy's blob", () => {
    const local = JSON.stringify({ navifind: false, listenBrainzToken: 'lb', listenBrainzUser: 'ana' });
    assert.deepEqual(JSON.parse(withLocalSecrets('{"navifind":true}', local)), {
      navifind: true,
      listenBrainzToken: 'lb',
      listenBrainzUser: 'ana',
    });
  });

  it('keeps the incoming blob when there is nothing on the phone', () => {
    assert.equal(withLocalSecrets('{"navifind":true}', null), '{"navifind":true}');
  });
});

describe('settingsAreDefault', () => {
  const defaults = { hydrated: false, language: 'en', navifind: false, backupToProxy: true, crossfadeSec: 0, hydrate: () => {} };

  it('takes factory settings with Navifind turned on as a fresh install', () => {
    assert.equal(settingsAreDefault({ ...defaults, hydrated: true, language: 'fr', navifind: true }, defaults), true);
  });

  it('does not once something was chosen on this phone', () => {
    assert.equal(settingsAreDefault({ ...defaults, crossfadeSec: 5 }, defaults), false);
  });
});
