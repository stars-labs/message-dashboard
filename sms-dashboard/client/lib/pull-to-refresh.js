// Pull-to-refresh gesture state machine.
//
// Launching from the iOS home screen enters standalone display mode, which hides
// the browser chrome — and Safari's pull-to-refresh lives in that chrome, not in the
// page. No API can bring it back, so the gesture has to be implemented in the app.
//
// Kept free of DOM access so it can be unit tested directly: the component passes in
// touch coordinates and the container's scrollTop, and gets back how far to offset
// the indicator and whether the release should refresh.

/** Pull distance (px, after damping) required to trigger a refresh. */
export const THRESHOLD = 64;

/** Ceiling on the indicator offset, however far the finger travels. */
export const MAX_PULL = 96;

// Above this ratio of horizontal to vertical travel the gesture is a sideways swipe.
const HORIZONTAL_RATIO = 1;

export function createPullState() {
  return {
    startY: 0,
    startX: 0,
    pull: 0,
    active: false,
    refreshing: false,
    cancelled: false,
  };
}

/**
 * Rubber-band damping: tracks the finger closely at first, then resists, approaching
 * MAX_PULL asymptotically so the indicator never runs away with a long drag.
 */
export function damp(distance) {
  if (distance <= 0) return 0;
  return MAX_PULL * (1 - Math.exp(-distance / MAX_PULL));
}

/**
 * Begin a gesture. Only arms when the container is already at the top — a pull that
 * starts mid-list has to remain an ordinary scroll.
 */
export function onStart(state, y, scrollTop, x = 0) {
  if (state.refreshing || scrollTop > 0) {
    state.active = false;
    return;
  }
  state.startY = y;
  state.startX = x;
  state.pull = 0;
  state.active = true;
  state.cancelled = false;
}

/** Update the pull distance. Returns the damped offset the indicator should use. */
export function onMove(state, y, x = 0) {
  if (!state.active || state.cancelled) return state.pull;

  const dy = y - state.startY;
  const dx = Math.abs(x - state.startX);

  // A sideways swipe is not ours. Latch the decision: a finger that starts
  // horizontally and then straightens must not snap into a pull mid-gesture.
  if (dx > Math.abs(dy) * HORIZONTAL_RATIO && dx > 0) {
    state.cancelled = true;
    state.active = false;
    state.pull = 0;
    return 0;
  }

  state.pull = dy > 0 ? damp(dy) : 0;
  return state.pull;
}

/**
 * End a gesture. Returns 'refresh' when the pull passed THRESHOLD, else 'cancel'.
 * On 'refresh' the state is left refreshing so a second pull cannot run loadData()
 * concurrently; the caller clears that flag once its refresh settles.
 */
export function onEnd(state) {
  const shouldRefresh = state.active && !state.cancelled && state.pull >= THRESHOLD;
  state.active = false;
  state.cancelled = false;

  if (shouldRefresh) {
    state.refreshing = true;
    state.pull = THRESHOLD; // hold the indicator at rest height while refreshing
    return 'refresh';
  }

  state.pull = 0;
  return 'cancel';
}
