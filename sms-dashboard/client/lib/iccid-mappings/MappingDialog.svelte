<script lang="ts">
  import { overlay } from '../overlay.js';
  import { COUNTRIES } from '../countries.js';
  import { getStatusMeta } from '../device-status.js';
  import { formatCardNumber } from '../../../shared/card-number.js';
  import { SIM_SERVICE_TYPES, SIM_SERVICE_TYPE_SOURCES } from '../sim-service-type.js';
  import { SIM_ROLES } from '../sim-role.js';
  import type { IccidMapping } from '../../../shared/api/iccid-mappings.js';
  import { textOr } from '../../../shared/text.js';
  import type { Panel } from './model.js';

  interface Props {
    panel: Panel;
    allMappings: readonly IccidMapping[];
    error: string | null;
    onclose: () => void;
    onsave: () => void;
    ondelete: (id: string) => void;
  }

  let { panel, allMappings, error, onclose, onsave, ondelete }: Props = $props();

  function clearUnconfirmedSource() {
    if (
      panel.formData.service_type === 'unknown' ||
      panel.formData.service_type === 'balance_managed'
    ) {
      panel.formData.service_type_source = '';
    }
  }

  let simIndexConflict = $derived.by(() => {
    const current = panel;
    return current.formData.sim_index
      ? allMappings.find(
          (m) =>
            String(m.sim_index) === String(current.formData.sim_index) &&
            m.iccid !== current.formData.iccid,
        )
      : null;
  });
</script>

<div
  class="fixed inset-0 bg-stone-900/40 flex items-center justify-center z-50 p-4"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
  role="presentation"
>
  <div
    class="bg-white rounded-2xl shadow-modal w-full max-w-lg max-h-[90vh] flex flex-col overflow-hidden"
    role="dialog"
    aria-modal="true"
    aria-label={panel.mode === 'add' ? '添加映射' : '编辑映射'}
    use:overlay={{ onClose: onclose }}
  >
    <div
      class="px-6 py-4 border-b border-stone-100 flex-shrink-0 flex items-center justify-between"
    >
      <h3 class="font-semibold text-stone-900">
        {panel.mode === 'add' ? '添加映射' : '编辑映射'}
      </h3>
      <button
        onclick={onclose}
        aria-label="关闭"
        class="text-stone-400 hover:text-stone-700 transition-colors"
      >
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
    </div>

    {#if panel.mode === 'edit'}
      <div class="px-6 py-3 bg-stone-50 border-b border-stone-100 flex-shrink-0">
        <div class="flex items-center gap-3 text-sm">
          <span class="font-mono font-bold text-lg text-stone-900 tabular-nums">
            {formatCardNumber(panel.mapping.sim_index)}
          </span>
          <span class="text-stone-300">|</span>
          <span class="font-mono text-xs text-stone-500">{panel.mapping.iccid}</span>
          <span class="ml-auto">
            <span
              class="inline-flex px-2 py-0.5 text-[11px] rounded-md font-medium border
                {getStatusMeta(panel.mapping.is_active).badgeClass}"
            >
              {getStatusMeta(panel.mapping.is_active).label}
            </span>
          </span>
        </div>
        {#if panel.mapping.equipment_id}
          <div class="mt-1 text-xs text-stone-400 font-mono">
            IMEI {panel.mapping.equipment_id}
            {#if panel.mapping.signal_quality != null}
              · 信号 {panel.mapping.signal_quality}%{/if}
          </div>
        {/if}
      </div>
    {/if}

    <div class="px-6 py-4 overflow-y-auto flex-1 min-h-0">
      {#if error}
        <div class="mb-3 px-3 py-2 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
          {error}
        </div>
      {/if}

      <div class="grid grid-cols-2 gap-3">
        {#if panel.mode === 'add'}
          <div class="col-span-2">
            <label
              for="mapping-iccid"
              class="block text-xs font-semibold text-stone-500 mb-1 tracking-wide uppercase"
              >ICCID *</label
            >
            <input
              id="mapping-iccid"
              type="text"
              bind:value={panel.formData.iccid}
              placeholder="89650…（19位）"
              class="w-full px-3 py-2 text-sm font-mono border border-stone-300 rounded-lg
                  focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
            />
          </div>
        {/if}

        <div class="col-span-2 sm:col-span-1">
          <label
            for="mapping-sim-index"
            class="block text-xs font-semibold text-stone-500 mb-1 tracking-wide uppercase"
            >卡号 (sim_index)</label
          >
          <input
            id="mapping-sim-index"
            type="number"
            bind:value={panel.formData.sim_index}
            placeholder="1–95"
            min="1"
            max="95"
            class="w-full px-3 py-2 text-sm font-mono border rounded-lg
                focus:outline-none focus:ring-2 transition-colors
                {simIndexConflict
              ? 'border-amber-400 focus:border-amber-500 focus:ring-amber-100 bg-amber-50'
              : 'border-stone-300 focus:border-orange-400 focus:ring-orange-100'}"
          />
          {#if simIndexConflict}
            <p class="mt-1 text-xs text-amber-700">
              ⚠ 卡号 {formatCardNumber(simIndexConflict.sim_index)} 已被 {textOr(
                simIndexConflict.phone_number,
                simIndexConflict.iccid,
              )} 占用
            </p>
          {/if}
        </div>

        <div class="col-span-2 sm:col-span-1">
          <label
            for="mapping-number"
            class="block text-xs font-semibold text-stone-500 mb-1 tracking-wide uppercase"
            >手机号 *</label
          >
          <input
            id="mapping-number"
            type="tel"
            bind:value={panel.formData.phone_number}
            placeholder="+65 …"
            class="w-full px-3 py-2 text-sm font-mono border border-stone-300 rounded-lg
                focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          />
        </div>

        <div>
          <label
            for="mapping-country"
            class="block text-xs font-semibold text-stone-500 mb-1 tracking-wide uppercase"
            >国家 *</label
          >
          <select
            id="mapping-country"
            bind:value={panel.formData.country}
            class="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg bg-white
                focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          >
            <option value="">选择…</option>
            {#each COUNTRIES as c (c.code)}
              <option value={c.code}>{c.flag} {c.name}</option>
            {/each}
          </select>
        </div>

        <div>
          <label
            for="mapping-carrier"
            class="block text-xs font-semibold text-stone-500 mb-1 tracking-wide uppercase"
            >运营商</label
          >
          <input
            id="mapping-carrier"
            type="text"
            bind:value={panel.formData.carrier}
            placeholder="Singtel / 中国移动…"
            class="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg
                focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          />
        </div>

        <!-- Billing type is verified manually from a reliable source, never inferred. -->
        <div>
          <label
            for="mapping-service-type"
            class="block text-xs font-semibold text-stone-500 mb-1 tracking-wide uppercase"
            >计费类型</label
          >
          <select
            id="mapping-service-type"
            bind:value={panel.formData.service_type}
            onchange={clearUnconfirmedSource}
            class="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg bg-white
                focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          >
            {#each SIM_SERVICE_TYPES as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </div>

        <div>
          <label
            for="mapping-service-type-source"
            class="block text-xs font-semibold text-stone-500 mb-1 tracking-wide uppercase"
            >确认来源</label
          >
          <select
            id="mapping-service-type-source"
            bind:value={panel.formData.service_type_source}
            disabled={panel.formData.service_type === 'unknown' ||
              panel.formData.service_type === 'balance_managed'}
            class="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg bg-white
                disabled:bg-stone-50 disabled:text-stone-300
                focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          >
            <option value="">选择…</option>
            {#each SIM_SERVICE_TYPE_SOURCES as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </div>

        <div>
          <label
            for="mapping-balance-threshold"
            class="block text-xs font-semibold text-stone-500 mb-1 tracking-wide uppercase"
            >余额阈值</label
          >
          <input
            id="mapping-balance-threshold"
            type="number"
            step="0.01"
            min="0"
            bind:value={panel.formData.balance_threshold}
            placeholder="留空用默认"
            class="w-full px-3 py-2 text-sm font-mono border border-stone-300 rounded-lg
                focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          />
          <p class="mt-1 text-[11px] text-stone-400">
            低于此值标记为需充值；留空按币种默认（CNY 100 / SGD 10 / HKD 100）。
          </p>
        </div>

        <div>
          <label
            for="mapping-sim-role"
            class="block text-xs font-semibold text-stone-500 mb-1 tracking-wide uppercase"
            >主副卡</label
          >
          <select
            id="mapping-sim-role"
            bind:value={panel.formData.sim_role}
            class="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg bg-white
                focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          >
            {#each SIM_ROLES as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </div>

        {#if panel.formData.sim_role === 'secondary'}
          <div class="col-span-2">
            <label
              for="mapping-primary-iccid"
              class="block text-xs font-semibold text-stone-500 mb-1 tracking-wide uppercase"
              >主卡 ICCID</label
            >
            <select
              id="mapping-primary-iccid"
              bind:value={panel.formData.primary_iccid}
              required
              class="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg bg-white
                  focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
            >
              <option value="">选择主卡…</option>
              {#each allMappings.filter((m) => m.sim_role === 'primary') as primary (primary.iccid)}
                <option value={primary.iccid}>
                  {formatCardNumber(primary.sim_index)} · {textOr(
                    primary.phone_number,
                    primary.iccid,
                  )}
                  {primary.carrier ? `(${primary.carrier})` : ''}
                </option>
              {/each}
            </select>
            {#if allMappings.filter((m) => m.sim_role === 'primary').length === 0}
              <p class="mt-1 text-[11px] text-amber-600">暂无主卡，请先将某张卡设置为主卡。</p>
            {/if}
          </div>
        {/if}

        <p class="col-span-2 -mt-1 text-[11px] text-stone-400">
          系统无法通过
          ICCID、网络运营商或余额短信可靠识别；请从运营商账户、客服、合同/账单或明确服务短信确认。
        </p>

        <div class="col-span-2">
          <label
            for="mapping-imei"
            class="block text-xs font-semibold text-stone-500 mb-1 tracking-wide uppercase"
          >
            IMEI
            {#if panel.mode === 'edit'}
              <span class="ml-1 text-stone-300 font-normal normal-case">(由采集服务绑定)</span>
            {/if}
          </label>
          <div class="relative">
            <input
              id="mapping-imei"
              type="text"
              bind:value={panel.formData.imei}
              readonly={panel.mode === 'edit'}
              placeholder={panel.mode === 'add' ? '可选' : ''}
              class="w-full px-3 py-2 text-sm font-mono border rounded-lg transition-colors
                  {panel.mode === 'edit'
                ? 'bg-stone-50 border-stone-200 text-stone-400 cursor-default'
                : 'border-stone-300 focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100'}"
            />
            {#if panel.mode === 'edit'}
              <svg
                class="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-stone-300"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                />
              </svg>
            {/if}
          </div>
        </div>

        <div class="col-span-2">
          <label
            for="mapping-note"
            class="block text-xs font-semibold text-stone-500 mb-1 tracking-wide uppercase"
            >备注（可选）</label
          >
          <textarea
            id="mapping-note"
            bind:value={panel.formData.description}
            rows="2"
            placeholder="用途、标注等"
            class="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg resize-none
                focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          ></textarea>
        </div>
      </div>
    </div>

    <div class="px-6 py-4 border-t border-stone-100 flex-shrink-0">
      {#if panel.mode === 'edit'}
        {@const mapping = panel.mapping}
        <div class="mb-4 pt-3 border-t border-stone-100">
          <p class="text-xs text-stone-400 mb-2">
            删除此映射后，卡还在槽里，但收到的短信将不再归属号码。已收到的历史短信保留。
          </p>
          <button
            onclick={() => {
              ondelete(mapping.id);
            }}
            class="text-sm text-red-600 font-medium border border-red-200 rounded-lg px-3 py-1.5
                hover:bg-red-50 transition-colors"
          >
            删除映射
          </button>
        </div>
      {/if}

      <div class="flex items-center justify-end gap-3">
        <button
          onclick={onclose}
          class="px-4 py-2 text-sm text-stone-600 border border-stone-200 rounded-lg
              hover:bg-stone-50 transition-colors"
        >
          取消
        </button>
        <button
          onclick={onsave}
          disabled={!panel.formData.phone_number ||
            !panel.formData.sim_index ||
            (panel.formData.service_type !== 'unknown' &&
              panel.formData.service_type !== 'balance_managed' &&
              !panel.formData.service_type_source) ||
            (panel.mode === 'add' && !panel.formData.iccid)}
          class="px-4 py-2 text-sm font-medium bg-stone-800 text-white rounded-lg
              hover:bg-stone-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {panel.mode === 'add' ? '添加映射' : '保存'}
        </button>
      </div>
    </div>
  </div>
</div>
