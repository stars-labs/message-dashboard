<script lang="ts">
  import { formatClock } from './time.js';
  import { formatCardNumber } from './card-number.js';
  import { getCountryFlag } from './countries.js';
  import {
    getBalanceStatusMeta,
    getBalanceTimestamp,
    getLatestBalanceReply,
  } from './balance-query.js';
  import type { BalanceCheck } from '../../shared/api/balance-checks.js';
  import type { Phone } from '../../shared/api/phones.js';
  import { textOr } from '../../shared/text.js';

  interface SelectedPhone extends Pick<Phone, 'sim_index' | 'number'> {
    flag: string;
  }

  interface Props {
    check: BalanceCheck;
    selectedPhone?: SelectedPhone | null;
    striped?: boolean;
    onOpen?: ((check: BalanceCheck) => void) | null;
  }

  let { check, selectedPhone = null, striped = false, onOpen = null }: Props = $props();

  let statusMeta = $derived(getBalanceStatusMeta(check.display_status));
  let receiverIndex = $derived(check.sim_index ?? selectedPhone?.sim_index);
  let receiverNumber = $derived(
    textOr(check.sim_number, textOr(selectedPhone?.number, textOr(check.sim_iccid, '—'))),
  );
  let simCountry = $derived(textOr(check.sim_country, null));
  let receiverFlag = $derived(
    simCountry === null ? textOr(selectedPhone?.flag, '') : getCountryFlag(simCountry),
  );
  let summary = $derived(
    textOr(
      getLatestBalanceReply(check)?.content,
      textOr(
        check.error,
        `发送 ${textOr(check.outbound_content, textOr(check.command, '—'))} 至 ${textOr(check.outbound_recipient, textOr(check.destination, '—'))}`,
      ),
    ),
  );
</script>

<button
  type="button"
  onclick={() => onOpen?.(check)}
  class="hidden lg:grid w-full items-center px-3 py-2.5 border-b border-stone-50 text-left
    transition-colors hover:bg-orange-50/50 focus-visible:outline-none focus-visible:ring-2
    focus-visible:ring-inset focus-visible:ring-orange-400 {striped ? 'bg-[#fafaf9]' : 'bg-white'}"
  style="grid-template-columns: 3px 250px 118px minmax(0, 1fr) 92px; gap: 0 16px;"
  aria-label={`查看${formatCardNumber(receiverIndex)}余额查询详情`}
>
  <span class="self-stretch rounded-sm bg-orange-400" aria-hidden="true"></span>

  <span class="min-w-0 font-mono">
    <span class="block text-sm font-semibold text-stone-800 truncate">余额查询</span>
    <span class="mt-0.5 flex items-center gap-1.5 text-[11px] text-stone-400 min-w-0">
      <span class="shrink-0 text-stone-300">卡片</span>
      {#if receiverIndex != null}
        <span class="font-semibold text-stone-500 tabular-nums shrink-0"
          >{formatCardNumber(receiverIndex)}</span
        >
        <span class="text-stone-300 shrink-0">·</span>
      {/if}
      <span class="truncate">{receiverFlag} {receiverNumber}</span>
    </span>
  </span>

  <span
    class="inline-flex w-fit items-center px-2 py-1 rounded-md border text-xs font-medium {statusMeta.className}"
  >
    {statusMeta.label}
  </span>

  <span class="min-w-0">
    <span
      class="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-orange-50 text-orange-700 mr-1.5 font-medium"
    >
      运营商服务
    </span>
    <span class="text-sm text-stone-600 leading-snug line-clamp-2">{summary}</span>
  </span>

  <span class="font-mono text-xs text-stone-400 text-right tabular-nums">
    {formatClock(getBalanceTimestamp(check))}
  </span>
</button>

<button
  type="button"
  onclick={() => onOpen?.(check)}
  class="lg:hidden block w-full p-3 border-b border-stone-100 bg-white text-left
    active:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange-400"
  aria-label={`查看${formatCardNumber(receiverIndex)}余额查询详情`}
>
  <span class="flex items-center gap-2">
    <span
      class="inline-flex items-center px-2 py-0.5 rounded-md border text-xs font-medium {statusMeta.className}"
    >
      {statusMeta.label}
    </span>
    <span class="text-sm font-semibold text-stone-700">余额查询</span>
    <span class="ml-auto font-mono text-xs text-stone-400 shrink-0">
      {formatClock(getBalanceTimestamp(check))}
    </span>
  </span>
  <span class="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-stone-400 min-w-0">
    <span class="text-stone-300 shrink-0">卡片</span>
    {#if receiverIndex != null}
      <span class="font-semibold text-stone-500 tabular-nums shrink-0"
        >{formatCardNumber(receiverIndex)}</span
      >
      <span class="text-stone-300 shrink-0">·</span>
    {/if}
    <span class="truncate">{receiverFlag} {receiverNumber}</span>
  </span>
  <span class="block text-sm text-stone-600 leading-snug line-clamp-2 mt-1.5">{summary}</span>
</button>
