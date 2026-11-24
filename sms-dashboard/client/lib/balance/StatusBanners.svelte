<script lang="ts">
  import type { Notice } from './types.js';

  interface Props {
    billAccountsError: string | null;
    notice: Notice | null;
    onRetryAccounts: () => void;
  }

  let { billAccountsError, notice = $bindable(), onRetryAccounts }: Props = $props();
</script>

{#if billAccountsError}
  <!-- Without the accounts, a postpaid card with unpaid bills looks settled. -->
  <div
    class="px-4 lg:px-5 py-2.5 border-b border-amber-100 bg-amber-50 text-amber-800 text-sm
        flex items-center justify-between gap-3 lg:flex-none"
  >
    <span>账单账户没能加载，欠款信息可能不完整。</span>
    <button
      type="button"
      onclick={onRetryAccounts}
      class="text-xs font-medium px-2 py-1 rounded border border-amber-300 hover:bg-amber-100"
      >重试</button
    >
  </div>
{/if}

{#if notice}
  <div
    class="px-4 lg:px-5 py-2.5 border-b text-sm flex items-center justify-between gap-3 lg:flex-none
        {notice.type === 'success'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-100'
      : 'bg-red-50 text-red-700 border-red-100'}"
  >
    <span>{notice.message}</span>
    <button
      type="button"
      onclick={() => {
        notice = null;
      }}
      aria-label="关闭提示"
      class="text-current opacity-60 hover:opacity-100">&times;</button
    >
  </div>
{/if}
