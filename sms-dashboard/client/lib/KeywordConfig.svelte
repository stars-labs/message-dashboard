<script lang="ts">
  import { confirmAction } from './confirm.svelte.js';
  import { onMount } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import type { HistoryCursor } from '../../shared/api/history.js';
  import type { KeywordWithUsage } from '../../shared/api/keywords.js';
  import { ApiError, contractApi, errorMessage } from './api.js';
  import MessageHighlight from './MessageHighlight.svelte';
  import { safeColor } from './message-highlight.js';
  import KeywordDialog from './keywords/KeywordDialog.svelte';
  import { emptyKeywordForm, keywordForm } from './keywords/form.js';

  interface HistoryProgress {
    since: string;
    until: string;
    cursor: HistoryCursor | null;
    processed: number;
    inserted: number;
  }

  let keywords = $state<KeywordWithUsage[]>([]);
  let loading = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let showDialog = $state(false);
  let editingKeyword = $state<KeywordWithUsage | null>(null);
  let historySince = $state(new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10));
  const historyRuns = new SvelteMap<number, HistoryProgress>();

  let formData = $state(emptyKeywordForm());

  onMount(loadKeywords);

  async function loadKeywords() {
    loading = true;
    error = null;
    try {
      const r = await contractApi.keywords.list();
      keywords = r.keywords;
    } catch {
      error = '关键词加载失败';
    } finally {
      loading = false;
    }
  }

  function openAdd() {
    formData = emptyKeywordForm();
    editingKeyword = null;
    showDialog = true;
  }

  function openEdit(kw: KeywordWithUsage) {
    formData = keywordForm(kw);
    editingKeyword = kw;
    showDialog = true;
  }

  async function save() {
    error = null;
    notice = null;
    saving = true;
    try {
      if (editingKeyword) {
        await contractApi.keywords.update({
          params: { id: String(editingKeyword.id) },
          body: { tag: formData.tag, color: formData.color, priority: formData.priority },
        });
        notice = '关键词显示信息已更新。';
      } else {
        await contractApi.keywords.create(formData);
        notice = '关键词已添加，将用于之后收到的新短信。';
      }
      showDialog = false;
      await loadKeywords();
    } catch (err) {
      error =
        err instanceof ApiError && err.status === 409
          ? '该关键词已存在，请换一个'
          : errorMessage(err, '保存失败');
    } finally {
      saving = false;
    }
  }

  async function remove(kw: KeywordWithUsage) {
    if (
      !(await confirmAction({
        message: `删除未使用的关键词「${kw.keyword}」？\n\n已有历史短信引用的关键词只能停用。`,
        confirmLabel: '删除',
        danger: true,
      }))
    )
      return;
    saving = true;
    error = null;
    notice = null;
    try {
      await contractApi.keywords.remove({ params: { id: String(kw.id) } });
      notice = '未使用的关键词已删除。';
      await loadKeywords();
    } catch (err) {
      error = errorMessage(err, '删除失败');
    } finally {
      saving = false;
    }
  }

  async function toggle(kw: KeywordWithUsage) {
    saving = true;
    error = null;
    notice = null;
    try {
      await contractApi.keywords.update({
        params: { id: String(kw.id) },
        body: { is_active: !kw.is_active },
      });
      historyRuns.delete(kw.id);
      notice = kw.is_active
        ? '关键词已停用，已有历史标签保持不变但不再显示。'
        : '关键词已启用，将用于之后收到的新短信。';
      await loadKeywords();
    } catch (err) {
      error = errorMessage(err, '操作失败');
    } finally {
      saving = false;
    }
  }

  async function processHistory(kw: KeywordWithUsage) {
    if (!historySince) {
      error = '请选择历史短信的起始日期';
      return;
    }
    const previous = historyRuns.get(kw.id);
    if (
      !previous &&
      !(await confirmAction({
        message: `把关键词「${kw.keyword}」应用到 ${historySince} 起的历史短信？\n\n每次只检查最多 200 条记录。`,
        confirmLabel: '开始处理',
      }))
    )
      return;

    saving = true;
    error = null;
    notice = null;
    try {
      const window: HistoryProgress = previous ?? {
        since: new Date(`${historySince}T00:00:00`).toISOString(),
        until: new Date().toISOString(),
        cursor: null,
        processed: 0,
        inserted: 0,
      };
      const result = await contractApi.keywords.history({
        params: { id: String(kw.id) },
        body: { since: window.since, until: window.until, cursor: window.cursor },
      });
      const progress: HistoryProgress = {
        ...window,
        cursor: result.next_cursor,
        processed: window.processed + result.processed,
        inserted: window.inserted + result.inserted,
      };
      if (result.has_more) historyRuns.set(kw.id, progress);
      else historyRuns.delete(kw.id);
      notice =
        `累计检查 ${String(progress.processed)} 条记录，新增 ${String(progress.inserted)} 个标签。` +
        (result.has_more ? '如需继续，请再次点击。' : '所选时间范围已处理完成。');
    } catch (err) {
      error = errorMessage(err, '历史短信处理失败');
    } finally {
      saving = false;
    }
  }

  function matchLabel(kw: KeywordWithUsage) {
    if (kw.whole_word && kw.case_sensitive) return '整词 · 区分大小写';
    if (kw.whole_word) return '整词';
    if (kw.case_sensitive) return '包含 · 区分大小写';
    return '包含';
  }
</script>

<div class="bg-white lg:bg-transparent">
  <div
    class="flex justify-between items-start gap-3 px-4 py-4 border-y border-stone-200 lg:border-0 lg:p-0 lg:mb-5"
  >
    <div class="min-w-0">
      <h2 class="text-lg sm:text-xl font-bold text-stone-900">关键词高亮</h2>
      <p class="text-sm text-stone-500 mt-0.5">
        关键词默认只影响之后收到的新短信；历史短信必须手动逐批处理。
      </p>
    </div>
    <button
      onclick={openAdd}
      class="shrink-0 px-3 sm:px-4 py-2 bg-stone-800 text-white text-sm font-medium rounded-lg hover:bg-stone-700 transition-colors flex items-center gap-1.5"
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
      </svg>
      <span class="hidden min-[360px]:inline">添加关键词</span>
    </button>
  </div>

  {#if error}
    <div class="bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-lg mb-4 text-sm">
      {error}
    </div>
  {/if}
  {#if notice}
    <div
      class="bg-emerald-50 border border-emerald-200 text-emerald-700 px-4 py-3 rounded-lg mb-4 text-sm"
    >
      {notice}
    </div>
  {/if}

  <div class="px-4 pb-3 lg:px-0 flex justify-end">
    <label class="text-xs text-stone-500">
      历史起始日期
      <input
        type="date"
        bind:value={historySince}
        class="block mt-1 px-2 py-1.5 border border-stone-300 rounded-lg text-sm text-stone-700"
      />
    </label>
  </div>

  {#if loading}
    <div class="py-10 text-center">
      <div
        class="inline-block w-6 h-6 border-2 border-stone-300 border-t-stone-600 rounded-full animate-spin"
      ></div>
      <p class="text-stone-400 mt-2 text-sm">加载中…</p>
    </div>
  {:else if keywords.length === 0}
    <div class="py-14 text-center bg-stone-50 rounded-xl border border-stone-200">
      <p class="text-stone-400 mb-3">暂未配置关键词</p>
      <button onclick={openAdd} class="text-sm text-action-text hover:underline"
        >添加第一个关键词</button
      >
    </div>
  {:else}
    <div class="hidden sm:block overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-stone-200 text-left">
            <th
              class="px-4 py-2.5 text-[11px] font-semibold text-stone-400 tracking-widest uppercase"
              >效果预览</th
            >
            <th
              class="px-4 py-2.5 text-[11px] font-semibold text-stone-400 tracking-widest uppercase"
              >标签</th
            >
            <th
              class="px-4 py-2.5 text-[11px] font-semibold text-stone-400 tracking-widest uppercase"
              >优先级</th
            >
            <th
              class="px-4 py-2.5 text-[11px] font-semibold text-stone-400 tracking-widest uppercase"
              >匹配方式</th
            >
            <th
              class="px-4 py-2.5 text-[11px] font-semibold text-stone-400 tracking-widest uppercase text-right"
              >命中</th
            >
            <th
              class="px-4 py-2.5 text-[11px] font-semibold text-stone-400 tracking-widest uppercase text-right"
              >启用</th
            >
            <th
              class="px-4 py-2.5 text-[11px] font-semibold text-stone-400 tracking-widest uppercase"
            ></th>
          </tr>
        </thead>
        <tbody>
          {#each keywords as kw (kw.id)}
            {@const color = safeColor(kw.color)}
            <tr
              class="border-b border-stone-100 hover:bg-stone-50 transition-colors {kw.is_active
                ? ''
                : 'opacity-55'}"
            >
              <td class="px-4 py-2.5 font-mono text-xs max-w-[210px]">
                <MessageHighlight
                  content={`您的${kw.keyword}是 839204`}
                  keywords={[{ keyword: kw.keyword, color: kw.color, tag: kw.tag }]}
                />
              </td>
              <td class="px-4 py-2.5">
                <span
                  class="inline-flex px-2 py-0.5 rounded text-xs font-medium"
                  style="background:{color}20;color:{color};border:1px solid {color}50"
                >
                  {kw.tag}
                </span>
              </td>
              <td class="px-4 py-2.5 font-mono text-center tabular-nums">{kw.priority}</td>
              <td class="px-4 py-2.5 text-stone-500 text-xs">{matchLabel(kw)}</td>
              <td class="px-4 py-2.5 font-mono text-right tabular-nums text-stone-500"
                >{kw.usage_count || 0}</td
              >
              <td class="px-4 py-2.5 text-right">
                <button
                  onclick={() => toggle(kw)}
                  class="relative inline-flex h-5 w-9 items-center rounded-full transition-colors
                    {kw.is_active ? 'bg-stone-800' : 'bg-stone-200'}"
                  title={kw.is_active ? '点击停用' : '点击启用'}
                >
                  <span class="sr-only">启用</span>
                  <span
                    class="inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform
                    {kw.is_active ? 'translate-x-4' : 'translate-x-1'}"
                  ></span>
                </button>
              </td>
              <td class="px-4 py-2.5">
                <div class="flex items-center gap-1">
                  {#if kw.is_active}
                    <button
                      onclick={() => processHistory(kw)}
                      disabled={saving}
                      aria-label={historyRuns.has(kw.id) ? '继续历史处理' : '应用到历史'}
                      class="px-2 py-1 text-xs text-action-text hover:bg-stone-100 rounded-lg disabled:opacity-40"
                    >
                      {historyRuns.has(kw.id) ? '继续历史处理' : '应用到历史'}
                    </button>
                  {/if}
                  <button
                    onclick={() => {
                      openEdit(kw);
                    }}
                    title="编辑"
                    aria-label="编辑关键词"
                    class="p-1.5 text-stone-400 hover:text-stone-700 hover:bg-stone-100 rounded-lg transition-colors"
                  >
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                      />
                    </svg>
                  </button>
                  <button
                    onclick={() => remove(kw)}
                    title="删除"
                    aria-label="删除关键词"
                    class="p-1.5 text-red-600 hover:text-red-700 hover:bg-red-50 rounded-lg transition-colors"
                  >
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                      />
                    </svg>
                  </button>
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <div class="sm:hidden border-b border-stone-200 divide-y divide-stone-100">
      {#each keywords as kw (kw.id)}
        {@const color = safeColor(kw.color)}
        <div class="px-4 py-3 {kw.is_active ? '' : 'opacity-55'}">
          <div class="flex items-start gap-3">
            <div class="min-w-0 flex-1">
              <p class="font-mono text-sm text-stone-700 leading-relaxed">
                <MessageHighlight
                  content={`您的${kw.keyword}是 839204`}
                  keywords={[{ keyword: kw.keyword, color: kw.color, tag: kw.tag }]}
                />
              </p>
              <div class="flex flex-wrap items-center gap-2 mt-2 text-xs text-stone-400">
                <span
                  class="inline-flex px-2 py-0.5 rounded font-medium"
                  style="background:{color}20;color:{color};border:1px solid {color}50"
                  >{kw.tag}</span
                >
                <span>{matchLabel(kw)}</span>
                <span>优先级 <strong class="font-mono text-stone-600">{kw.priority}</strong></span>
                <span
                  >命中 <strong class="font-mono text-stone-600">{kw.usage_count || 0}</strong
                  ></span
                >
              </div>
            </div>
            <button
              onclick={() => toggle(kw)}
              class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0
                {kw.is_active ? 'bg-stone-800' : 'bg-stone-200'}"
              aria-label={kw.is_active ? '停用关键词' : '启用关键词'}
            >
              <span
                class="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform
                {kw.is_active ? 'translate-x-6' : 'translate-x-1'}"
              ></span>
            </button>
          </div>
          <div class="mt-2 flex justify-end gap-1">
            {#if kw.is_active}
              <button
                onclick={() => processHistory(kw)}
                disabled={saving}
                aria-label={historyRuns.has(kw.id) ? '继续历史处理' : '应用到历史'}
                class="min-h-9 px-3 text-xs text-action-text rounded-lg hover:bg-stone-100 disabled:opacity-40"
              >
                {historyRuns.has(kw.id) ? '继续历史处理' : '应用到历史'}
              </button>
            {/if}
            <button
              onclick={() => {
                openEdit(kw);
              }}
              aria-label="编辑关键词"
              class="min-h-9 px-3 text-xs text-stone-600 rounded-lg hover:bg-stone-100">编辑</button
            >
            <button
              onclick={() => remove(kw)}
              class="min-h-9 px-3 text-xs text-red-600 rounded-lg hover:bg-red-50">删除</button
            >
          </div>
        </div>
      {/each}
    </div>

    <div
      class="px-4 py-3 bg-stone-50 border-b border-stone-200 lg:mt-4 lg:border lg:rounded-xl text-xs text-stone-500"
    >
      <strong class="text-stone-700">优先级说明：</strong>
      同一段文字被两个关键词同时命中时，数字大的那个上色。所以「验证码」应该高于「优惠」。
    </div>
  {/if}
</div>

{#if showDialog}
  <KeywordDialog
    bind:formData
    editing={Boolean(editingKeyword)}
    {saving}
    {error}
    onclose={() => {
      showDialog = false;
    }}
    onsave={save}
  />
{/if}
