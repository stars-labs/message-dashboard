<script>
  // Admin-only user/role administration. Reached only when the caller holds
  // `users.read`; the server enforces that independently on both endpoints.
  import { api } from "./api.js";

  // The signed-in admin's own id, so we can disable their own row — the server refuses
  // a self-role-change (see server/handlers/users.js) and the UI should not offer it.
  let { currentUserId = null } = $props();

  let users = $state([]);
  // Role NAMES are deployment config (currently sms-admin / sms-viewer), so nothing here
  // may compare against a hardcoded "admin". The server tells us which name is which.
  let knownRoles = $state([]);
  let adminRole = $state(null);
  let viewerRole = $state(null);
  let loading = $state(true);
  let error = $state(null);
  let savingId = $state(null);
  let notice = $state(null);

  const roleLabel = (role) =>
    role === adminRole ? "管理员" : role === viewerRole ? "查看者" : role;

  // Sort: roleless users first (they need action), then alphabetical by email.
  let sortedUsers = $derived(
    [...users].sort((a, b) => {
      const aHasRole = !!(a.role);
      const bHasRole = !!(b.role);
      if (aHasRole !== bHasRole) return aHasRole ? 1 : -1; // roleless first
      return (a.email || '').localeCompare(b.email || '');
    })
  );

  async function load() {
    loading = true; error = null;
    try {
      const r = await api.get("/api/users");
      users = r.users || [];
      knownRoles = r.known_roles || [];
      adminRole = r.admin_role ?? null;
      viewerRole = r.viewer_role ?? null;
    } catch (e) {
      error = e?.message || "加载用户失败";
    } finally {
      loading = false;
    }
  }

  async function changeRole(user, role) {
    if (role === user.role) return;
    const verb = role === adminRole ? "提升为管理员" : "降级为查看者";
    if (!confirm(`确定要将 ${user.email || user.id} ${verb}吗？\n\n⚠ 该操作会立即注销该用户的所有会话，需要重新登录。`)) return;

    savingId = user.id; error = null; notice = null;
    try {
      const result = await api.put(`/api/users/${encodeURIComponent(user.id)}/role`, { role });
      notice = `${user.email || user.id} → ${roleLabel(role)}（已注销 ${result.sessions_revoked ?? 0} 个会话）`;
      await load();
    } catch (e) {
      error = e?.message || "操作失败";
    } finally {
      savingId = null;
    }
  }

  // Outcome label: says what clicking does, not what the role is.
  function actionLabel(user, role) {
    if (role === adminRole) return '提升为管理员';
    if (role === viewerRole) return user.role === adminRole ? '降级为查看者' : '设为查看者';
    return `设为${roleLabel(role)}`;
  }

  load();
</script>

<div class="bg-white border-0 rounded-none p-0 lg:border lg:border-stone-200 lg:rounded-xl lg:p-6">

  <!-- Warning hoisted out of the confirm dialog — users should know the
       consequence before they click, not at the moment of confirmation. -->
  <div class="flex items-start gap-3 px-4 py-3 bg-amber-50 border-y border-amber-200
    lg:mb-5 lg:border lg:rounded-xl text-sm text-amber-800">
    <svg class="w-4 h-4 shrink-0 mt-0.5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
        d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
    </svg>
    <span><strong>改角色会立即注销该用户的所有会话。</strong>他们需要重新登录才能继续操作。</span>
  </div>

  <div class="flex items-start justify-between gap-3 px-4 py-4 border-b border-stone-200 lg:p-0 lg:mb-4 lg:border-0">
    <div class="min-w-0">
      <h2 class="text-lg sm:text-xl font-bold text-stone-800">用户管理</h2>
      <p class="text-sm text-stone-500 mt-0.5">
        角色由 Auth0 管理。新用户首次登录后自动成为「查看者」。
      </p>
    </div>
    <button onclick={load} disabled={loading}
      class="shrink-0 min-h-9 px-3 py-1.5 text-sm rounded-lg border border-stone-200 text-stone-600 hover:bg-stone-50 disabled:opacity-50">
      刷新
    </button>
  </div>

  {#if notice}
    <div class="mb-4 px-3 py-2 rounded-lg bg-emerald-50 border border-emerald-200 text-sm text-emerald-800">{notice}</div>
  {/if}
  {#if error}
    <div class="mb-4 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">{error}</div>
  {/if}

  {#if loading}
    <p class="text-sm text-stone-400 py-8 text-center">加载中…</p>
  {:else if users.length === 0}
    <p class="text-sm text-stone-400 py-8 text-center">没有找到用户。</p>
  {:else}
    <div class="hidden sm:block overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left text-stone-400 border-b border-stone-200 text-[11px] font-semibold uppercase tracking-widest">
            <th class="px-3 py-2">用户</th>
            <th class="px-3 py-2">角色</th>
            <th class="px-3 py-2">最近登录</th>
            <th class="px-3 py-2 text-right">操作</th>
          </tr>
        </thead>
        <tbody>
          {#each sortedUsers as u (u.id)}
            {@const hasNoRole = !u.role}
            <tr class="border-b border-stone-50 last:border-0 {hasNoRole ? 'bg-red-50' : ''}">
              <!-- 用户 -->
              <td class="px-3 py-3">
                <div class="flex items-center gap-2.5">
                  <!-- Avatar: ? for roleless, initials otherwise -->
                  <div class="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-sm font-bold
                    {hasNoRole ? 'bg-red-100 text-red-600' : 'bg-stone-100 text-stone-600'}">
                    {hasNoRole ? '?' : (u.name || u.email || '?')[0].toUpperCase()}
                  </div>
                  <div>
                    <div class="font-medium text-stone-800">{u.name || '—'}</div>
                    <div class="text-xs font-mono text-stone-400">{u.email || '—'}</div>
                  </div>
                </div>
              </td>
              <!-- 角色 -->
              <td class="px-3 py-3">
                <span class="px-2 py-0.5 rounded text-xs font-medium
                  {u.role === adminRole ? 'bg-orange-100 text-orange-700'
                  : u.role === viewerRole ? 'bg-stone-100 text-stone-600'
                  : 'bg-red-100 text-red-700'}">
                  {u.role ? roleLabel(u.role) : '无角色'}
                </span>
              </td>
              <!-- 最近登录 -->
              <td class="px-3 py-3 text-stone-500 text-xs">
                {u.last_login ? new Date(u.last_login).toLocaleString('zh-CN') : '从未'}
              </td>
              <!-- 操作 — button name states the outcome, not the current state -->
              <td class="px-3 py-3 text-right">
                {#if u.id === currentUserId}
                  <span class="text-xs text-stone-400">当前登录用户</span>
                {:else}
                  <!-- Only show the button for the role the user doesn't currently have.
                       Showing both (one always disabled) wastes space. -->
                  <div class="inline-flex flex-col gap-1 items-end">
                    {#each knownRoles.filter(r => r !== u.role) as role}
                      <button
                        onclick={() => changeRole(u, role)}
                        disabled={savingId === u.id}
                        class="px-2.5 py-1 text-xs rounded-lg border transition-colors disabled:opacity-40
                          {role === adminRole
                            ? 'border-orange-200 text-orange-700 hover:bg-orange-50'
                            : 'border-stone-300 text-stone-700 hover:bg-stone-100'}">
                        {actionLabel(u, role)}
                      </button>
                    {/each}
                  </div>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <div class="sm:hidden divide-y divide-stone-100 border-b border-stone-200">
      {#each sortedUsers as u (u.id)}
        {@const hasNoRole = !u.role}
        <div class="px-4 py-4 {hasNoRole ? 'bg-red-50' : 'bg-white'}">
          <div class="flex items-start gap-3">
            <div class="w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-sm font-bold
              {hasNoRole ? 'bg-red-100 text-red-600' : 'bg-stone-100 text-stone-600'}">
              {hasNoRole ? '?' : (u.name || u.email || '?')[0].toUpperCase()}
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <p class="font-medium text-stone-800 truncate">{u.name || '—'}</p>
                <span class="shrink-0 px-2 py-0.5 rounded text-[11px] font-medium
                  {u.role === adminRole ? 'bg-orange-100 text-orange-700'
                  : u.role === viewerRole ? 'bg-stone-100 text-stone-600'
                  : 'bg-red-100 text-red-700'}">
                  {u.role ? roleLabel(u.role) : '无角色'}
                </span>
              </div>
              <p class="text-xs font-mono text-stone-400 truncate mt-0.5">{u.email || '—'}</p>
              <p class="text-[11px] text-stone-400 mt-1">最近登录：{u.last_login ? new Date(u.last_login).toLocaleString('zh-CN') : '从未'}</p>
            </div>
          </div>
          <div class="mt-3 flex justify-end">
            {#if u.id === currentUserId}
              <span class="text-xs text-stone-400 py-2">当前登录用户</span>
            {:else}
              <div class="flex flex-wrap justify-end gap-2">
                {#each knownRoles.filter(r => r !== u.role) as role}
                  <button
                    onclick={() => changeRole(u, role)}
                    disabled={savingId === u.id}
                    class="min-h-9 px-3 text-xs rounded-lg border transition-colors disabled:opacity-40
                      {role === adminRole
                        ? 'border-orange-200 text-orange-700 hover:bg-orange-50'
                        : 'border-stone-300 text-stone-700 hover:bg-stone-100'}">
                    {actionLabel(u, role)}
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
