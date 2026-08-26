<script>
  /**
   * Mobile pull-to-refresh wrapper.
   *
   * Launching from the iOS home screen enters standalone display mode, which hides
   * the browser chrome. Safari's pull-to-refresh lives in that chrome, so it
   * disappears and no API can restore it — the gesture has to be re-implemented
   * here. The W3C handing `overscroll-behavior` to authors reflects the same
   * division of responsibility.
   *
   * Regular Safari already owns pull-to-refresh. Registering a second gesture there
   * makes WebKit arbitrate touches between the page and browser chrome, so this
   * implementation is restricted to installed/standalone web apps.
   */
  import { onMount } from 'svelte';
  import {
    THRESHOLD,
    createPullState,
    onCancel,
    onEnd,
    onMove,
    onStart,
  } from './pull-to-refresh.js';

  let { onRefresh = null, disabled = false, children } = $props();

  let container = $state(null);
  let pull = $state(0);
  let refreshing = $state(false);

  const gesture = createPullState();
  const passive = { passive: true };
  const nonPassive = { passive: false };
  let moveListening = false;

  // Matches the app's `lg:` breakpoint: desktop has real browser chrome and its own
  // refresh affordances, so no listeners are attached there at all.
  const isDesktop = () =>
    typeof window !== 'undefined'
      && window.matchMedia('(min-width: 1024px)').matches;

  function isStandalone() {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;

    // On iOS this property is the source of truth. Do not OR it with the media
    // query: WebKit has reported incorrect display-mode matches in Safari tabs.
    if ('standalone' in navigator) return navigator.standalone === true;

    return window.matchMedia('(display-mode: standalone)').matches;
  }

  /**
   * Find whichever element actually scrolls under the touch.
   *
   * The layout makes this genuinely ambiguous: SimpleMessageView has an unprefixed
   * `overflow-y-auto` that applies on mobile, but its root is `h-full` inside an
   * ancestor chain with no unprefixed height constraint, so the document may be the
   * real scroller instead. Walking up from the touch target handles either without
   * guessing, and falls back to the document scroll position.
   */
  function scrollTopAt(target) {
    let node = target;
    while (node && node !== document.body && node !== document.documentElement) {
      if (node.scrollHeight > node.clientHeight) {
        const overflowY = getComputedStyle(node).overflowY;
        if (overflowY === 'auto' || overflowY === 'scroll') return node.scrollTop;
      }
      node = node.parentElement;
    }
    return window.scrollY || document.documentElement.scrollTop || 0;
  }

  function handleTouchStart(event) {
    if (disabled || refreshing || event.touches.length !== 1) return;
    const touch = event.touches[0];
    onStart(gesture, touch.clientY, scrollTopAt(event.target), touch.clientX);
    if (gesture.active) addMoveListener();
  }

  function handleTouchMove(event) {
    if (!gesture.active || event.touches.length !== 1) return;
    const touch = event.touches[0];
    const next = onMove(gesture, touch.clientY, touch.clientX);

    // Only take over the gesture once it is genuinely ours, so ordinary scrolling
    // and sideways swipes keep their native behaviour. cancelable is false once the
    // browser has already committed the touch to scrolling.
    if (next > 0 && event.cancelable) event.preventDefault();

    pull = next;
  }

  async function handleTouchEnd() {
    removeMoveListener();
    if (!gesture.active) {
      pull = gesture.pull;
      return;
    }

    const result = onEnd(gesture);
    pull = gesture.pull;

    if (result !== 'refresh') return;

    refreshing = true;
    try {
      await onRefresh?.();
    } finally {
      refreshing = false;
      gesture.refreshing = false;
      gesture.pull = 0;
      pull = 0;
    }
  }

  function handleTouchCancel() {
    removeMoveListener();
    onCancel(gesture);
    pull = gesture.pull;
  }

  function addMoveListener() {
    if (moveListening || !container) return;
    container.addEventListener('touchmove', handleTouchMove, nonPassive);
    moveListening = true;
  }

  function removeMoveListener() {
    if (!moveListening || !container) return;
    container.removeEventListener('touchmove', handleTouchMove, nonPassive);
    moveListening = false;
  }

  onMount(() => {
    if (isDesktop() || !isStandalone() || !container) return;

    // Keep the large content region out of WebKit's permanent non-passive touch
    // region. The move listener exists only for a gesture that started at the top.
    container.addEventListener('touchstart', handleTouchStart, passive);
    container.addEventListener('touchend', handleTouchEnd, passive);
    container.addEventListener('touchcancel', handleTouchCancel, passive);

    return () => {
      removeMoveListener();
      container.removeEventListener('touchstart', handleTouchStart, passive);
      container.removeEventListener('touchend', handleTouchEnd, passive);
      container.removeEventListener('touchcancel', handleTouchCancel, passive);
    };
  });

  const label = $derived(
    refreshing ? '正在刷新' : pull >= THRESHOLD ? '松手刷新' : '下拉刷新',
  );

  // Arrow rotates through 180° as the pull approaches the trigger point.
  const rotation = $derived(Math.min(pull / THRESHOLD, 1) * 180);
</script>

<!-- The mobile listener host must generate a box. iOS WebKit uses rendered hit-test
     regions to decide whether a touch sequence has a non-passive move listener; a
     boxless `display: contents` host lets WebKit commit the gesture to scrolling
     before preventDefault() can claim it. Desktop has no listeners, so `lg:contents`
     preserves the existing flex layout there. -->
<div bind:this={container} class="relative block lg:contents" data-pull-to-refresh-root>
  <div
    class="lg:hidden pointer-events-none absolute inset-x-0 top-0 h-16 z-20
      flex items-center justify-center gap-2 pb-2 text-stone-500 will-change-transform"
    style="transform: translate3d(0, {pull - THRESHOLD}px, 0);
      opacity: {Math.min(pull / THRESHOLD, 1)};"
    aria-hidden={pull === 0}
    data-pull-to-refresh-indicator
  >
    {#if refreshing}
      <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5"
          stroke-linecap="round" stroke-dasharray="42" stroke-dashoffset="14" />
      </svg>
    {:else}
      <svg class="w-4 h-4" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"
        style="transform: rotate({rotation}deg);">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 5v14M5 12l7 7 7-7" />
      </svg>
    {/if}
    <span class="text-xs font-medium">{label}</span>
  </div>

  <!-- Live region so the refresh is announced rather than being a purely visual
       change. Kept out of the transformed indicator to avoid it being read on every
       pixel of movement. -->
  <div class="sr-only" role="status" aria-live="polite">
    {refreshing ? '正在刷新' : ''}
  </div>

  {@render children?.()}
</div>
