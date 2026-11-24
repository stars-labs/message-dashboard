<script lang="ts">
  import { onMount } from 'svelte';
  import {
    applyUpdate,
    createUpdateChecker,
    createUpdateState,
    dismiss,
    needRefresh,
    registerError,
    type RegistrationLike,
  } from './sw-update.js';

  type Updater = (reloadPage?: boolean) => Promise<void>;

  type RegisterServiceWorker = (options: {
    immediate: boolean;
    onNeedRefresh(): void;
    onRegisteredSW(swUrl: string, registration: RegistrationLike | undefined): void;
    onRegisterError(): void;
  }) => Updater;

  interface Props {
    registerServiceWorker?: RegisterServiceWorker | null;
  }

  let { registerServiceWorker = null }: Props = $props();

  const update = $state(createUpdateState());
  const checker = createUpdateChecker(update);
  let updateSW: Updater | null = null;

  export async function checkForUpdate() {
    return checker.check();
  }

  onMount(() => {
    let disposed = false;

    async function register() {
      // Dynamic import: the virtual module exists only when the PWA plugin is active.
      try {
        const registerSW: RegisterServiceWorker =
          registerServiceWorker ?? (await import('virtual:pwa-register')).registerSW;
        if (disposed) return;
        updateSW = registerSW({
          immediate: true,
          onNeedRefresh: () => {
            needRefresh(update);
          },
          onRegisteredSW: (_swUrl, registration) => {
            checker.setRegistration(registration);
          },
          onRegisterError: () => {
            registerError(update);
          },
        });
      } catch {
        // The app works without a service worker; nothing to surface.
        registerError(update);
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') void checkForUpdate();
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    void register();

    return () => {
      disposed = true;
      checker.setRegistration(null);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  });
</script>

{#if update.available}
  <!-- z-[45] sits between the tab bar (z-40) and modals/detail panels (z-50); at z-50 it
       would cover an open message detail sheet. -->
  <div
    class="fixed inset-x-3 bottom-[var(--mobile-tab-bar-height)] lg:inset-x-auto lg:right-4 lg:bottom-4 lg:max-w-sm z-[45]"
    role="status"
    aria-live="polite"
  >
    <div
      class="flex items-center gap-3 px-4 py-3 rounded-lg border shadow-lg
        bg-blue-50 border-blue-200 text-blue-800"
    >
      <span class="text-sm flex-1">新版本已准备好</span>
      <button
        onclick={() => {
          applyUpdate(update, updateSW);
        }}
        class="shrink-0 px-3 py-1.5 rounded-md bg-blue-600 text-white text-xs font-semibold
          hover:bg-blue-700 transition-colors"
      >
        重新载入
      </button>
      <button
        onclick={() => {
          dismiss(update);
        }}
        aria-label="稍后再说"
        class="shrink-0 opacity-50 hover:opacity-100 transition-opacity text-lg leading-none"
      >
        &times;
      </button>
    </div>
  </div>
{/if}
