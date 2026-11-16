import { describe, expect, test } from 'bun:test';
import {
  MAX_PULL,
  THRESHOLD,
  createPullState,
  damp,
  onCancel,
  onEnd,
  onMove,
  onStart,
} from './pull-to-refresh.js';

// A pull that starts mid-list must stay a normal scroll. This is the assertion that
// keeps the gesture from hijacking the message list, so it is tested from both
// directions rather than only the happy path.
describe('activation', () => {
  test('activates only at the top of the scroll container', () => {
    const state = createPullState();
    onStart(state, 100, 0);
    expect(state.active).toBe(true);
  });

  test('does not activate when the container is scrolled', () => {
    const state = createPullState();
    onStart(state, 100, 240);
    expect(state.active).toBe(false);
  });

  test('a move without activation produces no pull', () => {
    const state = createPullState();
    onStart(state, 100, 240);
    onMove(state, 400, 100);
    expect(state.pull).toBe(0);
  });

  test('ignores a new gesture while a refresh is in flight', () => {
    // Otherwise a second pull fires loadData() concurrently with the first.
    const state = createPullState();
    state.refreshing = true;
    onStart(state, 100, 0);
    expect(state.active).toBe(false);
  });

  test('ignores small vertical movement so finger jitter remains a tap', () => {
    const state = createPullState();
    onStart(state, 100, 0);

    expect(onMove(state, 104, 0)).toBe(0);
    expect(state.active).toBe(true);
    expect(onMove(state, 120, 0)).toBeGreaterThan(0);
  });
});

describe('damping', () => {
  test('is monotonic in the pull distance', () => {
    expect(damp(0)).toBe(0);
    expect(damp(40)).toBeGreaterThan(damp(20));
    expect(damp(200)).toBeGreaterThan(damp(100));
  });

  test('never exceeds MAX_PULL, however far the finger travels', () => {
    for (const distance of [100, 500, 5000, 100000]) {
      expect(damp(distance)).toBeLessThanOrEqual(MAX_PULL);
    }
  });

  test('resists progressively — output falls behind input', () => {
    // The rubber-band feel: past the threshold the indicator must lag the finger.
    expect(damp(400)).toBeLessThan(400);
    expect(damp(THRESHOLD * 4)).toBeLessThan(THRESHOLD * 4);
  });

  test('tracks the finger closely at the start', () => {
    // Without this the gesture feels dead for the first few pixels.
    expect(damp(10)).toBeGreaterThan(5);
  });
});

describe('threshold', () => {
  test('releasing short of the threshold cancels', () => {
    const state = createPullState();
    onStart(state, 100, 0);
    onMove(state, 110, 100);
    expect(state.pull).toBeLessThan(THRESHOLD);
    expect(onEnd(state)).toBe('cancel');
  });

  test('releasing past the threshold refreshes', () => {
    const state = createPullState();
    onStart(state, 100, 0);
    onMove(state, 400, 100);
    expect(state.pull).toBeGreaterThanOrEqual(THRESHOLD);
    expect(onEnd(state)).toBe('refresh');
  });

  test('refresh marks the state as refreshing', () => {
    const state = createPullState();
    onStart(state, 100, 0);
    onMove(state, 400, 100);
    onEnd(state);
    expect(state.refreshing).toBe(true);
  });

  test('cancel leaves refreshing false and resets the pull', () => {
    const state = createPullState();
    onStart(state, 100, 0);
    onMove(state, 110, 100);
    onEnd(state);
    expect(state.refreshing).toBe(false);
    expect(state.pull).toBe(0);
  });

  test('releasing without any gesture cancels', () => {
    expect(onEnd(createPullState())).toBe('cancel');
  });
});

describe('direction', () => {
  test('a horizontal swipe cancels the gesture', () => {
    // The list has horizontally scrollable regions; the gesture must not eat them.
    const state = createPullState();
    onStart(state, 100, 0);
    onMove(state, 120, 300); // dy 20, dx 200
    expect(state.active).toBe(false);
    expect(state.pull).toBe(0);
  });

  test('a mostly-vertical swipe survives some horizontal drift', () => {
    const state = createPullState();
    onStart(state, 100, 0);
    onMove(state, 300, 120); // dy 200, dx 20
    expect(state.active).toBe(true);
    expect(state.pull).toBeGreaterThan(0);
  });

  test('an upward move produces no pull', () => {
    const state = createPullState();
    onStart(state, 100, 0);
    onMove(state, 40, 100);
    expect(state.pull).toBe(0);
  });

  test('once cancelled by direction it stays cancelled', () => {
    // A finger that starts sideways then straightens must not snap into a pull.
    const state = createPullState();
    onStart(state, 100, 0);
    onMove(state, 120, 300);
    onMove(state, 400, 100);
    expect(state.pull).toBe(0);
    expect(onEnd(state)).toBe('cancel');
  });
});

describe('reset', () => {
  test('an OS-cancelled gesture resets without entering refresh state', () => {
    const state = createPullState();
    onStart(state, 100, 0);
    onMove(state, 400, 100);

    onCancel(state);

    expect(state.active).toBe(false);
    expect(state.cancelled).toBe(false);
    expect(state.refreshing).toBe(false);
    expect(state.pull).toBe(0);
  });

  test('a completed refresh can be followed by another gesture', () => {
    const state = createPullState();
    onStart(state, 100, 0);
    onMove(state, 400, 100);
    expect(onEnd(state)).toBe('refresh');

    state.refreshing = false; // what the component does when loadData() settles
    onStart(state, 100, 0);
    onMove(state, 400, 100);
    expect(onEnd(state)).toBe('refresh');
  });
});
