<script>
  import { onMount } from 'svelte';
  import { applyDataStreamEffect } from './webgpu-effects.js';
  
  export let title = '';
  export let value = 0;
  export let total = null;
  export let gradient = 'from-blue-500 to-blue-600';
  export let icon = null;
  
  let valueElement;
  let hasAppliedEffect = false;
  let lastValue = null;
  
  // Watch for value changes and apply effect only when we have real data
  $: if (valueElement && value !== undefined && value !== null) {
    const valueStr = value.toString();
    
    // Reset effect if value changed
    if (lastValue !== valueStr) {
      hasAppliedEffect = false;
      lastValue = valueStr;
    }
    
    // Only apply effect if we have a meaningful value (not just "0") and haven't applied it yet
    if (!hasAppliedEffect && valueStr !== '0' && valueStr !== '0%') {
      // Update the element with the new value first
      valueElement.textContent = valueStr;
      // Then apply the effect
      applyDataStreamEffect(valueElement);
      hasAppliedEffect = true;
    }
  }
</script>

<div class="tech-card holo-card scan-line relative group">
  <div class="absolute inset-0 bg-gradient-to-br {gradient} opacity-20 rounded-xl"></div>
  <div class="relative z-10 flex items-start justify-between">
    <div>
      <h3 class="text-sm font-bold text-cyan-300 uppercase tracking-wider tech-text">{title}</h3>
      <div class="mt-2 flex items-baseline">
        <p bind:this={valueElement} class="text-3xl font-bold data-value high-contrast">{value !== undefined && value !== null ? value : 0}</p>
        {#if total !== null && total !== undefined}
          <p class="ml-2 text-lg text-cyan-300 font-bold">/ {total}</p>
        {/if}
      </div>
    </div>
    {#if icon}
      <div class="text-4xl opacity-30 group-hover:opacity-50 transition-opacity neon-glow">
        {icon}
      </div>
    {/if}
  </div>
  <div class="absolute bottom-0 left-0 right-0 h-1 bg-gradient-to-r {gradient} opacity-50 blur-sm"></div>
</div>

<style>
  .neon-glow {
    filter: drop-shadow(0 0 10px currentColor);
  }
</style>