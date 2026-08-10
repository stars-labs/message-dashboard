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

  async function load() {
    loading = true;
    error = null;
    try {
      const response = await api.get("/api/users");
      users = response.users || [];
      knownRoles = response.known_roles || [];
      adminRole = response.admin_role ?? null;
      viewerRole = response.viewer_role ?? null;
    } catch (e) {
      error = e?.message || "Failed to load users";
    } finally {
      loading = false;
    }
  }

  async function changeRole(user, role) {
    if (role === user.role) return;

    const verb = role === adminRole ? "提升为管理员" : "降级为查看者";
    if (!confirm(`确定要将 ${user.email || user.id} ${verb}吗？\n\n该用户的登录会话会立即失效，需要重新登录。`)) {
      return;
    }

    savingId = user.id;
    error = null;
    notice = null;

    try {
      const result = await api.put(`/api/users/${encodeURIComponent(user.id)}/role`, { role });
      notice = `${user.email || user.id} → ${role}（已注销 ${result.sessions_revoked ?? 0} 个会话）`;
      await load();
    } catch (e) {
      error = e?.message || "Failed to change role";
    } finally {
      savingId = null;
    }
  }

  load();
</script>

<div class="bg-white border border-stone-200 rounded-lg p-6">
  <div class="flex items-center justify-between mb-4">
    <div>
      <h2 class="text-xl font-bold text-stone-800">用户管理</h2>
      <p class="text-sm text-stone-500 mt-1">
        角色由 Auth0 管理。新用户首次登录后自动成为「查看者」。
      </p>
    </div>
    <button
      onclick={load}
      disabled={loading}
      class="px-3 py-1.5 text-sm rounded-lg border border-stone-200 text-stone-600 hover:bg-stone-50 disabled:opacity-50"
    >
      刷新
    </button>
  </div>

  {#if notice}
    <div class="mb-4 px-3 py-2 rounded-lg bg-emerald-50 border border-emerald-200 text-sm text-emerald-800">
      {notice}
    </div>
  {/if}

  {#if error}
    <div class="mb-4 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
      {error}
    </div>
  {/if}

  {#if loading}
    <p class="text-sm text-stone-500 py-8 text-center">加载中…</p>
  {:else if users.length === 0}
    <p class="text-sm text-stone-500 py-8 text-center">没有找到用户。</p>
  {:else}
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left text-stone-500 border-b border-stone-200">
            <th class="px-3 py-2 font-medium">邮箱</th>
            <th class="px-3 py-2 font-medium">姓名</th>
            <th class="px-3 py-2 font-medium">当前角色</th>
            <th class="px-3 py-2 font-medium">最近登录</th>
            <th class="px-3 py-2 font-medium text-right">操作</th>
          </tr>
        </thead>
        <tbody>
          {#each users as u (u.id)}
            <tr class="border-b border-stone-50 last:border-0">
              <td class="px-3 py-2 text-stone-800">{u.email || "—"}</td>
              <td class="px-3 py-2 text-stone-600">{u.name || "—"}</td>
              <td class="px-3 py-2">
                <span
                  class="px-2 py-0.5 rounded text-xs {u.role === adminRole
                    ? 'bg-orange-100 text-orange-700'
                    : u.role === viewerRole
                      ? 'bg-stone-100 text-stone-600'
                      : 'bg-red-100 text-red-700'}"
                >
                  {u.role ? roleLabel(u.role) : "无角色"}
                </span>
              </td>
              <td class="px-3 py-2 text-stone-500">
                {u.last_login ? new Date(u.last_login).toLocaleString() : "从未"}
              </td>
              <td class="px-3 py-2 text-right">
                {#if u.id === currentUserId}
                  <!-- The server refuses a self-role-change; do not offer it here. -->
                  <span class="text-xs text-stone-400">当前登录用户</span>
                {:else}
                  <div class="inline-flex gap-1">
                    {#each knownRoles as role}
                      <button
                        onclick={() => changeRole(u, role)}
                        disabled={savingId === u.id || u.role === role}
                        class="px-2 py-1 text-xs rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed {u.role ===
                        role
                          ? 'border-stone-200 bg-stone-50 text-stone-400'
                          : 'border-stone-300 text-stone-700 hover:bg-stone-100'}"
                      >
                        设为{roleLabel(role)}
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
  {/if}
</div>
