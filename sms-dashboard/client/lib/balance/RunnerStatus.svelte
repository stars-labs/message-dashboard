<script lang="ts">
  import {
    RUNNER_CAPABILITIES,
    type BalanceRunnersResponse,
  } from '../../../shared/api/balance-runners.js';
  import { textOr } from '../../../shared/text.js';
  import { capabilityLabels, capabilityPresentation } from './presentation.js';

  interface Props {
    runnerStatus: BalanceRunnersResponse | null;
    loading: boolean;
  }

  let { runnerStatus, loading }: Props = $props();
</script>

<section
  class="px-4 py-2.5 lg:px-6 border-b border-stone-100 bg-stone-50/60 flex flex-wrap items-center gap-x-4 gap-y-2 lg:flex-none"
  aria-label="余额查询助手状态"
>
  <span class="text-xs font-semibold text-stone-700">查询助手</span>
  {#each RUNNER_CAPABILITIES as name (name)}
    {@const label = capabilityLabels[name]}
    {@const capability = runnerStatus?.capabilities[name]}
    {@const presentation = capabilityPresentation(capability, loading)}
    <span
      class="inline-flex items-center gap-1.5 text-xs {presentation.text}"
      title={textOr(capability?.detail_code, '')}
    >
      <span class="w-1.5 h-1.5 rounded-full {presentation.dot}" aria-hidden="true"></span>
      <span class="text-stone-500">{label}</span>
      <strong class="font-medium">{presentation.label}</strong>
    </span>
  {/each}
  <span class="text-[11px] text-stone-400 sm:ml-auto">浏览器任务逐张处理</span>
</section>
