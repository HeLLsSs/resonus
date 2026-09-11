/**
 * Where the JS thread goes.
 *
 * Two instruments. A heartbeat that notices when the thread was busy, by how
 * late its own timer fires, and a stopwatch around the operations we suspect.
 * Both ship in the app: a report from the phone that actually has the problem
 * beats any amount of reading the code from here (#50).
 *
 * The cost of measuring is a timer every quarter second and two `Date.now()`
 * per measured operation, so it can stay on for everyone.
 */

import { AppState } from 'react-native';

/**
 * Whether any of this runs at all.
 *
 * The measuring is meant to be cheap enough to leave on for everyone: a timer
 * four times a second and two `Date.now()` per measured operation. Cheap is not
 * the same as free, though, and somebody chasing a slow app is right to want it
 * out of the way before believing anything else. So it can be turned off, from
 * Settings › About, and off means off: no heartbeat, no stopwatch, no counting.
 */
let enabled = true;

/** Turned on and off from the setting; off clears what was collected. */
export function setPerfEnabled(on: boolean): void {
  if (on === enabled) return;
  enabled = on;
  if (on) {
    startPerfLog();
    return;
  }
  if (timer) clearInterval(timer);
  timer = null;
  resetPerfLog();
}

export function perfEnabled(): boolean {
  return enabled;
}

/** How often the heartbeat checks in. */
const TICK_MS = 250;
/** Under this, being late is ordinary scheduling noise rather than a block. */
const BLOCK_MS = 120;
/** Worst blocks kept. Enough to see a pattern, small enough to read. */
const MAX_BLOCKS = 15;

export interface Block {
  /** When it happened. */
  at: number;
  /** How much longer than expected the thread took to come back. */
  ms: number;
  /** What was in flight at the time, if anything. A hint, not a verdict. */
  during: string;
}

export interface OpStat {
  tag: string;
  count: number;
  totalMs: number;
  maxMs: number;
}

let startedAt = 0;
let lastTick = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const blocks: Block[] = [];
const ops = new Map<string, OpStat>();
/** Operations in flight, for `during`. */
const running: string[] = [];

/**
 * Is the app in the foreground?
 *
 * Watched from module scope, and not from inside `startPerfLog`, because the
 * heartbeat below is not the only instrument that needs to know: the player's
 * own beat is measured precisely when this is false. One listener and a
 * boolean, so it costs the same whether or not anything is being measured.
 */
let awake = AppState.currentState === 'active';
AppState.addEventListener('change', (state) => {
  const wasAwake = awake;
  awake = state === 'active';
  // Whatever happened out there is not ours to measure, and the clock starts
  // again here.
  lastTick = Date.now();
  if (!wasAwake && awake) onReturn();
});

/**
 * Starts the heartbeat (idempotent).
 *
 * The app being in the background is not a block. Android stops handing the
 * timer its turn out there, so coming back after ten seconds away looked like a
 * ten second freeze, and those went straight to the top of the report where
 * they were the first thing anybody read. The state is watched for that reason,
 * and the tick after a return is skipped rather than blamed.
 */
export function startPerfLog(): void {
  if (timer || !enabled) return;
  startedAt = Date.now();
  lastTick = Date.now();
  timer = setInterval(() => {
    const now = Date.now();
    const late = now - lastTick - TICK_MS;
    lastTick = now;
    if (!awake || late < BLOCK_MS) return;
    const block: Block = { at: now, ms: late, during: running[running.length - 1] ?? '—' };
    // In development it also goes to the console, where whoever is driving the
    // app can see it land on the screen that caused it.
    if (__DEV__) console.log(`[perf] BLOCK ${late} ms · during ${block.during}`);
    // The worst ones are kept, not the last ones: a single two second freeze
    // matters more than the twenty small ones that came after it.
    if (blocks.length < MAX_BLOCKS) {
      blocks.push(block);
      return;
    }
    let worstIdx = 0;
    for (let i = 1; i < blocks.length; i++) {
      if (blocks[i].ms < blocks[worstIdx].ms) worstIdx = i;
    }
    if (block.ms > blocks[worstIdx].ms) blocks[worstIdx] = block;
  }, TICK_MS);
}

/** Anything slower than this gets its own line in the development console. */
const LOUD_MS = 100;

function record(tag: string, ms: number): void {
  if (__DEV__ && ms >= LOUD_MS) console.log(`[perf] ${tag} · ${ms} ms`);
  const cur = ops.get(tag);
  if (cur) {
    cur.count++;
    cur.totalMs += ms;
    if (ms > cur.maxMs) cur.maxMs = ms;
  } else {
    ops.set(tag, { tag, count: 1, totalMs: ms, maxMs: ms });
  }
}

/**
 * Records something already measured, for what cannot be wrapped in a call:
 * how long the thread took to come back after a navigation, say.
 */
export function mark(tag: string, ms: number): void {
  if (!enabled) return;
  record(tag, ms);
}

/**
 * Times an async operation. Note this is wall time, waiting included, so for
 * anything that goes to the network it says how long the answer took, not how
 * busy the thread was. Reading the response is timed apart, and that one IS
 * the thread.
 */
export async function timed<T>(tag: string, fn: () => Promise<T>): Promise<T> {
  // Not even the two `Date.now()`, so that a session with this off is the app
  // with nothing of this in it.
  if (!enabled) return fn();
  const t0 = Date.now();
  running.push(tag);
  try {
    return await fn();
  } finally {
    const i = running.lastIndexOf(tag);
    if (i >= 0) running.splice(i, 1);
    record(tag, Date.now() - t0);
  }
}

/**
 * Things that happened, counted rather than timed.
 *
 * Half of what went wrong this week was not slow, it was silent: a cover
 * looked for under a name nothing had saved it as, a picture fetched once per
 * song instead of once per album. None of that shows up as time; it shows up
 * as a tally that does not add up, which is what these are for. A count is two
 * numbers and a map lookup, so they can stay on with the rest.
 */
const counts = new Map<string, number>();

export function bump(tag: string, by = 1): void {
  if (!enabled) return;
  counts.set(tag, (counts.get(tag) ?? 0) + by);
}

// ── The player's own beat ───────────────────────────────────────────────────
// Everything above this line measures the app while somebody is looking at it,
// and stops measuring the moment they stop: Android takes the JS timer away in
// the background, so a heartbeat driven by one has nothing to say about the
// twenty minutes an album takes to play with the screen off. Which is exactly
// where the reports are (a notification stuck mid-song, a cover from the track
// before, ten seconds of a frozen screen on returning).
//
// The native player keeps beating out there — it is a coroutine on Android's
// main thread, not a JS timer — and every beat it sends reaches `onStatus`,
// which is what feeds the position, the notification and the queue's advance.
// So the beat itself is the instrument: if it arrives while the app is away,
// whatever went stale did so on the way to the screen; if it does not, nothing
// downstream of it could have been right either. `beat()` says nothing about
// how the app looks, and that is the point — it is the one clock that tells
// those two apart.

/** Under this a late beat is ordinary jitter around the 500 ms it asks for. */
const BEAT_GAP_MS = 2000;

/** When the last beat arrived, whatever state the app was in. */
let lastBeat = 0;
/** Beats are only judged once one has been seen; the first has no gap. */
let beatSeen = false;
/**
 * Was the player playing when it last beat?
 *
 * A player that is paused has nothing to say and stops saying it, so the
 * silence that follows a pause in the background is the player behaving. Left
 * unasked, every session where somebody paused before putting the phone away
 * came back reporting a silence the length of the walk home, and a measurement
 * that cries wolf is worse than no measurement — it is what the foreground
 * heartbeat above already had to learn.
 */
let beatPlaying = false;
/**
 * Kept apart from `ops`, which ranks by total time and answers "what is the app
 * spending its life on". A silence of twenty minutes is not time spent on
 * anything and would sit on top of that list saying nothing true.
 */
const away = new Map<string, OpStat>();

function recordAway(tag: string, ms: number): void {
  const cur = away.get(tag);
  if (cur) {
    cur.count++;
    cur.totalMs += ms;
    if (ms > cur.maxMs) cur.maxMs = ms;
    return;
  }
  away.set(tag, { tag, count: 1, totalMs: ms, maxMs: ms });
}

/**
 * A beat from the native player. Called from the status listener, which is the
 * only thing that keeps running while the app is away. `playing` is what that
 * status says, and it decides whether the next silence is worth anything.
 */
export function beat(playing: boolean): void {
  if (!enabled) return;
  const now = Date.now();
  const prev = lastBeat;
  const wasPlaying = beatPlaying;
  lastBeat = now;
  beatPlaying = playing;
  if (!beatSeen) {
    beatSeen = true;
    return;
  }
  if (awake || !wasPlaying) return;
  bump('away · beats');
  // Asked for every half second. Anything past a couple of them is the player
  // going quiet, not jitter, and the size of the silence is the whole answer.
  const gap = now - prev;
  if (gap >= BEAT_GAP_MS) recordAway('silence between beats', gap);
}

/**
 * Back to the foreground. How old the last beat is right now is the number the
 * whole section exists for: measured before anything else runs, it says how
 * stale what the screen is about to draw already was.
 */
function onReturn(): void {
  if (!enabled || !beatSeen || !beatPlaying) return;
  recordAway('on return, last beat was this old', Date.now() - lastBeat);
}

/** Worst first: one long silence is the finding, not the average. */
export function perfAway(): OpStat[] {
  return [...away.values()].sort((a, b) => b.maxMs - a.maxMs);
}

/** Biggest first, which is where the surprises are. */
export function perfCounts(): { tag: string; n: number }[] {
  return [...counts.entries()]
    .map(([tag, n]) => ({ tag, n }))
    .sort((a, b) => b.n - a.n);
}

/** Worst blocks first. */
export function perfBlocks(): Block[] {
  return [...blocks].sort((a, b) => b.ms - a.ms);
}

/** Operations by total time spent, which is what adds up to a slow app. */
export function perfOps(): OpStat[] {
  return [...ops.values()].sort((a, b) => b.totalMs - a.totalMs);
}

export function perfSince(): number {
  return startedAt;
}

export function resetPerfLog(): void {
  blocks.length = 0;
  ops.clear();
  counts.clear();
  startedAt = Date.now();
  lastTick = Date.now();
  away.clear();
  // The next beat is the first one again: the gap across a reset belongs to
  // neither session.
  beatSeen = false;
}

/** The whole thing as text, to paste into an issue. */
export function perfReport(): string {
  const mins = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
  const lines: string[] = [`Resonuls diagnostics, ${mins} min of use`, ''];
  lines.push('JS thread blocks (worst first):');
  const bs = perfBlocks();
  if (bs.length === 0) lines.push('  none over 120 ms');
  for (const b of bs) lines.push(`  ${b.ms} ms · during ${b.during}`);
  const aw = perfAway();
  if (aw.length > 0) {
    lines.push('', 'While the app was away (the player is the only clock there):');
    for (const a of aw) {
      lines.push(`  ${a.tag}: ${a.count}× · ${a.maxMs} ms worst`);
    }
  }
  const cs = perfCounts();
  if (cs.length > 0) {
    lines.push('', 'Counted:');
    for (const c of cs) lines.push(`  ${c.tag}: ${c.n}`);
  }
  lines.push('', 'Operations by total time:');
  const os = perfOps();
  if (os.length === 0) lines.push('  none measured');
  for (const o of os.slice(0, 20)) {
    lines.push(`  ${o.tag}: ${o.count}× · ${o.totalMs} ms total · ${o.maxMs} ms worst`);
  }
  return lines.join('\n');
}
