/**
 * The Jam on the car's Home: one row that opens a session where none is on,
 * a folder named after the code where one is, with the code as a tile whose
 * picture is the QR code the proxy draws, and the QR code standing in for
 * the cover for a while after it was asked for.
 *
 * The clock is faked: the QR code's two minutes are a real timer otherwise,
 * and the runner waits for it before it exits.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { JamSession } from '@/lib/jam';
import {
  handleJamTap,
  jamFolderRows,
  jamHomeRow,
  jamQrOnCar,
  jamSpokenRow,
  QR_ON_SCREEN_MS,
  showJamQrOnCar,
} from '@/lib/carJam';
import { setNavifindActive } from '@/lib/navifind';
import { useJam } from '@/store/jam';

import { serverProfile, useAuthStore } from './stubs/store-auth';
import { resetPlayer } from './stubs/store-player';
import { useToast } from './stubs/store-toast';

function session(members = 1): JamSession {
  return {
    code: 'ABC234',
    version: 1,
    hostId: 'h',
    members: Array.from({ length: members }, (_, i) => ({ id: `m${i}`, name: `Guest ${i}` })),
    queue: [],
    index: 0,
    playing: true,
    anchorAt: 0,
    anchorPos: 0,
    positionMs: 0,
  };
}

describe('the Jam on the car\'s Home', () => {
  // The QR code's deadline is state of the module, so each test starts well
  // after the one before could have set it.
  let now = Date.UTC(2026, 9, 25);

  beforeEach(() => {
    now += 2 * QR_ON_SCREEN_MS;
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
    setNavifindActive(true);
    useAuthStore.setState({ auth: serverProfile(), offline: false });
    useJam.setState({ session: null, me: '' });
    resetPlayer();
  });

  afterEach(() => {
    mock.timers.reset();
    useJam.setState({ session: null, me: '' });
  });

  it('is a row that opens a Jam while none is on', () => {
    assert.equal(jamHomeRow()?.id, 'jam:start');
  });

  it('is nothing without the proxy', () => {
    setNavifindActive(false);
    assert.equal(jamHomeRow(), null);
  });

  it('is nothing offline', () => {
    useAuthStore.setState({ offline: true });
    assert.equal(jamHomeRow(), null);
  });

  it('is a folder named after the code once a Jam is on', () => {
    useJam.setState({ session: session(3), me: 'm0' });
    assert.deepEqual([jamHomeRow()?.id, jamHomeRow()?.title, jamHomeRow()?.subtitle], ['jam', 'Jam ABC234', '3 listening']);
  });

  it('puts the QR code of the join page on the tile, marked for the phone to fetch as PNG', () => {
    useJam.setState({ session: session(), me: 'm0' });
    assert.equal(
      jamFolderRows()[0]?.artworkUrl,
      'cached-cover:https://music.example/rest/navifind/jam/qr?code=ABC234&format=png',
    );
  });

  it('holds nothing while no Jam is on', () => {
    assert.deepEqual(jamFolderRows(), []);
  });

  it('opens no Jam over silence, and says why', async () => {
    await handleJamTap('jam:start');
    assert.deepEqual(
      [useToast.getState().messages.at(-1), useJam.getState().session],
      ['Play something first: the Jam shares what is playing', null],
    );
  });

  it('lands "start a Jam" on the row that opens one while none is on, and "stop the Jam" nowhere', () => {
    assert.deepEqual([jamSpokenRow('start')?.id, jamSpokenRow('end')], ['jam:start', null]);
  });

  it('lands "stop the Jam" on the row that ends it once one is on, and "start a Jam" nowhere', () => {
    useJam.setState({ session: session(), me: 'h' });
    assert.deepEqual([jamSpokenRow('end')?.id, jamSpokenRow('start')], ['jam:end', null]);
  });

  it('shows the QR code in place of the cover once asked, and only with a session to join', () => {
    useJam.setState({ session: session(), me: 'm0' });
    const before = jamQrOnCar();
    showJamQrOnCar();
    const shown = jamQrOnCar();
    useJam.setState({ session: null, me: '' });
    assert.deepEqual([before, !!shown, jamQrOnCar()], [undefined, true, undefined]);
  });

  it('gives the cover back once the two minutes are up', () => {
    useJam.setState({ session: session(), me: 'm0' });
    showJamQrOnCar();
    mock.timers.tick(QR_ON_SCREEN_MS);
    assert.equal(jamQrOnCar(), undefined);
  });
});
