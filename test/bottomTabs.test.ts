/** Which tabs a profile is offered, and what a drag in that shorter list means. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reorderUsable, shownTabs, usableTabs, type TabToggle } from '@/lib/bottomTabs';

const saved: TabToggle[] = [
  { key: 'index', enabled: true },
  { key: 'search', enabled: true },
  { key: 'youtube', enabled: true },
  { key: 'explore', enabled: false },
  { key: 'library', enabled: true },
];

const keys = (tabs: TabToggle[]) => tabs.map((tab) => tab.key);

describe('usableTabs', () => {
  it('leaves the YouTube tab out for a profile with no proxy', () => {
    assert.deepEqual(keys(usableTabs(saved, false)), ['index', 'search', 'explore', 'library']);
  });

  it('offers it once the proxy is switched on', () => {
    assert.ok(keys(usableTabs(saved, true)).includes('youtube'));
  });
});

describe('shownTabs', () => {
  it('draws the ones that are kept, in the saved order', () => {
    assert.deepEqual(keys(shownTabs(saved, true)), ['index', 'search', 'youtube', 'library']);
  });

  it('never draws a tab the profile has nothing behind, kept or not', () => {
    assert.deepEqual(keys(shownTabs(saved, false)), ['index', 'search', 'library']);
  });
});

describe('reorderUsable', () => {
  it('moves the tab the short list dragged, saying it in the full list', () => {
    // Third of four ("library") to the front, on a profile without the proxy.
    const next = reorderUsable(saved, false, 3, 0);
    assert.deepEqual(keys(next), ['library', 'index', 'youtube', 'search', 'explore']);
  });

  it('leaves the tab nobody can see in the slot it had', () => {
    const next = reorderUsable(saved, false, 0, 1);
    assert.equal(keys(next).indexOf('youtube'), 2);
  });

  it('moves what was asked for when every tab is on the list', () => {
    const next = reorderUsable(saved, true, 2, 0);
    assert.deepEqual(keys(next), ['youtube', 'index', 'search', 'explore', 'library']);
  });

  it('changes nothing when the drag says a position that is not there', () => {
    assert.deepEqual(reorderUsable(saved, false, 0, 4), saved);
  });
});
