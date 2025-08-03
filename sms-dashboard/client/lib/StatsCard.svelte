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

<div class="tech-card holographic scan-line relative group overflow-hidden">
  <!-- Gradient background layers using Tailwind -->
  <div class="absolute inset-0 bg-gradient-to-br {gradient} opacity-30 rounded-xl transition-opacity duration-300 group-hover:opacity-40"></div>
  <div class="absolute inset-0 bg-gradient-to-tr {gradient} opacity-0 group-hover:opacity-20 transition-opacity duration-500 rounded-xl"></div>
  
  <!-- Content -->
  <div class="relative z-10 flex items-start justify-between">
    <div>
      <h3 class="text-sm font-bold uppercase tracking-wider bg-gradient-to-r {gradient} bg-clip-text text-transparent animate-gradient-x">{title}</h3>
      <div class="mt-2 flex items-baseline">
        <p bind:this={valueElement} class="text-3xl font-bold data-value">{value !== undefined && value !== null ? value : 0}</p>
        {#if total !== null && total !== undefined}
          <p class="ml-2 text-lg text-cyan-300 font-bold">/ {total}</p>
        {/if}
      </div>
    </div>
    {#if icon}
      <div class="text-4xl opacity-30 group-hover:opacity-50 transition-all duration-300 text-glow transform group-hover:scale-110">
        {icon}
      </div>
    {/if}
  </div>
  
  <!-- Bottom gradient border -->
  <div class="absolute bottom-0 left-0 right-0 h-1 bg-gradient-to-r {gradient} opacity-70 blur-sm animate-pulse"></div>
  
  <!-- Corner accent -->
  <div class="absolute top-0 right-0 w-16 h-16 bg-gradient-to-br {gradient} opacity-10 rounded-bl-3xl"></div>
</div>

