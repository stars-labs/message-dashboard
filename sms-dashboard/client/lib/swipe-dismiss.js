// Edge-swipe state machine and Svelte action for mobile detail drawers.
//
// Kept independent from pull-to-refresh: this gesture only arms in the narrow
// left-edge zone and only claims a clearly horizontal move. Vertical scrolling
// therefore remains native, including when the touch starts near the edge.

export const EDGE_WIDTH = 32;
export const DISMISS_DISTANCE = 88;

const ACTIVATION_SLOP = 8;
const HORIZONTAL_RATIO = 1.2;
const SETTLE_MS = 180;

export function createSwipeDismissState() {
  return {
    active: false,
    axis: null,
    startX: 0,
    startY: 0,
    distance: 0,
  };
}

export function onSwipeStart(state, x, y) {
  state.active = x >= 0 && x <= EDGE_WIDTH;
  state.axis = null;
  state.startX = x;
  state.startY = y;
  state.distance = 0;
}

export function onSwipeMove(state, x, y) {
  if (!state.active) return 0;

  const dx = x - state.startX;
  const dy = y - state.startY;

  if (state.axis === null) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) <= ACTIVATION_SLOP) return 0;

    if (dx > 0 && Math.abs(dx) > Math.abs(dy) * HORIZONTAL_RATIO) {
      state.axis = 'horizontal';
    } else {
      state.axis = 'vertical';
      state.active = false;
      return 0;
    }
  }

  state.distance = state.axis === 'horizontal' ? Math.max(0, dx) : 0;
  return state.distance;
}

export function onSwipeEnd(state) {
  const result = state.active
    && state.axis === 'horizontal'
    && state.distance >= DISMISS_DISTANCE
    ? 'dismiss'
    : 'cancel';

  state.active = false;
  state.axis = null;
  state.distance = 0;
  return result;
}

export function onSwipeCancel(state) {
  state.active = false;
  state.axis = null;
  state.distance = 0;
}

/**
 * Svelte action: `use:swipeDismiss={{ onDismiss }}`.
 *
 * The non-passive move listener exists only while an edge gesture is armed. This
 * avoids turning the full drawer into a permanent touch-blocking region in WebKit.
 */
export function swipeDismiss(node, options = {}) {
  const state = createSwipeDismissState();
  const passive = { passive: true };
  const nonPassive = { passive: false };
  let onDismiss = options.onDismiss;
  let moveListening = false;
  let settleTimer = null;
  let dismissed = false;

  function setPosition(distance, animated = false) {
    node.style.transition = animated
      ? `transform ${SETTLE_MS}ms cubic-bezier(.22,.8,.3,1)`
      : 'none';
    node.style.transform = `translate3d(${distance}px, 0, 0)`;
  }

  function removeMoveListener() {
    if (!moveListening) return;
    node.removeEventListener('touchmove', handleTouchMove, nonPassive);
    moveListening = false;
  }

  function finishDismiss() {
    if (dismissed) return;
    dismissed = true;
    if (settleTimer) clearTimeout(settleTimer);
    onDismiss?.();
  }

  function handleTransitionEnd(event) {
    if (event.target === node && dismissed === false) finishDismiss();
  }

  function handleTouchStart(event) {
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    onSwipeStart(state, touch.clientX, touch.clientY);
    if (!state.active || moveListening) return;
    node.addEventListener('touchmove', handleTouchMove, nonPassive);
    moveListening = true;
  }

  function handleTouchMove(event) {
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    const distance = onSwipeMove(state, touch.clientX, touch.clientY);
    if (state.axis === 'horizontal' && event.cancelable) event.preventDefault();
    setPosition(distance);
  }

  function handleTouchEnd() {
    removeMoveListener();
    if (onSwipeEnd(state) === 'dismiss') {
      node.addEventListener('transitionend', handleTransitionEnd, { once: true });
      setPosition(node.getBoundingClientRect().width || window.innerWidth, true);
      settleTimer = setTimeout(finishDismiss, SETTLE_MS + 40);
      return;
    }
    setPosition(0, true);
  }

  function handleTouchCancel() {
    removeMoveListener();
    onSwipeCancel(state);
    setPosition(0, true);
  }

  node.addEventListener('touchstart', handleTouchStart, passive);
  node.addEventListener('touchend', handleTouchEnd, passive);
  node.addEventListener('touchcancel', handleTouchCancel, passive);

  return {
    update(next = {}) {
      onDismiss = next.onDismiss;
    },
    destroy() {
      removeMoveListener();
      if (settleTimer) clearTimeout(settleTimer);
      node.removeEventListener('touchstart', handleTouchStart, passive);
      node.removeEventListener('touchend', handleTouchEnd, passive);
      node.removeEventListener('touchcancel', handleTouchCancel, passive);
      node.removeEventListener('transitionend', handleTransitionEnd);
    },
  };
}
