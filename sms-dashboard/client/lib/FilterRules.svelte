<script>
  import { onMount } from 'svelte';
  import { api } from './api.js';

  const RULE_TYPES = [
    { value: 'body_keyword', label: '正文关键词', hint: '短信正文包含这段文字就隐藏，例如 中国海关提示' },
    { value: 'sender', label: '发送方号码', hint: '来自这个号码的短信一律隐藏，只填数字，例如 10086' },
  ];

  let rules = $state([]);
  let loading = $state(true);
  let saving = $state(false);
  let error = $state(null);
  let notice = $state(null);
  let historySince = $state(new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10));
  let historyRuns = $state({});

  let editingId = $state(null);
  let form = $state({ rule_type: 'body_keyword', pattern: '', note: '' });

  let grouped = $derived(
    RULE_TYPES.map((t) => ({
      ...t,
      items: rules.filter((r) => r.rule_type === t.value),
    }))
  );

  let activeHint = $derived(RULE_TYPES.find((t) => t.value === form.rule_type)?.hint ?? '');

  onMount(loadRules);

  async function loadRules() {
    loading = true;
    error = null;
    try {
      const response = await api.get('/api/filters');
      rules = response?.filters || [];
    } catch (err) {
      error = err.message || '加载过滤规则失败';
    } finally {
      loading = false;
    }
  }

  function resetForm() {
    editingId = null;
    form = { rule_type: 'body_keyword', pattern: '', note: '' };
  }

  function startEdit(rule) {
    editingId = rule.id;
    form = { rule_type: rule.rule_type, pattern: rule.pattern, note: rule.note || '' };
  }

  async function save() {
    if (!form.pattern.trim()) {
      error = '规则内容不能为空';
      return;
    }
    saving = true;
    error = null;
    notice = null;
    try {
      await (editingId
        ? api.put(`/api/filters/${editingId}`, { note: form.note })
        : api.post('/api/filters', form));
      notice = editingId ? '备注已更新。' : '规则已添加，将用于之后收到的新短信。';
      resetForm();
      await loadRules();
    } catch (err) {
      error = err.message || '保存失败';
    } finally {
      saving = false;
    }
  }

  async function toggleActive(rule) {
    saving = true;
    error = null;
    notice = null;
    try {
      await api.put(`/api/filters/${rule.id}`, { is_active: !rule.is_active });
      historyRuns = { ...historyRuns, [rule.id]: null };
      notice = rule.is_active
        ? '规则已停用，历史短信保持原判定。'
        : '规则已启用，将用于之后收到的新短信。';
      await loadRules();
    } catch (err) {
      error = err.message || '操作失败';
    } finally {
      saving = false;
    }
  }

  async function remove(rule) {
    if (!confirm(`删除未使用的规则「${rule.pattern}」？\n\n已有历史短信引用的规则只能停用。`)) {
      return;
    }
    saving = true;
    error = null;
    notice = null;
    try {
      await api.delete(`/api/filters/${rule.id}`);
      notice = '未使用的规则已删除。';
      await loadRules();
    } catch (err) {
      error = err.message || '删除失败';
    } finally {
      saving = false;
    }
  }

  async function processHistory(rule) {
    if (!historySince) {
      error = '请选择历史短信的起始日期';
      return;
    }
    const previous = historyRuns[rule.id];
    if (!previous && !confirm(
      `${rule.is_active ? '应用' : '重新判定'}规则「${rule.pattern}」自 ${historySince} 起的历史短信？\n\n每次只处理最多 200 条候选记录。`
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
        changed: 0,
      };
      const result = await api.post(`/api/filters/${rule.id}/history`, {
        since: window.since,
        until: window.until,
        cursor: window.cursor,
      });
      const progress = {
        ...window,
        cursor: result.next_cursor,
        has_more: result.has_more,
        processed: window.processed + result.processed,
        changed: window.changed + result.changed,
      };
      historyRuns = { ...historyRuns, [rule.id]: result.has_more ? progress : null };
      notice = `累计检查 ${progress.processed} 条候选记录，更新 ${progress.changed} 条。`
        + (result.has_more ? '如需继续，请再次点击。' : '所选时间范围已处理完成。');
    } catch (err) {
      error = err.message || '历史短信处理失败';
    } finally {
      saving = false;
    }
  }
</script>

<div class="bg-white lg:bg-transparent lg:space-y-4">

  <!-- Guarantee banner — hoisted to the very top so users see it before
       deciding whether to enable filtering. The old position (page description
       second line, small text) meant users couldn't find the safety guarantee. -->
  <div class="flex items-start gap-3 px-4 py-3 bg-emerald-50 border-y border-emerald-200
    lg:border lg:rounded-xl text-sm text-emerald-800">
    <svg class="w-5 h-5 shrink-0 mt-0.5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
        d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>
    </svg>
    <span><strong>含验证码的短信永不隐藏</strong>，即使发送方在黑名单里。开启过滤不会漏掉任何验证码。</span>
  </div>

  <div class="bg-white border-b border-stone-200 p-4 lg:border lg:rounded-xl lg:shadow-sm">
    <div class="flex flex-col sm:flex-row sm:items-start justify-between gap-3 sm:gap-4">
      <div>
        <h2 class="text-lg font-semibold text-stone-900">垃圾过滤规则</h2>
        <p class="text-sm text-stone-500 mt-1">规则默认只影响之后收到的新短信；历史短信必须手动逐批处理。</p>
      </div>
      <label class="shrink-0 text-xs text-stone-500">
        历史起始日期
        <input type="date" bind:value={historySince}
          class="block mt-1 px-2 py-1.5 border border-stone-300 rounded-lg text-sm text-stone-700" />
      </label>
    </div>

    {#if error}
      <div class="mt-3 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">{error}</div>
    {/if}
    {#if notice}
      <div class="mt-3 p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg text-sm">{notice}</div>
    {/if}
  </div>

  <!-- Add / edit -->
  <div class="bg-white border-b border-stone-200 p-4 lg:border lg:rounded-xl lg:shadow-sm">
    <h3 class="font-medium text-stone-900 mb-3">{editingId ? '编辑规则' : '添加规则'}</h3>
    <div class="grid gap-3 sm:grid-cols-[10rem_1fr_1fr_auto] sm:items-end">
      <div>
        <label class="block text-xs text-stone-500 mb-1" for="fr-type">类型</label>
        <select
          id="fr-type"
          bind:value={form.rule_type}
          disabled={editingId !== null}
          class="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm"
        >
          {#each RULE_TYPES as t}
            <option value={t.value}>{t.label}</option>
          {/each}
        </select>
      </div>
      <div>
        <label class="block text-xs text-stone-500 mb-1" for="fr-pattern">规则内容</label>
        <input
          id="fr-pattern"
          bind:value={form.pattern}
          disabled={editingId !== null}
          placeholder={form.rule_type === 'sender' ? '10086' : '中国海关提示'}
          class="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm font-mono"
        />
      </div>
      <div>
        <label class="block text-xs text-stone-500 mb-1" for="fr-note">备注（可选）</label>
        <input
          id="fr-note"
          bind:value={form.note}
          placeholder="这条规则拦什么"
          class="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm"
        />
      </div>
      <div class="flex gap-2">
        <button
          onclick={save}
          disabled={saving}
          class="px-4 py-2 bg-orange-500 text-white rounded-lg text-sm hover:bg-orange-600 disabled:opacity-50"
        >
          {saving ? '处理中…' : editingId ? '保存' : '添加'}
        </button>
        {#if editingId}
          <button
            onclick={resetForm}
            disabled={saving}
            class="px-3 py-2 border border-stone-300 rounded-lg text-sm text-stone-600 hover:bg-stone-100"
          >
            取消
          </button>
        {/if}
      </div>
    </div>
    <p class="text-xs text-stone-400 mt-2">{activeHint}</p>
  </div>

  <!-- Existing rules -->
  {#if loading}
    <div class="bg-white border-b border-stone-200 p-8 text-center text-stone-400 lg:border lg:rounded-xl">加载中…</div>
  {:else}
    {#each grouped as group}
      <div class="bg-white border-b border-stone-200 lg:border lg:rounded-xl lg:shadow-sm overflow-hidden">
        <div class="px-4 py-2 bg-stone-50 border-b border-stone-200 text-sm font-medium text-stone-700">
          {group.label}
          <span class="text-stone-400 font-normal">· {group.items.length} 条</span>
        </div>
        {#if group.items.length === 0}
          <div class="px-4 py-6 text-center text-sm text-stone-400">暂无规则</div>
        {:else}
          <table class="hidden sm:table w-full text-sm">
            <thead class="text-xs text-stone-500">
              <tr class="border-b border-stone-100">
                <th class="text-left px-4 py-2 font-medium">规则内容</th>
                <th class="text-left px-4 py-2 font-medium">备注</th>
                <th class="text-center px-4 py-2 font-medium">状态</th>
                <th class="text-right px-4 py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {#each group.items as rule (rule.id)}
                <tr class="border-b border-stone-50 last:border-0 {rule.is_active ? '' : 'opacity-50'}">
                  <td class="px-4 py-2 font-mono text-stone-800 break-all">{rule.pattern}</td>
                  <td class="px-4 py-2 text-stone-500">{rule.note || '—'}</td>
                  <td class="px-4 py-2 text-center">
                    <button
                      onclick={() => toggleActive(rule)}
                      disabled={saving}
                      class="px-2 py-0.5 rounded text-xs {rule.is_active
                        ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-stone-200 text-stone-500'} disabled:opacity-50"
                      title="点击切换启用状态"
                    >
                      {rule.is_active ? '启用中' : '已停用'}
                    </button>
                  </td>
                  <td class="px-4 py-2 text-right whitespace-nowrap">
                    <button
                      onclick={() => processHistory(rule)}
                      disabled={saving}
                      class="px-2 py-0.5 text-xs text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded disabled:opacity-50"
                    >{historyRuns[rule.id]?.has_more ? '继续历史处理' : (rule.is_active ? '应用到历史' : '重新判定历史')}</button>
                    <button
                      onclick={() => startEdit(rule)}
                      disabled={saving}
                      class="px-2 py-0.5 text-xs text-stone-500 hover:text-stone-800 hover:bg-stone-100 rounded disabled:opacity-50"
                    >
                      编辑
                    </button>
                    <button
                      onclick={() => remove(rule)}
                      disabled={saving}
                      class="px-2 py-0.5 text-xs text-red-500 hover:text-red-700 hover:bg-red-50 rounded disabled:opacity-50"
                    >
                      删除
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>

          <div class="sm:hidden divide-y divide-stone-100">
            {#each group.items as rule (rule.id)}
              <div class="px-4 py-3 {rule.is_active ? '' : 'opacity-55'}">
                <div class="flex items-start gap-3">
                  <div class="min-w-0 flex-1">
                    <p class="font-mono text-sm font-medium text-stone-800 break-all">{rule.pattern}</p>
                    <p class="text-xs text-stone-400 mt-1">{rule.note || '无备注'}</p>
                  </div>
                  <button
                    onclick={() => toggleActive(rule)}
                    disabled={saving}
                    class="shrink-0 px-2.5 py-1.5 rounded-md text-xs font-medium {rule.is_active
                      ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                      : 'bg-stone-100 text-stone-500 border border-stone-200'} disabled:opacity-50"
                  >{rule.is_active ? '启用中' : '已停用'}</button>
                </div>
                <div class="mt-3 flex items-center gap-2">
                  <div class="ml-auto flex items-center gap-1">
                    <button onclick={() => processHistory(rule)} disabled={saving}
                      class="min-h-9 px-3 text-xs text-blue-600 rounded-lg hover:bg-blue-50 disabled:opacity-50"
                    >{historyRuns[rule.id]?.has_more ? '继续历史处理' : (rule.is_active ? '应用到历史' : '重新判定历史')}</button>
                    <button onclick={() => startEdit(rule)} disabled={saving}
                      class="min-h-9 px-3 text-xs text-stone-600 rounded-lg hover:bg-stone-100 disabled:opacity-50">编辑</button>
                    <button onclick={() => remove(rule)} disabled={saving}
                      class="min-h-9 px-3 text-xs text-red-600 rounded-lg hover:bg-red-50 disabled:opacity-50">删除</button>
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  {/if}
</div>
