<script>
  export let title = '';
  export let value = 0;
  export let total = null;
  export let gradient = 'from-blue-500 to-blue-600';
  export let icon = null;
</script>

<div class="bg-white border border-stone-200 rounded-xl p-6 relative overflow-hidden shadow-sm">
  <div class="relative z-10 flex items-start justify-between">
    <div>
      <h3 class="text-xs font-semibold uppercase tracking-wider text-stone-500">{title}</h3>
      <div class="mt-2 flex items-baseline">
        <p class="text-3xl font-bold text-stone-900">{value !== undefined && value !== null ? value : 0}</p>
        {#if total !== null && total !== undefined}
          <p class="ml-2 text-lg text-stone-400 font-bold">/ {total}</p>
        {/if}
      </div>
    </div>
    {#if icon}
      <div class="text-4xl opacity-80">
        {icon}
      </div>
    {/if}
  </div>
</div>
