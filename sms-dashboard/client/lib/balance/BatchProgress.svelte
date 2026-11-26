<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { BalanceBatch } from '../../../shared/api/balance-batches.js';
  import { errorText } from '../../../shared/error-text.js';
  import { contractApi } from '../api.js';
  import { confirmAction } from '../confirm.svelte.js';
  import { toEpochMilliseconds } from '../time.js';
  import { formatTime } from './presentation.js';

  interface Props {
    canCancel: boolean;
    paused?: boolean;
    onCancelled: () => void;
  }

  let { canCancel, paused = false, onCancelled }: Props = $props();

  const POLL_MS = 10_000;
  const RECENT_MS = 30 * 60_000;

  let batches = $state<BalanceBatch[]>([]);
  let cancelling = $state<string | null>(null);
  let error = $state<string | null>(null);

  let shown = $derived(
    batches
      .filter((batch) => {
        const created = toEpochMilliseconds(batch.created_at);
        return batch.in_progress > 0 || (created !== null && Date.now() - created < RECENT_MS);
      })
      .slice(0, 3),
  );

  function outcomes(batch: BalanceBatch): string {
    return [
      `成功 ${String(batch.parsed)}`,
      `失败 ${String(batch.failed)}`,
      ...(batch.cancelled > 0 ? [`已取消 ${String(batch.cancelled)}`] : []),
      ...(batch.in_progress > 0 ? [`进行中 ${String(batch.in_progress)}`] : []),
    ].join(' · ');
  }

  async function load() {
    try {
      batches = (await contractApi.balanceBatches.list()).batches;
      error = null;
    } catch (caught) {
      error = `批量查询进度没能加载：${errorText(caught)}`;
    }
  }

  async function cancel(batch: BalanceBatch) {
    if (cancelling !== null) return;
    const confirmed = await confirmAction({
      title: '取消批量查询',
      message: `取消这批里还没开始的 ${String(batch.cancellable)} 张卡？已经在发短信或查询中的不受影响。`,
      confirmLabel: '取消这些查询',
      cancelLabel: '不取消',
      danger: true,
    });
    if (!confirmed) return;
    cancelling = batch.id;
    try {
      await contractApi.balanceBatches.cancel({ params: { id: batch.id } });
      await load();
      onCancelled();
    } catch (caught) {
      error = `取消失败：${errorText(caught)}`;
    } finally {
      cancelling = null;
    }
  }

  onMount(() => {
    if (!untrack(() => paused)) void load();
    const interval = setInterval(() => {
      if (!paused && batches.some((batch) => batch.in_progress > 0)) void load();
    }, POLL_MS);
    return () => {
      clearInterval(interval);
    };
  });
</script>

{#if error}
  <p class="px-4 lg:px-6 py-2 text-xs text-red-700 bg-red-50 border-b border-red-100">{error}</p>
{/if}
{#if shown.length > 0}
  <section
    class="px-4 lg:px-6 py-2 border-b border-stone-100 flex flex-col gap-2 lg:flex-none"
    aria-label="批量查询进度"
  >
    {#each shown as batch (batch.id)}
      {@const done = batch.parsed + batch.failed + batch.cancelled}
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span class="font-semibold text-stone-700">批量查询</span>
        <span class="font-mono text-stone-400">{formatTime(batch.created_at)}</span>
        <div
          class="w-24 h-1.5 rounded-full bg-stone-100 overflow-hidden"
          role="progressbar"
          aria-label="批量查询完成数"
          aria-valuemin={0}
          aria-valuemax={batch.total}
          aria-valuenow={done}
        >
          <div
            class="h-full bg-emerald-500"
            style:width="{batch.total === 0 ? 0 : (done / batch.total) * 100}%"
          ></div>
        </div>
        <span class="text-stone-700 tabular-nums">完成 {done}/{batch.total}</span>
        <span class="text-stone-500 tabular-nums">{outcomes(batch)}</span>
        {#if canCancel && batch.cancellable > 0}
          <button
            type="button"
            onclick={() => cancel(batch)}
            disabled={cancelling !== null}
            class="sm:ml-auto px-2 py-0.5 text-xs text-red-700 border border-red-200 rounded-md hover:bg-red-50 disabled:opacity-50 whitespace-nowrap"
          >
            {cancelling === batch.id ? '取消中…' : `取消未开始的 ${String(batch.cancellable)} 张`}
          </button>
        {/if}
      </div>
    {/each}
  </section>
{/if}
