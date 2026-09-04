<script>
  import { onMount } from 'svelte';
  import { api } from './api.js';

  let keywords = $state([]);
  let loading = $state(false);
  let saving = $state(false);
  let error = $state(null);
  let notice = $state(null);
  let showDialog = $state(false);
  let editingKeyword = $state(null);
  let historySince = $state(new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10));
  let historyRuns = $state({});

  // 5 preset colours matching the design. These must be complete literal strings
  // so Tailwind includes them in the bundle.
  const PRESET_COLORS = [
    { hex: '#3B82F6', bg: 'bg-blue-500',   label: '蓝' },
    { hex: '#10B981', bg: 'bg-emerald-500', label: '绿' },
    { hex: '#F59E0B', bg: 'bg-amber-500',   label: '橙' },
    { hex: '#EF4444', bg: 'bg-red-500',     label: '红' },
    { hex: '#8B5CF6', bg: 'bg-violet-500',  label: '紫' },
  ];

  let formData = $state({
    keyword: '', tag: '', color: '#3B82F6', priority: 0,
    case_sensitive: false, whole_word: false,
  });

  // Live preview of the highlight effect — updates as the form changes.
  let previewHtml = $derived(() => {
    if (!formData.keyword || !formData.color) return '验证码：123456';
    const safe = formData.keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const text = `您的验证码是 ${formData.keyword}839204`;
    const flags = formData.case_sensitive ? 'g' : 'gi';
    const marked = text.replace(
      new RegExp(`(${safe})`, flags),
      `<mark style="background:${formData.color}20;border-bottom:2px solid ${formData.color};color:inherit;padding:0 2px;border-radius:2px;font-weight:600">$1</mark>`
    );
    return marked;
  });

  onMount(loadKeywords);

  async function loadKeywords() {
    loading = true; error = null;
    try {
      const r = await api.get('/api/keywords');
      if (r.keywords) keywords = r.keywords;
    } catch (err) {
      error = '关键词加载失败';
    } finally {
      loading = false;
    }
  }

  function openAdd() {
    formData = { keyword: '', tag: '', color: '#3B82F6', priority: 0, case_sensitive: false, whole_word: false };
    editingKeyword = null;
    showDialog = true;
  }

  function openEdit(kw) {
    formData = { keyword: kw.keyword, tag: kw.tag, color: kw.color || '#3B82F6',
      priority: kw.priority || 0, case_sensitive: kw.case_sensitive || false, whole_word: kw.whole_word || false };
    editingKeyword = kw;
    showDialog = true;
  }

  async function save() {
    error = null;
    notice = null;
    saving = true;
    try {
      if (editingKeyword) {
        await api.put(`/api/keywords/${editingKeyword.id}`, {
          tag: formData.tag,
          color: formData.color,
          priority: formData.priority,
        });
        notice = '关键词显示信息已更新。';
      } else {
        await api.post('/api/keywords', formData);
        notice = '关键词已添加，将用于之后收到的新短信。';
      }
      showDialog = false;
      await loadKeywords();
    } catch (err) {
      error = err.message === 'Keyword already exists'
        ? '该关键词已存在，请换一个'
        : err.message || '保存失败';
    } finally {
      saving = false;
    }
  }

  async function remove(kw) {
    if (!confirm(`删除未使用的关键词「${kw.keyword}」？\n\n已有历史短信引用的关键词只能停用。`)) return;
    saving = true;
    error = null;
    notice = null;
    try {
      await api.delete(`/api/keywords/${kw.id}`);
      notice = '未使用的关键词已删除。';
      await loadKeywords();
    } catch (err) {
      error = err.message || '删除失败';
    } finally {
      saving = false;
    }
  }

  async function toggle(kw) {
    saving = true;
    error = null;
    notice = null;
    try {
      await api.put(`/api/keywords/${kw.id}`, { is_active: !kw.is_active });
      historyRuns = { ...historyRuns, [kw.id]: null };
      notice = kw.is_active
        ? '关键词已停用，已有历史标签保持不变但不再显示。'
        : '关键词已启用，将用于之后收到的新短信。';
      await loadKeywords();
    } catch (err) {
      error = err.message || '操作失败';
    } finally {
      saving = false;
    }
  }

  async function processHistory(kw) {
    if (!historySince) {
      error = '请选择历史短信的起始日期';
      return;
    }
    const previous = historyRuns[kw.id];
    if (!previous && !confirm(
      `把关键词「${kw.keyword}」应用到 ${historySince} 起的历史短信？\n\n每次只检查最多 200 条记录。`
    )) return;

    saving = true;
    error = null;
    notice = null;
    try {
      const window = previous || {
        since: new Date(`${historySince}T00:00:00`).toISOString(),
        until: new Date().toISOString(),
        cursor: null,
        processed: 0,
        inserted: 0,
      };
      const result = await api.post(`/api/keywords/${kw.id}/history`, {
        since: window.since,
        until: window.until,
        cursor: window.cursor,
      });
      const progress = {
        ...window,
        cursor: result.next_cursor,
        has_more: result.has_more,
        processed: window.processed + result.processed,
        inserted: window.inserted + result.inserted,
      };
      historyRuns = { ...historyRuns, [kw.id]: result.has_more ? progress : null };
      notice = `累计检查 ${progress.processed} 条记录，新增 ${progress.inserted} 个标签。`
        + (result.has_more ? '如需继续，请再次点击。' : '所选时间范围已处理完成。');
    } catch (err) {
      error = err.message || '历史短信处理失败';
    } finally {
      saving = false;
    }
  }

  // Human-readable match description.
  function matchLabel(kw) {
    if (kw.whole_word && kw.case_sensitive) return '整词 · 区分大小写';
    if (kw.whole_word) return '整词';
    if (kw.case_sensitive) return '包含 · 区分大小写';
    return '包含';
  }
</script>

<div class="bg-white lg:bg-transparent">
  <div class="flex justify-between items-start gap-3 px-4 py-4 border-y border-stone-200 lg:border-0 lg:p-0 lg:mb-5">
    <div class="min-w-0">
      <h2 class="text-lg sm:text-xl font-bold text-stone-900">关键词高亮</h2>
      <p class="text-sm text-stone-500 mt-0.5">关键词默认只影响之后收到的新短信；历史短信必须手动逐批处理。</p>
    </div>
    <button onclick={openAdd}
      class="shrink-0 px-3 sm:px-4 py-2 bg-stone-800 text-white text-sm font-medium rounded-lg hover:bg-stone-700 transition-colors flex items-center gap-1.5">
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
      </svg>
      <span class="hidden min-[360px]:inline">添加关键词</span>
    </button>
  </div>

  {#if error}
    <div class="bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-lg mb-4 text-sm">{error}</div>
  {/if}
  {#if notice}
    <div class="bg-emerald-50 border border-emerald-200 text-emerald-700 px-4 py-3 rounded-lg mb-4 text-sm">{notice}</div>
  {/if}

  <div class="px-4 pb-3 lg:px-0 flex justify-end">
    <label class="text-xs text-stone-500">
      历史起始日期
      <input type="date" bind:value={historySince}
        class="block mt-1 px-2 py-1.5 border border-stone-300 rounded-lg text-sm text-stone-700" />
    </label>
  </div>

  {#if loading}
    <div class="py-10 text-center">
      <div class="inline-block w-6 h-6 border-2 border-stone-300 border-t-stone-600 rounded-full animate-spin"></div>
      <p class="text-stone-400 mt-2 text-sm">加载中…</p>
    </div>

  {:else if keywords.length === 0}
    <div class="py-14 text-center bg-stone-50 rounded-xl border border-stone-200">
      <p class="text-stone-400 mb-3">暂未配置关键词</p>
      <button onclick={openAdd} class="text-sm text-action-text hover:underline">添加第一个关键词</button>
    </div>

  {:else}
    <div class="hidden sm:block overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-stone-200 text-left">
            <!-- 效果预览 210 / 标签 96 / 优先级 60 / 匹配方式 96 / 命中 flex / 启用 72 / 操作 -->
            <th class="px-4 py-2.5 text-[11px] font-semibold text-stone-400 tracking-widest uppercase">效果预览</th>
            <th class="px-4 py-2.5 text-[11px] font-semibold text-stone-400 tracking-widest uppercase">标签</th>
            <th class="px-4 py-2.5 text-[11px] font-semibold text-stone-400 tracking-widest uppercase">优先级</th>
            <th class="px-4 py-2.5 text-[11px] font-semibold text-stone-400 tracking-widest uppercase">匹配方式</th>
            <th class="px-4 py-2.5 text-[11px] font-semibold text-stone-400 tracking-widest uppercase text-right">命中</th>
            <th class="px-4 py-2.5 text-[11px] font-semibold text-stone-400 tracking-widest uppercase text-right">启用</th>
            <th class="px-4 py-2.5 text-[11px] font-semibold text-stone-400 tracking-widest uppercase"></th>
          </tr>
        </thead>
        <tbody>
          {#each keywords as kw}
            <tr class="border-b border-stone-100 hover:bg-stone-50 transition-colors {kw.is_active ? '' : 'opacity-55'}">
              <!-- 效果预览: shows a real highlighted sample instead of a raw hex value -->
              <td class="px-4 py-2.5 font-mono text-xs max-w-[210px]">
                <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                {@html `您的<mark style="background:${kw.color}20;border-bottom:2px solid ${kw.color};color:inherit;padding:0 1px;border-radius:2px;font-weight:600">${kw.keyword}</mark>是 839204`}
              </td>
              <!-- 标签 -->
              <td class="px-4 py-2.5">
                <span class="inline-flex px-2 py-0.5 rounded text-xs font-medium"
                  style="background:{kw.color}20;color:{kw.color};border:1px solid {kw.color}50">
                  {kw.tag}
                </span>
              </td>
              <!-- 优先级 -->
              <td class="px-4 py-2.5 font-mono text-center tabular-nums">{kw.priority}</td>
              <!-- 匹配方式 — human readable, collapses two checkboxes -->
              <td class="px-4 py-2.5 text-stone-500 text-xs">{matchLabel(kw)}</td>
              <!-- 命中次数 -->
              <td class="px-4 py-2.5 font-mono text-right tabular-nums text-stone-500">{kw.usage_count || 0}</td>
              <!-- 启用开关-->
              <td class="px-4 py-2.5 text-right">
                <button onclick={() => toggle(kw)}
                  class="relative inline-flex h-5 w-9 items-center rounded-full transition-colors
                    {kw.is_active ? 'bg-stone-800' : 'bg-stone-200'}"
                  title={kw.is_active ? '点击停用' : '点击启用'}>
                  <span class="sr-only">启用</span>
                  <span class="inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform
                    {kw.is_active ? 'translate-x-4' : 'translate-x-1'}"></span>
                </button>
              </td>
              <!-- 操作 -->
              <td class="px-4 py-2.5">
                <div class="flex items-center gap-1">
                  {#if kw.is_active}
                    <button onclick={() => processHistory(kw)} disabled={saving}
                      aria-label={historyRuns[kw.id] ? '继续历史处理' : '应用到历史'}
                      class="px-2 py-1 text-xs text-action-text hover:bg-stone-100 rounded-lg disabled:opacity-40">
                      {historyRuns[kw.id] ? '继续历史处理' : '应用到历史'}
                    </button>
                  {/if}
                  <button onclick={() => openEdit(kw)} title="编辑" aria-label="编辑关键词"
                    class="p-1.5 text-stone-400 hover:text-stone-700 hover:bg-stone-100 rounded-lg transition-colors">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                        d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
                    </svg>
                  </button>
                  <button onclick={() => remove(kw)} title="删除" aria-label="删除关键词"
                    class="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
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
      {#each keywords as kw}
        <div class="px-4 py-3 {kw.is_active ? '' : 'opacity-55'}">
          <div class="flex items-start gap-3">
            <div class="min-w-0 flex-1">
              <p class="font-mono text-sm text-stone-700 leading-relaxed">
                <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                {@html `您的<mark style="background:${kw.color}20;border-bottom:2px solid ${kw.color};color:inherit;padding:0 1px;border-radius:2px;font-weight:600">${kw.keyword}</mark>是 839204`}
              </p>
              <div class="flex flex-wrap items-center gap-2 mt-2 text-xs text-stone-400">
                <span class="inline-flex px-2 py-0.5 rounded font-medium"
                  style="background:{kw.color}20;color:{kw.color};border:1px solid {kw.color}50">{kw.tag}</span>
                <span>{matchLabel(kw)}</span>
                <span>优先级 <strong class="font-mono text-stone-600">{kw.priority}</strong></span>
                <span>命中 <strong class="font-mono text-stone-600">{kw.usage_count || 0}</strong></span>
              </div>
            </div>
            <button onclick={() => toggle(kw)}
              class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0
                {kw.is_active ? 'bg-stone-800' : 'bg-stone-200'}"
              aria-label={kw.is_active ? '停用关键词' : '启用关键词'}>
              <span class="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform
                {kw.is_active ? 'translate-x-6' : 'translate-x-1'}"></span>
            </button>
          </div>
          <div class="mt-2 flex justify-end gap-1">
            {#if kw.is_active}
              <button onclick={() => processHistory(kw)} disabled={saving}
                aria-label={historyRuns[kw.id] ? '继续历史处理' : '应用到历史'}
                class="min-h-9 px-3 text-xs text-action-text rounded-lg hover:bg-stone-100 disabled:opacity-40">
                {historyRuns[kw.id] ? '继续历史处理' : '应用到历史'}
              </button>
            {/if}
            <button onclick={() => openEdit(kw)} aria-label="编辑关键词" class="min-h-9 px-3 text-xs text-stone-600 rounded-lg hover:bg-stone-100">编辑</button>
            <button onclick={() => remove(kw)} class="min-h-9 px-3 text-xs text-red-600 rounded-lg hover:bg-red-50">删除</button>
          </div>
        </div>
      {/each}
    </div>

    <!-- Priority explainer card -->
    <div class="px-4 py-3 bg-stone-50 border-b border-stone-200 lg:mt-4 lg:border lg:rounded-xl text-xs text-stone-500">
      <strong class="text-stone-700">优先级说明：</strong>
      同一段文字被两个关键词同时命中时，数字大的那个上色。所以「验证码」应该高于「优惠」。
    </div>
  {/if}
</div>


<!-- ─── Add / Edit dialog ────────────────────────────────────────────────── -->
{#if showDialog}
  <dialog open aria-modal="true" aria-labelledby="keyword-dialog-title"
    class="fixed inset-0 m-0 w-full h-full max-w-none max-h-none border-0 bg-stone-900/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4"
    onclick={(e) => e.target === e.currentTarget && (showDialog = false)}>
    <div class="bg-white rounded-t-2xl sm:rounded-2xl shadow-modal w-full max-w-md flex flex-col max-h-[calc(100dvh-74px)] sm:max-h-[90vh] overflow-hidden">

      <div class="px-6 py-4 border-b border-stone-100 flex-shrink-0 flex items-center justify-between">
        <h3 id="keyword-dialog-title" class="font-semibold text-stone-900">{editingKeyword ? '编辑关键词' : '添加关键词'}</h3>
        <button onclick={() => showDialog = false} aria-label="关闭" class="text-stone-400 hover:text-stone-700">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <!-- Live preview — updates as you type -->
      <div class="px-6 py-3 bg-stone-50 border-b border-stone-100 flex-shrink-0">
        <p class="text-[11px] font-semibold text-stone-400 uppercase tracking-widest mb-1">效果预览</p>
        <p class="text-sm font-mono text-stone-700 leading-relaxed">
          <!-- eslint-disable-next-line svelte/no-at-html-tags -->
          {@html previewHtml}
        </p>
      </div>

      <div class="px-6 py-4 space-y-4 overflow-y-auto flex-1 min-h-0">
        {#if error}
          <div class="px-3 py-2 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">{error}</div>
        {/if}

        <div>
          <label for="keyword-value" class="block text-xs font-semibold text-stone-500 mb-1 tracking-wide uppercase">关键词</label>
          <input id="keyword-value" type="text" bind:value={formData.keyword} disabled={Boolean(editingKeyword)} placeholder="例：验证码"
            class="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg
              focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 disabled:bg-stone-100 disabled:text-stone-500" />
        </div>

        <div>
          <label for="keyword-tag" class="block text-xs font-semibold text-stone-500 mb-1 tracking-wide uppercase">标签</label>
          <input id="keyword-tag" type="text" bind:value={formData.tag} placeholder="例：OTP"
            class="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg
              focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100" />
        </div>

        <!-- 5 preset colour swatches — no colour picker (hard to use precisely on mobile) -->
        <div>
          <p class="block text-xs font-semibold text-stone-500 mb-2 tracking-wide uppercase">颜色</p>
          <div class="flex items-center gap-2">
            {#each PRESET_COLORS as p}
              <button
                onclick={() => { formData.color = p.hex; }}
                title={p.label} aria-label={`选择${p.label}色`}
                class="w-7 h-7 rounded-full {p.bg} transition-transform hover:scale-110
                  {formData.color === p.hex ? 'ring-2 ring-offset-2 ring-stone-700 scale-110' : ''}"
              ></button>
            {/each}
          </div>
        </div>

        <div>
          <label for="keyword-priority" class="block text-xs font-semibold text-stone-500 mb-1 tracking-wide uppercase">优先级</label>
          <input id="keyword-priority" type="number" bind:value={formData.priority} min="0" max="100"
            class="w-full px-3 py-2 text-sm border border-stone-300 rounded-lg
              focus:outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100" />
        </div>

        <!-- Matching options as toggle rows -->
        <div class="space-y-1">
          <label class="flex items-center justify-between py-2.5 cursor-pointer">
            <span class="text-sm text-stone-700">整词匹配</span>
            <button onclick={() => { formData.whole_word = !formData.whole_word; }}
              aria-label="整词匹配" disabled={Boolean(editingKeyword)}
              class="relative inline-flex h-5 w-9 items-center rounded-full transition-colors
                {formData.whole_word ? 'bg-stone-800' : 'bg-stone-200'} disabled:opacity-40">
              <span class="inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform
                {formData.whole_word ? 'translate-x-4' : 'translate-x-1'}"></span>
            </button>
          </label>
          <label class="flex items-center justify-between py-2.5 cursor-pointer border-t border-stone-100">
            <span class="text-sm text-stone-700">区分大小写</span>
            <button onclick={() => { formData.case_sensitive = !formData.case_sensitive; }}
              aria-label="区分大小写" disabled={Boolean(editingKeyword)}
              class="relative inline-flex h-5 w-9 items-center rounded-full transition-colors
                {formData.case_sensitive ? 'bg-stone-800' : 'bg-stone-200'} disabled:opacity-40">
              <span class="inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform
                {formData.case_sensitive ? 'translate-x-4' : 'translate-x-1'}"></span>
            </button>
          </label>
        </div>
      </div>

      <div class="px-6 py-4 border-t border-stone-100 flex-shrink-0 flex gap-3 justify-end">
        <button onclick={() => showDialog = false}
          class="px-4 py-2 text-sm text-stone-600 border border-stone-200 rounded-lg hover:bg-stone-50 transition-colors">
          取消
        </button>
        <button onclick={save} disabled={saving || !formData.keyword || !formData.tag}
          class="px-4 py-2 text-sm font-medium bg-stone-800 text-white rounded-lg
            hover:bg-stone-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
          {editingKeyword ? '更新关键词' : '添加关键词'}
        </button>
      </div>
    </div>
  </dialog>
{/if}
