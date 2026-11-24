<script lang="ts">
  import type { View } from '../../shared/views.js';
  import ErrorBoundary from '../lib/ErrorBoundary.svelte';
  import FilterRules from '../lib/FilterRules.svelte';
  import KeywordConfig from '../lib/KeywordConfig.svelte';
  import type { Permission } from './types.js';

  interface Props {
    currentView: View;
    can: Permission;
    onNavigate: (view: View) => void;
  }

  let { currentView, can, onNavigate }: Props = $props();
</script>

<div
  class="px-0 py-0 lg:px-8 lg:py-6 lg:flex-1 lg:min-h-0 lg:overflow-auto bg-white lg:bg-transparent"
>
  {#if can('keywords.read') && can('filters.read')}
    <div
      class="flex items-center p-1 m-3 lg:inline-flex lg:m-0 lg:mb-5 bg-stone-200/70 rounded-lg"
      aria-label="规则类型"
    >
      <button
        onclick={() => {
          onNavigate('filters');
        }}
        class="flex-1 lg:flex-none px-3 py-1.5 rounded-md text-sm transition-colors
                {currentView === 'filters'
          ? 'bg-white text-stone-900 font-semibold shadow-sm'
          : 'text-stone-500 hover:text-stone-800'}">垃圾过滤</button
      >
      <button
        onclick={() => {
          onNavigate('keywords');
        }}
        class="flex-1 lg:flex-none px-3 py-1.5 rounded-md text-sm transition-colors
                {currentView === 'keywords'
          ? 'bg-white text-stone-900 font-semibold shadow-sm'
          : 'text-stone-500 hover:text-stone-800'}">关键词高亮</button
      >
    </div>
  {/if}

  {#if currentView === 'filters'}
    <ErrorBoundary componentName="FilterRules">
      <FilterRules />
    </ErrorBoundary>
  {:else}
    <ErrorBoundary componentName="Keywords">
      <KeywordConfig />
    </ErrorBoundary>
  {/if}
</div>
