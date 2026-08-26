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
   * Deliberately NOT branched on standalone mode. `navigator.standalone` is a
   * private iOS API and the `display-mode` media query has been buggy on iOS, so
   * keying the feature off either would stake it on an unreliable check. Running the
   * same gesture in both modes costs nothing and removes a failure mode.
   */
  import { onMount } from 'svelte';
  import {
    MAX_PULL,
    THRESHOLD,
    createPullState,
    onEnd,
    onMove,
    onStart,
  } from './pull-to-refresh.js';

  let { onRefresh = null, disabled = false, children } = $props();

  let container = $state(null);
  let pull = $state(0);
  let refreshing = $state(false);
  let armed = $state(false);

  const gesture = createPullState();

  // Matches the app's `lg:` breakpoint: desktop has real browser chrome and its own
  // refresh affordances, so no listeners are attached there at all.
  const isDesktop = () =>
    typeof window !== 'undefined'
      && window.matchMedia('(min-width: 1024px)').matches;

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
    armed = gesture.active;
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
    armed = gesture.active;
  }

  async function handleTouchEnd() {
    if (!gesture.active) {
      pull = gesture.pull;
      return;
    }

    const result = onEnd(gesture);
    pull = gesture.pull;
    armed = false;

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

  onMount(() => {
    if (isDesktop() || !container) return;

    // touchmove must be non-passive: it conditionally calls preventDefault to claim
    // the gesture. The other two only read coordinates.
    const opts = { passive: true };
    container.addEventListener('touchstart', handleTouchStart, opts);
    container.addEventListener('touchmove', handleTouchMove, { passive: false });
    container.addEventListener('touchend', handleTouchEnd, opts);
    container.addEventListener('touchcancel', handleTouchEnd, opts);

    return () => {
      container.removeEventListener('touchstart', handleTouchStart, opts);
      container.removeEventListener('touchmove', handleTouchMove, { passive: false });
      container.removeEventListener('touchend', handleTouchEnd, opts);
      container.removeEventListener('touchcancel', handleTouchEnd, opts);
    };
  });

  const label = $derived(
    refreshing ? '正在刷新' : pull >= THRESHOLD ? '松手刷新' : '下拉刷新',
  );

  // Arrow rotates through 180° as the pull approaches the trigger point.
  const rotation = $derived(Math.min(pull / THRESHOLD, 1) * 180);
</script>

<!-- lg:hidden on the indicator only: the wrapper must not change desktop layout,
     and no listeners are bound there anyway.

     `contents` keeps this wrapper out of the layout entirely, so inserting it around
     the content area cannot disturb the existing flex chain. The consequence is that
     the indicator becomes a flex item of whatever ancestor flex container is next up
     (App.svelte's `lg:flex lg:flex-col` root), where the default flex-shrink:1 would
     collapse its height to 0 against the tall sibling — hence `shrink-0` below. -->
<div bind:this={container} class="contents">
  <div
    class="lg:hidden relative shrink-0 overflow-hidden transition-[height] duration-200 ease-out"
    style="height: {pull}px;"
    aria-hidden={pull === 0}
  >
    <div
      class="absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 pb-2
        text-stone-500"
      style="opacity: {Math.min(pull / THRESHOLD, 1)};"
    >
      {#if refreshing}
        <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5"
            stroke-linecap="round" stroke-dasharray="42" stroke-dashoffset="14" />
        </svg>
      {:else}
        <svg class="w-4 h-4 transition-transform duration-100" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"
          style="transform: rotate({rotation}deg);">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 5v14M5 12l7 7 7-7" />
        </svg>
      {/if}
      <span class="text-xs font-medium">{label}</span>
    </div>
  </div>

  <!-- Live region so the refresh is announced rather than being a purely visual
       change. Kept out of the transformed indicator to avoid it being read on every
       pixel of movement. -->
  <div class="sr-only" role="status" aria-live="polite">
    {refreshing ? '正在刷新' : ''}
  </div>

  {@render children?.()}
</div>
