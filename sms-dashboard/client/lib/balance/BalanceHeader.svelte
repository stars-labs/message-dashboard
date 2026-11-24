<script lang="ts">
  interface Props {
    activeTab: 'overview' | 'bills' | 'history';
    showBatchButton: boolean;
    loadingPreview: boolean;
    onOpenBills: () => void;
    onBatch: () => void;
  }

  let {
    activeTab = $bindable(),
    showBatchButton,
    loadingPreview,
    onOpenBills,
    onBatch,
  }: Props = $props();
</script>

<header class="px-4 py-3 lg:px-6 lg:py-5 border-b border-stone-100 lg:flex-none">
  <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2.5 sm:gap-4">
    <div class="flex items-baseline justify-between gap-3 sm:block">
      <h2 class="text-lg lg:text-xl font-bold text-stone-900 shrink-0">余额管理</h2>
    </div>
    <div class="flex items-center gap-2 shrink-0">
      <div
        class="inline-flex flex-1 sm:flex-none items-center bg-stone-100 rounded-lg p-0.5 text-xs"
      >
        <button
          type="button"
          onclick={() => {
            activeTab = 'overview';
          }}
          class="flex-1 sm:flex-none px-3 py-1.5 rounded-md transition-all {activeTab === 'overview'
            ? 'bg-white shadow-sm font-semibold text-stone-800'
            : 'text-stone-500'}">余额概览</button
        >
        <button
          type="button"
          onclick={onOpenBills}
          class="flex-1 sm:flex-none px-3 py-1.5 rounded-md transition-all {activeTab === 'bills'
            ? 'bg-white shadow-sm font-semibold text-stone-800'
            : 'text-stone-500'}">后付费账单</button
        >
        <button
          type="button"
          onclick={() => {
            activeTab = 'history';
          }}
          class="flex-1 sm:flex-none px-3 py-1.5 rounded-md transition-all {activeTab === 'history'
            ? 'bg-white shadow-sm font-semibold text-stone-800'
            : 'text-stone-500'}">查询记录</button
        >
      </div>
      {#if showBatchButton}
        <button
          type="button"
          onclick={onBatch}
          disabled={loadingPreview}
          class="inline-flex items-center gap-1.5 px-3 py-1.5 bg-orange-500 hover:bg-orange-600
                disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors"
        >
          <svg
            class="w-3.5 h-3.5"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M4 12h16M4 17h10" />
          </svg>
          {loadingPreview ? '计算中…' : '批量查询'}
        </button>
      {/if}
    </div>
  </div>
</header>
