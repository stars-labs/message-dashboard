<script lang="ts">
  import MessageHighlight from '../MessageHighlight.svelte';
  import type { KeywordForm } from './form.js';

  // Complete literal strings, so Tailwind includes them in the bundle.
  const PRESET_COLORS = [
    { hex: '#3B82F6', bg: 'bg-blue-500', label: '蓝' },
    { hex: '#10B981', bg: 'bg-emerald-500', label: '绿' },
    { hex: '#F59E0B', bg: 'bg-amber-500', label: '橙' },
    { hex: '#EF4444', bg: 'bg-red-500', label: '红' },
    { hex: '#8B5CF6', bg: 'bg-violet-500', label: '紫' },
  ];

  interface Props {
    formData: KeywordForm;
    editing: boolean;
    saving: boolean;
    error: string | null;
    onclose: () => void;
    onsave: () => void;
  }

  let { formData = $bindable(), editing, saving, error, onclose, onsave }: Props = $props();

  let previewText = $derived(
    formData.keyword ? `您的验证码是 ${formData.keyword}839204` : '验证码：123456',
  );
</script>

<dialog
  open
  aria-modal="true"
  aria-labelledby="keyword-dialog-title"
  class="fixed inset-0 m-0 w-full h-full max-w-none max-h-none border-0 bg-stone-900/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <div
    class="bg-white rounded-t-2xl sm:rounded-2xl shadow-modal w-full max-w-md flex flex-col max-h-[calc(100dvh-74px)] sm:max-h-[90vh] overflow-hidden"
  >
    <div
      class="px-6 py-4 border-b border-stone-100 flex-shrink-0 flex items-center justify-between"
    >
      <h3 id="keyword-dialog-title" class="font-semibold text-stone-900">
        {editing ? '编辑关键词' : '添加关键词'}
      </h3>
      <button onclick={onclose} aria-label="关闭" class="text-stone-400 hover:text-stone-700">
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

    <div class="px-6 py-3 bg-stone-50 border-b border-stone-100 flex-shrink-0">
      <p class="text-[11px] font-semibold text-stone-400 uppercase tracking-widest mb-1">
        效果预览
      </p>
      <p class="text-sm font-mono text-stone-700 leading-relaxed">
        <MessageHighlight content={previewText} keywords={[formData]} />
      </p>
    </div>

    <div class="px-6 py-4 space-y-4 overflow-y-auto flex-1 min-h-0">
      {#if error}
        <div class="px-3 py-2 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
          {error}
        </div>
      {/if}

      <div>
        <label
          for="keyword-value"
          class="block text-xs font-semibold text-stone-500 mb-1 tracking-wide uppercase"
          >关键词</label
        >
        <input
          id="keyword-value"
          type="text"
          bind:value={formData.keyword}
          disabled={editing}
          placeholder="例：验证码"
          class="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg
              focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 disabled:bg-stone-100 disabled:text-stone-500"
        />
      </div>

      <div>
        <label
          for="keyword-tag"
          class="block text-xs font-semibold text-stone-500 mb-1 tracking-wide uppercase"
          >标签</label
        >
        <input
          id="keyword-tag"
          type="text"
          bind:value={formData.tag}
          placeholder="例：OTP"
          class="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg
              focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
        />
      </div>

      <!-- Preset swatches only: a colour picker is hard to use precisely on mobile. -->
      <div>
        <p class="block text-xs font-semibold text-stone-500 mb-2 tracking-wide uppercase">颜色</p>
        <div class="flex items-center gap-2">
          {#each PRESET_COLORS as p (p.hex)}
            <button
              onclick={() => {
                formData.color = p.hex;
              }}
              title={p.label}
              aria-label={`选择${p.label}色`}
              class="w-7 h-7 rounded-full {p.bg} transition-transform hover:scale-110
                  {formData.color === p.hex ? 'ring-2 ring-offset-2 ring-stone-700 scale-110' : ''}"
            ></button>
          {/each}
        </div>
      </div>

      <div>
        <label
          for="keyword-priority"
          class="block text-xs font-semibold text-stone-500 mb-1 tracking-wide uppercase"
          >优先级</label
        >
        <input
          id="keyword-priority"
          type="number"
          bind:value={formData.priority}
          min="0"
          max="100"
          class="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg
              focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
        />
      </div>

      <div class="space-y-1">
        <label class="flex items-center justify-between py-2.5 cursor-pointer">
          <span class="text-sm text-stone-700">整词匹配</span>
          <button
            onclick={() => {
              formData.whole_word = !formData.whole_word;
            }}
            aria-label="整词匹配"
            disabled={editing}
            class="relative inline-flex h-5 w-9 items-center rounded-full transition-colors
                {formData.whole_word ? 'bg-stone-800' : 'bg-stone-200'} disabled:opacity-40"
          >
            <span
              class="inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform
                {formData.whole_word ? 'translate-x-4' : 'translate-x-1'}"
            ></span>
          </button>
        </label>
        <label
          class="flex items-center justify-between py-2.5 cursor-pointer border-t border-stone-100"
        >
          <span class="text-sm text-stone-700">区分大小写</span>
          <button
            onclick={() => {
              formData.case_sensitive = !formData.case_sensitive;
            }}
            aria-label="区分大小写"
            disabled={editing}
            class="relative inline-flex h-5 w-9 items-center rounded-full transition-colors
                {formData.case_sensitive ? 'bg-stone-800' : 'bg-stone-200'} disabled:opacity-40"
          >
            <span
              class="inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform
                {formData.case_sensitive ? 'translate-x-4' : 'translate-x-1'}"
            ></span>
          </button>
        </label>
      </div>
    </div>

    <div class="px-6 py-4 border-t border-stone-100 flex-shrink-0 flex gap-3 justify-end">
      <button
        onclick={onclose}
        class="px-4 py-2 text-sm text-stone-600 border border-stone-200 rounded-lg hover:bg-stone-50 transition-colors"
      >
        取消
      </button>
      <button
        onclick={onsave}
        disabled={saving || !formData.keyword || !formData.tag}
        class="px-4 py-2 text-sm font-medium bg-stone-800 text-white rounded-lg
            hover:bg-stone-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {editing ? '更新关键词' : '添加关键词'}
      </button>
    </div>
  </div>
</dialog>
