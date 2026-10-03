/**
 * The alarm on its own: when it next rings, what a saved one reads back as,
 * and how loud it is during its rise.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { alarmRampLevel, type AlarmConfig, DEFAULT_ALARM, nextAlarm, parseAlarm } from '@/lib/alarm';

const alarm = (patch: Partial<AlarmConfig>): AlarmConfig => ({ ...DEFAULT_ALARM, enabled: true, ...patch });
// Wednesday 1 October 2025, 06:00 local time.
const wednesday = (h: number, m = 0) => new Date(2025, 9, 1, h, m);

describe('nextAlarm', () => {
  it('rings today when the time is still ahead', () => {
    assert.deepEqual(nextAlarm(alarm({ hour: 7, minute: 30, days: [3] }), wednesday(6)), new Date(2025, 9, 1, 7, 30));
  });

  it('goes to the next ticked day once today’s time has passed', () => {
    assert.deepEqual(nextAlarm(alarm({ hour: 7, days: [1, 2, 3, 4, 5] }), wednesday(8)), new Date(2025, 9, 2, 7, 0));
  });

  it('waits for next week when only today is ticked and the time has passed', () => {
    assert.deepEqual(nextAlarm(alarm({ hour: 7, days: [3] }), wednesday(7)), new Date(2025, 9, 8, 7, 0));
  });

  it('skips the weekend', () => {
    // Friday 3 October, after the time: Monday the 6th.
    assert.deepEqual(nextAlarm(alarm({ hour: 7, days: [1, 2, 3, 4, 5] }), new Date(2025, 9, 3, 9)), new Date(2025, 9, 6, 7, 0));
  });

  it('never rings when off or with no day', () => {
    assert.deepEqual([nextAlarm(alarm({ enabled: false }), wednesday(6)), nextAlarm(alarm({ days: [] }), wednesday(6))], [null, null]);
  });
});

describe('parseAlarm', () => {
  it('reads back what was saved', () => {
    const saved = alarm({ what: 'playlist', playlistId: 'p1', where: 'speaker', rampMinutes: 10 });
    assert.deepEqual(parseAlarm(JSON.parse(JSON.stringify(saved))), saved);
  });

  it('refuses what is not an alarm, and mends a bad field', () => {
    assert.deepEqual(
      [parseAlarm(null), parseAlarm({ enabled: true, hour: 25, minute: 0 }), parseAlarm({ ...alarm({}), days: [5, 9, 5, 1], what: 'radio' })],
      [null, null, alarm({ days: [1, 5] })],
    );
  });
});

describe('alarmRampLevel', () => {
  it('rises from silence to the target', () => {
    assert.deepEqual([alarmRampLevel(0.6, 1000, 0), alarmRampLevel(0.6, 1000, 500), alarmRampLevel(0.6, 1000, 5000)], [0, 0.3, 0.6]);
  });

  it('is the target at once with no rise', () => {
    assert.equal(alarmRampLevel(0.6, 0, 0), 0.6);
  });
});
