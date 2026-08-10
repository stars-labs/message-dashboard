<script>
  import { onMount } from 'svelte';

  let { message = '', type = 'info', duration = 4000, onClose = () => {} } = $props();

  let visible = $state(false);

  onMount(() => {
    // Trigger enter animation
    requestAnimationFrame(() => { visible = true; });
    if (duration > 0) {
      const timer = setTimeout(() => dismiss(), duration);
      return () => clearTimeout(timer);
    }
  });

  function dismiss() {
    visible = false;
    setTimeout(onClose, 200);
  }

  const icons = {
    success: '✓',
    error: '✕',
    info: 'ℹ'
  };

  const colors = {
    success: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    error: 'bg-red-50 border-red-200 text-red-800',
    info: 'bg-blue-50 border-blue-200 text-blue-800'
  };
</script>

<div
  class="fixed top-4 right-4 z-[100] transition-all duration-200 {visible ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2'}"
>
  <div class="flex items-center gap-3 px-4 py-3 rounded-lg border shadow-lg {colors[type] || colors.info} max-w-sm">
    <span class="text-lg font-bold shrink-0">{icons[type] || icons.info}</span>
    <span class="text-sm">{message}</span>
    <button
      onclick={dismiss}
      class="ml-auto shrink-0 opacity-50 hover:opacity-100 transition-opacity text-lg leading-none"
    >
      &times;
    </button>
  </div>
</div>
