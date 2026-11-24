<script lang="ts">
  import type { Phone } from '../../shared/api/phones.js';
  import { overlay } from '../lib/overlay.js';
  import PhoneList from '../lib/PhoneList.svelte';
  import type { ViewPhone } from './types.js';

  interface Props {
    phoneNumbers: readonly ViewPhone[];
    selectedPhoneIccid: string | null;
    selectedCountry: string;
    searchTerm: string;
    isLoading: boolean;
    onSelectPhone: (phone: Pick<Phone, 'iccid'> | null) => void;
    onSetIccidMapping: (phone: Pick<Phone, 'iccid'>) => void;
    onClose: () => void;
  }

  let {
    phoneNumbers,
    selectedPhoneIccid = $bindable(),
    selectedCountry = $bindable(),
    searchTerm = $bindable(),
    isLoading,
    onSelectPhone,
    onSetIccidMapping,
    onClose,
  }: Props = $props();
</script>

<!-- Mobile receiver picker: a bottom sheet keeps the message context visible. -->
<div class="lg:hidden fixed inset-0 z-50" role="presentation">
  <button
    class="absolute inset-0 bottom-[var(--mobile-tab-bar-height)] w-full bg-stone-900/35"
    onclick={onClose}
    aria-label="关闭接收卡选择"
  ></button>
  <div
    class="absolute left-0 right-0 bottom-[var(--mobile-tab-bar-height)] h-[min(68dvh,620px)] max-h-[calc(100dvh_-_52px_-_var(--mobile-tab-bar-height))]
                  bg-white rounded-t-2xl shadow-[0_-12px_36px_rgba(28,25,23,.2)] overflow-hidden
                  flex flex-col"
    role="dialog"
    aria-modal="true"
    aria-labelledby="receiver-picker-title"
    use:overlay={{ onClose }}
  >
    <div class="flex-shrink-0 border-b border-stone-200">
      <div class="flex justify-center pt-2 pb-1" aria-hidden="true">
        <span class="w-9 h-1 rounded-full bg-stone-300"></span>
      </div>
      <div class="h-11 px-4 flex items-center gap-2">
        <div class="min-w-0 flex-1">
          <h2 id="receiver-picker-title" class="text-sm font-semibold text-stone-900">
            选择接收卡
          </h2>
          <p class="text-[11px] text-stone-400 mt-0.5">共 {phoneNumbers.length} 张卡</p>
        </div>
        <button
          class="w-9 h-9 -mr-1 flex items-center justify-center rounded-lg text-stone-500
                        hover:bg-stone-100 active:bg-stone-200"
          onclick={onClose}
          aria-label="关闭"
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
    </div>
    <div class="flex-1 min-h-0">
      <PhoneList
        {phoneNumbers}
        bind:selectedPhoneIccid
        bind:selectedCountry
        bind:searchTerm
        {onSelectPhone}
        {onSetIccidMapping}
        mobile={true}
        {isLoading}
      />
    </div>
  </div>
</div>
