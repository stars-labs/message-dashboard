<script>
  import { onMount } from 'svelte';
  import { api } from './api.js';

  const RULE_TYPES = [
    { value: 'body_keyword', label: '正文关键词', hint: '短信正文包含这段文字就隐藏，例如 中国海关提示' },
    { value: 'sender', label: '发送方号码', hint: '来自这个号码的短信一律隐藏，只填数字，例如 10086' },
  ];

  let rules = $state([]);
  let pending = $state(0);
  let loading = $state(true);
  let saving = $state(false);
  let error = $state(null);
  let notice = $state(null);

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
      pending = response?.pending || 0;
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

  // Every mutation returns how much reclassification is left, because a rule
  // change re-judges existing messages. Report it instead of silently finishing.
  function reportOutcome(result, verb) {
    pending = result?.remaining ?? 0;
    const touched = (result?.queued || 0) + (result?.released || 0);
    notice = `${verb}。已重新判定 ${result?.processed ?? 0} 条消息` +
      (touched ? `（受影响 ${touched} 条）` : '') +
      (pending > 0 ? `，还有 ${pending} 条待处理，可点击「继续处理」。` : '。');
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
      const result = editingId
        ? await api.put(`/api/filters/${editingId}`, form)
        : await api.post('/api/filters', form);
      reportOutcome(result, editingId ? '规则已更新' : '规则已添加');
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
      const result = await api.put(`/api/filters/${rule.id}`, { is_active: !rule.is_active });
      reportOutcome(result, rule.is_active ? '规则已停用' : '规则已启用');
      await loadRules();
    } catch (err) {
      error = err.message || '操作失败';
    } finally {
      saving = false;
    }
  }

  async function remove(rule) {
    if (!confirm(`删除规则「${rule.pattern}」？\n\n它当前隐藏了 ${rule.hit_count} 条消息，删除后这些消息会重新判定。`)) {
      return;
    }
    saving = true;
    error = null;
    notice = null;
    try {
      const result = await api.delete(`/api/filters/${rule.id}`);
      reportOutcome(result, '规则已删除');
      await loadRules();
    } catch (err) {
      error = err.message || '删除失败';
    } finally {
      saving = false;
    }
  }

  // Resume an interrupted sweep. Safe to press repeatedly.
  async function continueSweep(reset = false) {
    saving = true;
    error = null;
    notice = null;
    try {
      const result = await api.post(`/api/filters/reclassify${reset ? '?reset=1' : ''}`, {});
      reportOutcome(result, reset ? '已全部重新分类' : '继续处理完成');
      await loadRules();
    } catch (err) {
      error = err.message || '重新分类失败';
    } finally {
      saving = false;
    }
  }
</script>

<div class="space-y-4">
  <div class="bg-white border border-stone-200 rounded-xl shadow-sm p-4">
    <div class="flex items-start justify-between gap-4">
      <div>
        <h2 class="text-lg font-semibold text-stone-900">垃圾过滤规则</h2>
        <p class="text-sm text-stone-500 mt-1">
          命中规则的短信默认不显示，可在消息列表点「已过滤 N 条」查看。
          <span class="text-stone-600">含验证码的短信永不隐藏</span>，即使发送方在黑名单里。
        </p>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        {#if pending > 0}
          <button
            onclick={() => continueSweep(false)}
            disabled={saving}
            class="px-3 py-1.5 text-sm rounded-lg bg-amber-50 border border-amber-300 text-amber-700 hover:bg-amber-100 disabled:opacity-50"
          >
            继续处理 {pending} 条
          </button>
        {/if}
        <button
          onclick={() => continueSweep(true)}
          disabled={saving}
          class="px-3 py-1.5 text-sm rounded-lg border border-stone-300 text-stone-600 hover:bg-stone-100 disabled:opacity-50"
          title="按当前规则重新判定所有历史消息"
        >
          全部重新分类
        </button>
      </div>
    </div>

    {#if error}
      <div class="mt-3 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">{error}</div>
    {/if}
    {#if notice}
      <div class="mt-3 p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg text-sm">{notice}</div>
    {/if}
  </div>

  <!-- Add / edit -->
  <div class="bg-white border border-stone-200 rounded-xl shadow-sm p-4">
    <h3 class="font-medium text-stone-900 mb-3">{editingId ? '编辑规则' : '添加规则'}</h3>
    <div class="grid gap-3 sm:grid-cols-[10rem_1fr_1fr_auto] sm:items-end">
      <div>
        <label class="block text-xs text-stone-500 mb-1" for="fr-type">类型</label>
        <select
          id="fr-type"
          bind:value={form.rule_type}
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
    <div class="bg-white border border-stone-200 rounded-xl p-8 text-center text-stone-400">加载中…</div>
  {:else}
    {#each grouped as group}
      <div class="bg-white border border-stone-200 rounded-xl shadow-sm overflow-hidden">
        <div class="px-4 py-2 bg-stone-50 border-b border-stone-200 text-sm font-medium text-stone-700">
          {group.label}
          <span class="text-stone-400 font-normal">· {group.items.length} 条</span>
        </div>
        {#if group.items.length === 0}
          <div class="px-4 py-6 text-center text-sm text-stone-400">暂无规则</div>
        {:else}
          <table class="w-full text-sm">
            <thead class="text-xs text-stone-500">
              <tr class="border-b border-stone-100">
                <th class="text-left px-4 py-2 font-medium">规则内容</th>
                <th class="text-left px-4 py-2 font-medium">备注</th>
                <th class="text-right px-4 py-2 font-medium">已隐藏</th>
                <th class="text-center px-4 py-2 font-medium">状态</th>
                <th class="text-right px-4 py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {#each group.items as rule (rule.id)}
                <tr class="border-b border-stone-50 last:border-0 {rule.is_active ? '' : 'opacity-50'}">
                  <td class="px-4 py-2 font-mono text-stone-800 break-all">{rule.pattern}</td>
                  <td class="px-4 py-2 text-stone-500">{rule.note || '—'}</td>
                  <td class="px-4 py-2 text-right text-stone-600 tabular-nums">{rule.hit_count}</td>
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
        {/if}
      </div>
    {/each}
  {/if}
</div>
