import { describe, expect, test } from 'bun:test';
import {
  DISMISS_DISTANCE,
  EDGE_WIDTH,
  createSwipeDismissState,
  onSwipeCancel,
  onSwipeEnd,
  onSwipeMove,
  onSwipeStart,
} from './swipe-dismiss.js';

describe('edge swipe activation', () => {
  test('arms only inside the left-edge zone', () => {
    const edge = createSwipeDismissState();
    onSwipeStart(edge, EDGE_WIDTH, 100);
    expect(edge.active).toBe(true);

    const content = createSwipeDismissState();
    onSwipeStart(content, EDGE_WIDTH + 1, 100);
    expect(content.active).toBe(false);
  });

  test('does not claim ordinary finger jitter', () => {
    const state = createSwipeDismissState();
    onSwipeStart(state, 10, 100);
    expect(onSwipeMove(state, 15, 104)).toBe(0);
    expect(state.axis).toBeNull();
  });
});

describe('edge swipe direction', () => {
  test('tracks a deliberate rightward drag', () => {
    const state = createSwipeDismissState();
    onSwipeStart(state, 10, 100);
    expect(onSwipeMove(state, 70, 105)).toBe(60);
    expect(state.axis).toBe('horizontal');
  });

  test('latches vertical scrolling out of the gesture', () => {
    const state = createSwipeDismissState();
    onSwipeStart(state, 10, 100);
    expect(onSwipeMove(state, 15, 150)).toBe(0);
    expect(state.active).toBe(false);
    expect(onSwipeMove(state, 200, 155)).toBe(0);
  });

  test('does not activate for a leftward drag', () => {
    const state = createSwipeDismissState();
    onSwipeStart(state, 20, 100);
    expect(onSwipeMove(state, 0, 102)).toBe(0);
    expect(onSwipeEnd(state)).toBe('cancel');
  });
});

describe('edge swipe completion', () => {
  test('dismisses at the distance threshold', () => {
    const state = createSwipeDismissState();
    onSwipeStart(state, 10, 100);
    onSwipeMove(state, 10 + DISMISS_DISTANCE, 104);
    expect(onSwipeEnd(state)).toBe('dismiss');
  });

  test('snaps back below the distance threshold', () => {
    const state = createSwipeDismissState();
    onSwipeStart(state, 10, 100);
    onSwipeMove(state, 10 + DISMISS_DISTANCE - 1, 104);
    expect(onSwipeEnd(state)).toBe('cancel');
  });

  test('OS cancellation resets without dismissing', () => {
    const state = createSwipeDismissState();
    onSwipeStart(state, 10, 100);
    onSwipeMove(state, 160, 104);
    onSwipeCancel(state);
    expect(state.active).toBe(false);
    expect(state.distance).toBe(0);
    expect(onSwipeEnd(state)).toBe('cancel');
  });
});
