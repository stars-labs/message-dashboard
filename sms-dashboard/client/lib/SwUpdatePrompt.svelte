<script>
  /**
   * "New version available" bar.
   *
   * Registration lives here rather than in main.js so the prompt state and the
   * registration callbacks cannot drift apart. All the decision logic is in
   * sw-update.js; this file is the rendering and the wiring to the browser.
   */
  import { onMount } from 'svelte';
  import { applyUpdate, createUpdateState, dismiss, needRefresh, registerError } from './sw-update.js';

  const update = $state(createUpdateState());
  let updateSW = null;

  onMount(async () => {
    // Dynamic import: the virtual module only exists when the PWA plugin is active,
    // so a static import would break `vite dev` runs without it.
    try {
      const { registerSW } = await import('virtual:pwa-register');
      updateSW = registerSW({
        immediate: true,
        onNeedRefresh: () => needRefresh(update),
        onRegisterError: () => registerError(update),
      });
    } catch {
      // No service worker support, or the virtual module is unavailable. The app is
      // fully functional without it, so this is not worth surfacing.
      registerError(update);
    }
  });
</script>

{#if update.available}
  <!-- The shared variable keeps this above the safe-area-aware mobile tab bar;
       desktop has no tab bar so it anchors to the bottom edge.
       z-[45] is deliberately between the tab bar (z-40) and modals/detail panels
       (z-50) — at z-50 this bar would cover an open message detail sheet. -->
  <div
    class="fixed inset-x-3 bottom-[var(--mobile-tab-bar-height)] lg:inset-x-auto lg:right-4 lg:bottom-4 lg:max-w-sm z-[45]"
    role="status"
    aria-live="polite"
  >
    <div
      class="flex items-center gap-3 px-4 py-3 rounded-lg border shadow-lg
        bg-blue-50 border-blue-200 text-blue-800"
    >
      <span class="text-sm flex-1">有新版本可用</span>
      <button
        onclick={() => applyUpdate(update, updateSW)}
        class="shrink-0 px-3 py-1.5 rounded-md bg-blue-600 text-white text-xs font-semibold
          hover:bg-blue-700 transition-colors"
      >
        立即刷新
      </button>
      <button
        onclick={() => dismiss(update)}
        aria-label="稍后再说"
        class="shrink-0 opacity-50 hover:opacity-100 transition-opacity text-lg leading-none"
      >
        &times;
      </button>
    </div>
  </div>
{/if}
