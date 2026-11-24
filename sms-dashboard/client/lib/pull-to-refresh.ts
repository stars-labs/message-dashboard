// iOS standalone mode hides the browser chrome that hosts Safari's pull-to-refresh,
// so the gesture is implemented in the app.

export const THRESHOLD = 64;

export const MAX_PULL = 96;

const HORIZONTAL_RATIO = 1;

// Claiming the touch sequence before movement exceeds tap jitter makes iOS suppress the click.
const ACTIVATION_SLOP = 8;

interface PullState {
  startY: number;
  startX: number;
  pull: number;
  active: boolean;
  refreshing: boolean;
  cancelled: boolean;
}

export function createPullState(): PullState {
  return {
    startY: 0,
    startX: 0,
    pull: 0,
    active: false,
    refreshing: false,
    cancelled: false,
  };
}

export function damp(distance: number): number {
  if (distance <= 0) return 0;
  return MAX_PULL * (1 - Math.exp(-distance / MAX_PULL));
}

export function onStart(state: PullState, y: number, scrollTop: number, x = 0): void {
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

export function onMove(state: PullState, y: number, x = 0): number {
  if (!state.active || state.cancelled) return state.pull;

  const dy = y - state.startY;
  const dx = Math.abs(x - state.startX);

  // Latched: a swipe that starts horizontally must not turn into a pull mid-gesture.
  if (dx > Math.abs(dy) * HORIZONTAL_RATIO && dx > 0) {
    state.cancelled = true;
    state.active = false;
    state.pull = 0;
    return 0;
  }

  state.pull = dy > ACTIVATION_SLOP ? damp(dy - ACTIVATION_SLOP) : 0;
  return state.pull;
}

// `touchcancel` is not a release: iOS sends it when the system takes the sequence,
// so it must never trigger a refresh.
export function onCancel(state: PullState): void {
  state.active = false;
  state.cancelled = false;
  state.pull = 0;
}

// On 'refresh' the state stays refreshing so a second pull cannot overlap;
// the caller clears the flag once its refresh settles.
export function onEnd(state: PullState): 'refresh' | 'cancel' {
  const shouldRefresh = state.active && !state.cancelled && state.pull >= THRESHOLD;
  state.active = false;
  state.cancelled = false;

  if (shouldRefresh) {
    state.refreshing = true;
    state.pull = THRESHOLD;
    return 'refresh';
  }

  state.pull = 0;
  return 'cancel';
}
