<script lang="ts">
  import { formatCardNumber } from '../card-number.js';
  import { countryCodes, messageTemplates, type ComposerState } from './composer-state.svelte.js';

  interface Props {
    composer: ComposerState;
  }

  let { composer }: Props = $props();
</script>

<section
  data-mobile-composer
  class="lg:hidden min-h-[calc(100dvh-126px)] bg-white"
  aria-labelledby="mobile-composer-title"
>
  <div class="sticky top-[52px] z-10 bg-white border-b border-stone-200 px-4 py-3">
    <h2 id="mobile-composer-title" class="text-lg font-bold data-value header-effect-target">
      发送短信
    </h2>
  </div>

  <div class="p-4">
    <div class="mb-4 relative sim-input-container">
      <label for="mobile-sim-selection" class="block text-sm font-medium text-stone-600 mb-2">
        发送卡
      </label>
      <input
        id="mobile-sim-selection"
        type="text"
        value={composer.selectedSimDisplay}
        onfocus={() => {
          composer.showSimDropdown = true;
          composer.simSearch = '';
        }}
        oninput={(e) => {
          composer.showSimDropdown = true;
          composer.simSearch = e.currentTarget.value;
          composer.selectedSimDisplay = e.currentTarget.value;
          composer.recipientSIM = '';
        }}
        placeholder="卡号 / 号码 / 运营商 / ICCID"
        class="w-full px-4 py-2 cyber-input"
      />
      {#if composer.showSimDropdown && composer.filteredSims.length > 0}
        <div
          class="absolute top-full left-0 right-0 mt-1 tech-card border border-stone-200 rounded-lg shadow-xl shadow-gray-900 max-h-60 overflow-y-auto z-50"
        >
          <div class="p-2">
            <div class="text-xs text-stone-400 px-2 py-1 border-b border-stone-200 mb-1">
              可用发送卡（{composer.filteredSims.length}）
            </div>
            {#each composer.filteredSims as phone (phone.iccid)}
              <button
                onclick={() => {
                  composer.selectSim(phone);
                }}
                class="w-full text-left px-3 py-2 hover:bg-stone-200 rounded-md transition-colors text-sm flex items-center gap-2"
              >
                <span class="w-8 shrink-0 font-mono font-semibold text-stone-600"
                  >{formatCardNumber(phone.sim_index)}</span
                >
                <span class="text-lg">{phone.flag}</span>
                <div class="flex-1">
                  <div class="font-mono">
                    {phone.number && phone.number !== 'null'
                      ? phone.number
                      : phone.iccid
                        ? `ICCID: ${phone.iccid.slice(-6)}`
                        : 'Unknown'}
                  </div>
                </div>
              </button>
            {/each}
          </div>
        </div>
      {/if}
    </div>
    <div class="mb-4 relative recipient-input-container">
      <label for="mobile-recipient-number" class="block text-sm font-medium text-stone-600 mb-2">
        接收号码
      </label>
      <div class="flex gap-2">
        <div class="relative country-code-container">
          <button
            type="button"
            onclick={() => (composer.showCountryDropdown = !composer.showCountryDropdown)}
            class="px-3 py-2 cyber-input flex items-center gap-1 min-w-[90px] justify-between"
          >
            <span class="font-mono">{composer.selectedCountryCode || '无区号'}</span>
            <svg
              class="w-4 h-4 text-stone-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>
          {#if composer.showCountryDropdown}
            <div
              class="absolute top-full left-0 mt-1 tech-card border border-stone-200 rounded-lg shadow-xl shadow-gray-900 max-h-60 overflow-y-auto z-50 min-w-[200px]"
            >
              <div class="p-2">
                {#each countryCodes as cc (cc.code)}
                  <button
                    onclick={() => {
                      composer.selectCountryCode(cc.code);
                    }}
                    class="w-full text-left px-3 py-2 hover:bg-stone-200 rounded-md transition-colors text-sm flex items-center gap-2 {composer.selectedCountryCode ===
                    cc.code
                      ? 'bg-stone-200'
                      : ''}"
                  >
                    <span class="font-mono w-12">{cc.code || '—'}</span>
                    <span class="text-stone-500">{cc.country}</span>
                  </button>
                {/each}
              </div>
            </div>
          {/if}
        </div>
        <input
          id="mobile-recipient-number"
          type="text"
          bind:value={composer.recipientNumber}
          onfocus={() => (composer.showRecipientHistory = true)}
          oninput={(e) => {
            composer.showRecipientHistory = true;
            composer.recipientSearch = e.currentTarget.value;
          }}
          placeholder="输入手机号或短号…"
          class="flex-1 px-4 py-2 cyber-input"
        />
      </div>
      {#if composer.showRecipientHistory && composer.filteredRecipients.length > 0}
        <div
          class="absolute top-full left-0 right-0 mt-1 tech-card border border-stone-200 rounded-lg shadow-xl shadow-gray-900 max-h-48 overflow-y-auto z-50"
        >
          <div class="p-2">
            <div class="text-xs text-stone-400 px-2 py-1 border-b border-stone-200 mb-1">
              历史接收号码
            </div>
            {#each composer.filteredRecipients as recipient, index (index)}
              <button
                onclick={() => {
                  composer.selectRecipient(recipient);
                }}
                class="w-full text-left px-3 py-2 hover:bg-stone-200 rounded-md transition-colors text-sm flex items-center gap-2"
              >
                <svg
                  class="w-4 h-4 text-stone-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <span class="font-mono">{recipient}</span>
              </button>
            {/each}
          </div>
        </div>
      {/if}
    </div>
    <div class="mb-4">
      <div id="mobile-template-label" class="block text-sm font-medium text-stone-600 mb-2">
        快速模板
      </div>
      <div class="flex flex-wrap gap-2" role="group" aria-labelledby="mobile-template-label">
        {#each messageTemplates as template (template.name)}
          <button
            onclick={() => {
              composer.insertTemplate(template.content);
            }}
            class="px-3 py-1 text-xs bg-stone-100 text-stone-600 border border-stone-200 rounded-full hover:bg-stone-200 transition-colors"
          >
            {template.name}
          </button>
        {/each}
      </div>
    </div>
    <div class="mb-4">
      <label for="mobile-message-content" class="block text-sm font-medium text-stone-600 mb-2">
        短信内容
      </label>
      <textarea
        id="mobile-message-content"
        bind:value={composer.messageContent}
        placeholder="输入短信内容…"
        rows="4"
        class="w-full px-4 py-2 cyber-input resize-none"></textarea>
      <div class="mt-1 text-xs text-stone-400">
        字数：{composer.messageContent.length} / 500
      </div>
    </div>
    <button
      onclick={() => composer.handleSend()}
      disabled={composer.sendingStatus === 'sending'}
      class="w-full py-3 font-medium rounded-lg transition-all duration-300 text-white
          disabled:opacity-50 disabled:cursor-not-allowed
          {composer.sendingStatus === 'success'
        ? 'bg-emerald-500 hover:bg-emerald-600'
        : composer.sendingStatus === 'validation-error' || composer.sendingStatus === 'send-error'
          ? 'bg-red-500 hover:bg-red-600'
          : 'bg-orange-500 hover:bg-orange-600'}"
    >
      {#if composer.sendingStatus === 'sending'}
        <span class="flex items-center justify-center">
          <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"
            ></circle>
            <path
              class="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            ></path>
          </svg>
          发送中…
        </span>
      {:else if composer.sendingStatus === 'success'}
        已提交，等待发送
      {:else if composer.sendingStatus === 'validation-error'}
        请填写完整信息
      {:else if composer.sendingStatus === 'send-error'}
        提交失败，请先查看发送记录
      {:else}
        发送短信
      {/if}
    </button>
  </div>
</section>
