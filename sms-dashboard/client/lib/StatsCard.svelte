<script>
  export let title = '';
  export let value = 0;
  export let total = null;
  export let gradient = 'from-blue-500 to-blue-600';
  export let icon = null;
</script>

<div class="bg-gradient-to-br {gradient} rounded-2xl shadow-xl p-6 text-white transform hover:scale-105 transition-transform duration-300">
  <div class="flex items-start justify-between">
    <div>
      <h3 class="text-sm font-medium opacity-90">{title}</h3>
      <div class="mt-2 flex items-baseline">
        <p class="text-3xl font-bold">{value}</p>
        {#if total}
          <p class="ml-2 text-lg opacity-75">/ {total}</p>
        {/if}
      </div>
    </div>
    {#if icon}
      <div class="text-white/20 text-4xl">
        {icon}
      </div>
    {/if}
  </div>
</div>