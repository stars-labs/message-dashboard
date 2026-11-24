<script lang="ts">
  import Toast from '../lib/Toast.svelte';
  import type { ToastQueue } from './toasts.svelte.js';

  interface Props {
    queue: ToastQueue;
  }

  let { queue }: Props = $props();
</script>

{#if queue.items.length}
  <div class="fixed top-4 right-4 z-[100] flex flex-col gap-2 items-end">
    {#each queue.items as toast (toast.id)}
      <Toast
        message={toast.message}
        type={toast.type}
        duration={toast.duration}
        onClose={() => {
          queue.remove(toast.id);
        }}
      />
    {/each}
  </div>
{/if}
