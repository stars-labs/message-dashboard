<script lang="ts">
  // Standalone iOS apps lose Safari's pull-to-refresh. In regular Safari a second gesture
  // would make WebKit arbitrate touches with the browser chrome, so this runs only when installed.
  import { onMount, type Snippet } from 'svelte';
  import {
    THRESHOLD,
    createPullState,
    onCancel,
    onEnd,
    onMove,
    onStart,
  } from './pull-to-refresh.js';

  interface Props {
    onRefresh?: (() => Promise<void> | void) | null;
    disabled?: boolean;
    children?: Snippet;
  }

  let { onRefresh = null, disabled = false, children }: Props = $props();

  let container = $state<HTMLDivElement | null>(null);
  let pull = $state(0);
  let refreshing = $state(false);

  const gesture = createPullState();
  const passive: AddEventListenerOptions = { passive: true };
  const nonPassive: AddEventListenerOptions = { passive: false };
  let moveListening = false;

  // Matches the app's `lg:` breakpoint; no listeners are attached on desktop.
  const isDesktop = () =>
    typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches;

  function isStandalone() {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;

    // On iOS this property is authoritative; the media query can match wrongly in Safari tabs.
    if ('standalone' in navigator) return navigator.standalone === true;

    return window.matchMedia('(display-mode: standalone)').matches;
  }

  // Either an inner `overflow-y-auto` element or the document may be the real scroller on
  // mobile, so walk up from the touch target and fall back to the document.
  function scrollTopAt(target: EventTarget | null): number {
    let node = target instanceof Element ? target : null;
    while (node && node !== document.body && node !== document.documentElement) {
      if (node.scrollHeight > node.clientHeight) {
        const overflowY = getComputedStyle(node).overflowY;
        if (overflowY === 'auto' || overflowY === 'scroll') return node.scrollTop;
      }
      node = node.parentElement;
    }
    return window.scrollY > 0 ? window.scrollY : document.documentElement.scrollTop;
  }

  function handleTouchStart(event: TouchEvent) {
    if (disabled || refreshing || event.touches.length !== 1) return;
    const touch = event.touches[0];
    if (touch === undefined) return;
    onStart(gesture, touch.clientY, scrollTopAt(event.target), touch.clientX);
    if (gesture.active) addMoveListener();
  }

  function handleTouchMove(event: TouchEvent) {
    if (!gesture.active || event.touches.length !== 1) return;
    const touch = event.touches[0];
    if (touch === undefined) return;
    const next = onMove(gesture, touch.clientY, touch.clientX);

    // cancelable is false once the browser has committed the touch to scrolling.
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

  function onTouchEnd() {
    void handleTouchEnd();
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
    const host = container;
    if (isDesktop() || !isStandalone() || !host) return;

    // The non-passive move listener is added only for a gesture that started at the top,
    // keeping the content out of WebKit's permanent non-passive touch region.
    host.addEventListener('touchstart', handleTouchStart, passive);
    host.addEventListener('touchend', onTouchEnd, passive);
    host.addEventListener('touchcancel', handleTouchCancel, passive);

    return () => {
      removeMoveListener();
      host.removeEventListener('touchstart', handleTouchStart, passive);
      host.removeEventListener('touchend', onTouchEnd, passive);
      host.removeEventListener('touchcancel', handleTouchCancel, passive);
    };
  });

  const label = $derived(refreshing ? '正在刷新' : pull >= THRESHOLD ? '松手刷新' : '下拉刷新');

  const rotation = $derived(Math.min(pull / THRESHOLD, 1) * 180);
</script>

<!-- The mobile host must generate a box: iOS WebKit finds non-passive move listeners through
     rendered hit-test regions, so a `display: contents` host would let it commit the gesture
     to scrolling before preventDefault(). Desktop has no listeners, so `lg:contents` is safe. -->
<div bind:this={container} class="relative block lg:contents" data-pull-to-refresh-root>
  <div
    class="lg:hidden pointer-events-none fixed inset-x-0 top-[env(safe-area-inset-top)] h-16 z-20
      flex items-center justify-center gap-2 pb-2 text-stone-500 will-change-transform"
    style="transform: translate3d(0, {pull - THRESHOLD}px, 0);
      opacity: {Math.min(pull / THRESHOLD, 1)};"
    aria-hidden={pull === 0}
    data-pull-to-refresh-indicator
  >
    {#if refreshing}
      <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle
          cx="12"
          cy="12"
          r="9"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-dasharray="42"
          stroke-dashoffset="14"
        />
      </svg>
    {:else}
      <svg
        class="w-4 h-4"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        aria-hidden="true"
        style="transform: rotate({rotation}deg);"
      >
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 5v14M5 12l7 7 7-7" />
      </svg>
    {/if}
    <span class="text-xs font-medium">{label}</span>
  </div>

  <!-- Live region outside the transformed indicator, so it is not announced on every pixel of movement. -->
  <div class="sr-only" role="status" aria-live="polite">
    {refreshing ? '正在刷新' : ''}
  </div>

  {@render children?.()}
</div>
