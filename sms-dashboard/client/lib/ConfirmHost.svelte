<script>
  // Renders whatever confirmAction() is currently asking. Mounted once, at the
  // app root, so every destructive action shares one dialog.
  import { confirmState, registerConfirmHost } from './confirm.svelte.js';
  import { overlay } from './overlay.js';

  $effect(() => registerConfirmHost());

  let request = $derived(confirmState());
</script>

{#if request}
  <div class="fixed inset-0 z-[90] bg-stone-900/40 flex items-end sm:items-center justify-center sm:p-4">
    <div
      role="dialog"
      aria-modal="true"
      aria-label={request.title}
      use:overlay={{ onClose: () => request.resolve(false) }}
      class="w-full sm:max-w-[420px] bg-white border border-stone-200 rounded-t-xl sm:rounded-xl
        shadow-modal overflow-hidden"
    >
      <div class="px-5 py-4 border-b border-stone-100">
        <h3 class="text-sm font-semibold text-stone-900">{request.title}</h3>
      </div>
      <p class="px-5 py-4 text-sm text-stone-600 leading-relaxed whitespace-pre-line">{request.message}</p>
      <div class="px-5 py-3 border-t border-stone-100 flex gap-2 justify-end">
        <button
          type="button"
          onclick={() => request.resolve(false)}
          class="h-10 px-4 rounded-lg border border-stone-200 text-sm font-medium text-stone-700 hover:bg-stone-50"
        >{request.cancelLabel}</button>
        <button
          type="button"
          onclick={() => request.resolve(true)}
          class="h-10 px-4 rounded-lg text-sm font-medium text-white
            {request.danger ? 'bg-red-600 hover:bg-red-700' : 'bg-orange-500 hover:bg-orange-600'}"
        >{request.confirmLabel}</button>
      </div>
    </div>
  </div>
{/if}
