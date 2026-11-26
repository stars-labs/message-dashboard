<script lang="ts">
  import { onMount } from 'svelte';
  import type { RunnerInstallation } from '../../../shared/api/balance-runners.js';
  import { errorText } from '../../../shared/error-text.js';
  import { contractApi } from '../api.js';
  import { confirmAction } from '../confirm.svelte.js';
  import { overlay } from '../overlay.js';
  import { formatTime } from './presentation.js';

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();

  let runners = $state<RunnerInstallation[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let revoking = $state<string | null>(null);

  async function load() {
    try {
      runners = (await contractApi.balanceRunners.installations()).runners;
      error = null;
    } catch (caught) {
      error = `无法读取查询助手：${errorText(caught)}`;
    } finally {
      loading = false;
    }
  }

  async function revoke(runner: RunnerInstallation) {
    if (revoking !== null) return;
    const confirmed = await confirmAction({
      title: '撤销查询助手',
      message: `撤销后「${runner.display_name}」不能再领取余额查询任务，也不能重新登记。确定撤销？`,
      confirmLabel: '撤销',
      danger: true,
    });
    if (!confirmed) return;
    revoking = runner.id;
    try {
      await contractApi.balanceRunners.revoke({ params: { id: runner.id } });
      await load();
    } catch (caught) {
      error = `撤销失败：${errorText(caught)}`;
    } finally {
      revoking = null;
    }
  }

  function stateOf(runner: RunnerInstallation): { label: string; tone: string } {
    if (runner.revoked_at !== null) return { label: '已撤销', tone: 'text-stone-400' };
    return runner.online
      ? { label: '在线', tone: 'text-emerald-700' }
      : { label: '离线', tone: 'text-stone-500' };
  }

  onMount(() => {
    void load();
  });
</script>

<div
  class="fixed inset-0 z-50 bg-stone-900/35 flex items-end sm:items-center justify-center sm:p-4"
>
  <div
    class="w-full sm:max-w-[760px] max-h-[92vh] bg-white border border-stone-200 rounded-t-xl sm:rounded-xl shadow-modal overflow-hidden flex flex-col"
    role="dialog"
    aria-modal="true"
    aria-label="管理查询助手"
    use:overlay={{ onClose }}
  >
    <header class="px-5 py-4 border-b border-stone-100 flex items-start justify-between gap-4">
      <div>
        <h3 class="font-semibold text-stone-900">查询助手</h3>
        <p class="mt-0.5 text-xs text-stone-400">
          每台登录过 Balance Agent 的电脑；撤销后它不能再领取任务
        </p>
      </div>
      <button
        type="button"
        onclick={onClose}
        aria-label="关闭查询助手管理"
        class="w-8 h-8 text-stone-400 hover:bg-stone-100 rounded-lg">&times;</button
      >
    </header>
    <div class="overflow-y-auto">
      {#if error}
        <p class="px-5 py-3 text-xs text-red-700 bg-red-50 border-b border-red-100">{error}</p>
      {/if}
      {#if loading}
        <p class="px-5 py-6 text-sm text-stone-400">正在读取…</p>
      {:else if runners.length === 0}
        <p class="px-5 py-6 text-sm text-stone-400">还没有电脑登记为查询助手</p>
      {:else}
        <table class="w-full text-sm">
          <thead class="text-[11px] text-stone-400 text-left">
            <tr class="border-b border-stone-100">
              <th class="px-4 sm:px-5 py-2 font-medium">名称</th>
              <th class="hidden sm:table-cell px-3 py-2 font-medium">版本</th>
              <th class="px-2 sm:px-3 py-2 font-medium whitespace-nowrap">最后心跳</th>
              <th class="px-2 sm:px-3 py-2 font-medium whitespace-nowrap">状态</th>
              <th class="px-5 py-2"><span class="sr-only">操作</span></th>
            </tr>
          </thead>
          <tbody>
            {#each runners as runner (runner.id)}
              {@const state = stateOf(runner)}
              <tr class="border-b border-stone-100 last:border-0">
                <td class="px-4 sm:px-5 py-2.5">
                  <span class="block text-stone-800">{runner.display_name}</span>
                  <span class="block font-mono text-[11px] text-stone-400 break-all"
                    >{runner.auth_subject ?? '共享 API key'}</span
                  >
                  <span class="sm:hidden block font-mono text-[11px] text-stone-500"
                    >{runner.version} · {runner.platform}</span
                  >
                </td>
                <td class="hidden sm:table-cell px-3 py-2.5 font-mono text-xs text-stone-600">
                  {runner.version}
                  <span class="text-stone-400">· {runner.platform}</span>
                </td>
                <td class="px-2 sm:px-3 py-2.5 font-mono text-xs text-stone-600 whitespace-nowrap">
                  {formatTime(runner.last_heartbeat)}
                </td>
                <td class="px-2 sm:px-3 py-2.5 text-xs whitespace-nowrap {state.tone}"
                  >{state.label}</td
                >
                <td class="px-4 sm:px-5 py-2.5 text-right">
                  {#if runner.revoked_at === null}
                    <button
                      type="button"
                      aria-label="撤销 {runner.display_name}"
                      disabled={revoking !== null}
                      onclick={() => revoke(runner)}
                      class="px-2.5 py-1 text-xs whitespace-nowrap text-red-700 border border-red-200 rounded-md hover:bg-red-50 disabled:opacity-50"
                    >
                      {revoking === runner.id ? '撤销中…' : '撤销'}
                    </button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>
  </div>
</div>
