<script lang="ts">
  import {
    getMobileTabDragX,
    getMobileTabIndexAtPoint,
    getMobileTabOptics,
    getMobileTabs,
    getMobileTabState,
  } from '../lib/mobile-tab-state.js';
  import type { View } from '../../shared/views.js';

  type MobileTabId = ReturnType<typeof getMobileTabs>[number];

  type TabPointerEvent = PointerEvent & { currentTarget: HTMLElement };

  interface Props {
    currentView: View;
    showMoreMenu: boolean;
    canManagePhones: boolean;
    onNavigate: (view: View) => void;
    onToggleMore: () => void;
  }

  let { currentView, showMoreMenu, canManagePhones, onNavigate, onToggleMore }: Props = $props();

  let mobileTabs = $derived(getMobileTabs(canManagePhones));
  let mobileTabState = $derived(
    getMobileTabState({
      currentView,
      showMoreMenu,
      canManagePhones,
    }),
  );
  let mobileTabPointerId = $state<number | null>(null);
  let mobileTabDragIndex = $state<number | null>(null);
  let mobileTabDragX = $state<number | null>(null);
  let mobileTabGlowX = $state<number | null>(null);
  let mobileTabIconShiftX = $state(0);
  let suppressMobileTabClickUntil = 0;
  let mobileTabVisualIndex = $derived(mobileTabDragIndex ?? mobileTabState.index);
  let mobileTabVisualId = $derived(mobileTabs[mobileTabVisualIndex]);
  let mobileTabSelectionWidth = $derived(`${100 / mobileTabState.count}%`);
  let mobileTabSelectionX = $derived(
    mobileTabDragX !== null
      ? `${mobileTabDragX}px`
      : mobileTabState.index === 0
        ? '0%'
        : `calc(${mobileTabState.index * 100}% + ${mobileTabState.index * 8}px)`,
  );
  let mobileTabGlowPosition = $derived(mobileTabGlowX === null ? '50%' : `${mobileTabGlowX}px`);

  function activateMobileTab(target: MobileTabId) {
    if (target === 'more') {
      onToggleMore();
      return;
    }
    onNavigate(target);
  }

  function handleMobileTabClick(target: MobileTabId) {
    if (Date.now() < suppressMobileTabClickUntil) return;
    activateMobileTab(target);
  }

  function updateMobileTabDrag(event: TabPointerEvent) {
    const rect = event.currentTarget.getBoundingClientRect();
    const geometry = {
      clientX: event.clientX,
      left: rect.left,
      width: rect.width,
      count: mobileTabs.length,
    };
    const index = getMobileTabIndexAtPoint(geometry);
    mobileTabDragIndex = index;
    mobileTabDragX = getMobileTabDragX(geometry);
    const optics = getMobileTabOptics(geometry);
    mobileTabGlowX = optics.glowX;
    mobileTabIconShiftX = optics.iconShiftX;
    return index;
  }

  function handleMobileTabPointerDown(event: TabPointerEvent) {
    const root = document.documentElement;
    if (
      event.pointerType !== 'touch' ||
      event.button !== 0 ||
      !root.classList.contains('is-ios') ||
      !root.classList.contains('is-standalone')
    )
      return;

    event.preventDefault();
    mobileTabPointerId = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    updateMobileTabDrag(event);
  }

  function handleMobileTabPointerMove(event: TabPointerEvent) {
    if (event.pointerId !== mobileTabPointerId) return;
    event.preventDefault();
    updateMobileTabDrag(event);
  }

  function finishMobileTabPointer(event: TabPointerEvent, shouldActivate: boolean) {
    if (event.pointerId !== mobileTabPointerId) return;
    event.preventDefault();
    const target = mobileTabs[updateMobileTabDrag(event)];
    event.currentTarget.releasePointerCapture(event.pointerId);
    mobileTabPointerId = null;
    mobileTabDragIndex = null;
    mobileTabDragX = null;
    mobileTabGlowX = null;
    mobileTabIconShiftX = 0;

    if (shouldActivate && target) {
      suppressMobileTabClickUntil = Date.now() + 500;
      activateMobileTab(target);
    }
  }
</script>

<!-- The safe-area padding keeps controls clear of Safari chrome and the home indicator. -->
<nav
  class="mobile-tab-bar lg:hidden fixed bottom-0 left-0 right-0 z-40
      bg-white border-t border-stone-200
      flex items-stretch touch-manipulation isolate"
  style="box-shadow: 0 -1px 0 rgba(28,25,23,.06); padding-bottom: var(--mobile-tab-safe-area); --mobile-tab-selection-width: {mobileTabSelectionWidth}; --mobile-tab-selection-x: {mobileTabSelectionX}; --mobile-tab-glow-x: {mobileTabGlowPosition}; --mobile-tab-icon-shift-x: {mobileTabIconShiftX}px;"
  data-mobile-tab-dragging={mobileTabPointerId !== null}
  onpointerdown={handleMobileTabPointerDown}
  onpointermove={handleMobileTabPointerMove}
  onpointerup={(event) => {
    finishMobileTabPointer(event, true);
  }}
  onpointercancel={(event) => {
    finishMobileTabPointer(event, false);
  }}
>
  <span class="mobile-tab-selection" data-mobile-tab-selection aria-hidden="true"></span>

  <button
    onclick={() => {
      handleMobileTabClick('dashboard');
    }}
    data-mobile-tab-active={mobileTabVisualId === 'dashboard'}
    class="mobile-tab-button relative z-[1] flex-1 flex flex-col items-center justify-center gap-0.5 min-h-[var(--mobile-tab-content-height)]
          touch-manipulation active:bg-stone-100 transition-colors
          {mobileTabVisualId === 'dashboard' ? 'text-[#c2410c]' : 'text-stone-400'}"
  >
    <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M7 8h10M7 12h6m-6 4h10M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z"
      />
    </svg>
    <span class="text-[10px] font-semibold leading-none">验证码</span>
  </button>

  {#if canManagePhones}
    <button
      onclick={() => {
        handleMobileTabClick('iccid-mappings');
      }}
      data-mobile-tab-active={mobileTabVisualId === 'iccid-mappings'}
      class="mobile-tab-button relative z-[1] flex-1 flex flex-col items-center justify-center gap-0.5 min-h-[var(--mobile-tab-content-height)]
            touch-manipulation active:bg-stone-100 transition-colors
            {mobileTabVisualId === 'iccid-mappings' ? 'text-[#c2410c]' : 'text-stone-400'}"
    >
      <svg
        class="w-6 h-6"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <rect x="5" y="5" width="14" height="14" rx="2" />
        <rect x="9" y="9" width="6" height="6" rx="1" />
        <path stroke-linecap="round" d="M9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3" />
      </svg>
      <span class="text-[10px] font-semibold leading-none">设备</span>
    </button>
  {/if}

  <button
    onclick={() => {
      handleMobileTabClick('balances');
    }}
    data-mobile-tab-active={mobileTabVisualId === 'balances'}
    class="mobile-tab-button relative z-[1] flex-1 flex flex-col items-center justify-center gap-0.5 min-h-[var(--mobile-tab-content-height)]
          touch-manipulation active:bg-stone-100 transition-colors
          {mobileTabVisualId === 'balances' ? 'text-[#c2410c]' : 'text-stone-400'}"
  >
    <svg
      class="w-6 h-6"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M4 7.5A2.5 2.5 0 016.5 5H19a1 1 0 011 1v12a1 1 0 01-1 1H6.5A2.5 2.5 0 014 16.5v-9z"
      />
      <path stroke-linecap="round" stroke-linejoin="round" d="M4 8h13m0 3h4v4h-4a2 2 0 010-4z" />
    </svg>
    <span class="text-[10px] font-semibold leading-none">余额</span>
  </button>

  <button
    onclick={() => {
      handleMobileTabClick('send');
    }}
    data-mobile-tab-active={mobileTabVisualId === 'send'}
    class="mobile-tab-button relative z-[1] flex-1 flex flex-col items-center justify-center gap-0.5 min-h-[var(--mobile-tab-content-height)]
          touch-manipulation active:bg-stone-100 transition-colors
          {mobileTabVisualId === 'send' ? 'text-[#c2410c]' : 'text-stone-400 hover:text-stone-600'}"
  >
    <svg
      class="w-6 h-6"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M5 5h9a3 3 0 013 3v1M5 5a3 3 0 00-3 3v5a3 3 0 003 3h2l3.5 3v-3H13"
      />
      <path stroke-linecap="round" stroke-linejoin="round" d="M14 12h8m-3-3 3 3-3 3" />
    </svg>
    <span class="text-[10px] font-semibold leading-none">发送</span>
  </button>

  <button
    onclick={() => {
      handleMobileTabClick('more');
    }}
    data-mobile-tab-active={mobileTabVisualId === 'more'}
    class="mobile-tab-button relative z-[1] flex-1 flex flex-col items-center justify-center gap-0.5 min-h-[var(--mobile-tab-content-height)]
          touch-manipulation active:bg-stone-100 transition-colors
          {mobileTabVisualId === 'more' ? 'text-[#c2410c]' : 'text-stone-400'}"
  >
    <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16" />
    </svg>
    <span class="text-[10px] font-semibold leading-none">更多</span>
  </button>
</nav>
