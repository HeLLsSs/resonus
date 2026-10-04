/**
 * The weekly report: where a week starts and ends, when the report is due,
 * which songs make the playlist, and what the notification says.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { rankSongs, reportDue, reportTime, weekKey, weeklyMessage, weekStart } from '@/lib/weeklyReport';

/** Local time, as the phone reads it. October 2026: the 5th is a Monday. */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);

describe('weekStart', () => {
  it('is the Monday at midnight for a day in the week', () => {
    assert.deepEqual(weekStart(at(8, 15)), at(5, 0));
  });

  it('keeps Sunday in the week that began on the Monday before', () => {
    assert.deepEqual(weekStart(at(11, 23, 59)), at(5, 0));
  });

  it('starts a new week on Monday at midnight', () => {
    assert.deepEqual(weekStart(at(12, 0)), at(12, 0));
  });

  it('crosses a month', () => {
    assert.deepEqual(weekStart(new Date(2026, 10, 1, 12)), at(26, 0));
  });
});

describe('weekKey', () => {
  it('names the week by its Monday', () => {
    assert.equal(weekKey(at(11, 20)), '2026-10-05');
  });
});

describe('reportTime', () => {
  it('is the Sunday at 19:00', () => {
    assert.deepEqual(reportTime(at(6, 9)), at(11, 19));
  });

  it('stays at 19:00 across the change of clocks', () => {
    // Europe goes back an hour on the last Sunday of October.
    assert.equal(reportTime(at(26, 9)).getHours(), 19);
  });
});

describe('reportDue', () => {
  it('waits for Sunday evening', () => {
    assert.equal(reportDue(at(11, 18, 59), null), false);
  });

  it('is due from 19:00 on Sunday', () => {
    assert.equal(reportDue(at(11, 19), null), true);
  });

  it('is due later that evening when the phone was off at seven', () => {
    assert.equal(reportDue(at(11, 22), '2026-09-28'), true);
  });

  it('is made once a week', () => {
    assert.equal(reportDue(at(11, 21), '2026-10-05'), false);
  });

  it('is not due on Monday for the week that just ended', () => {
    assert.equal(reportDue(at(12, 8), '2026-09-28'), false);
  });
});

describe('rankSongs', () => {
  it('puts the most played first and keeps the order of equal counts', () => {
    const rows = [
      { songId: 'a', plays: 2 },
      { songId: 'b', plays: 5 },
      { songId: 'c', plays: 2 },
    ];
    assert.deepEqual(rankSongs(rows), ['b', 'a', 'c']);
  });

  it('keeps thirty at most', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ songId: String(i), plays: 40 - i }));
    assert.equal(rankSongs(rows).length, 30);
  });
});

describe('weeklyMessage', () => {
  it('says the hours and the top artist', () => {
    assert.equal(weeklyMessage(12.4 * 3600, 'Daft Punk'), 'Your week: 12 hours, top artist Daft Punk');
  });

  it('says one hour in the singular', () => {
    assert.equal(weeklyMessage(3700, 'X'), 'Your week: 1 hour, top artist X');
  });

  it('counts minutes under an hour', () => {
    assert.equal(weeklyMessage(25 * 60), 'Your week: 25 minutes');
  });
});
