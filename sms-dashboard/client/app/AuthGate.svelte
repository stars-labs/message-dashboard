<script lang="ts">
  import { auth } from '../lib/auth.js';

  interface Props {
    loading: boolean;
    authError: string | null;
    daemonLabel: string;
  }

  let { loading, authError, daemonLabel }: Props = $props();
</script>

{#if loading}
  <div class="min-h-screen flex items-center justify-center bg-[#F7F5F2]">
    <div class="flex gap-2">
      <span class="w-3 h-3 rounded-full bg-emerald-400 animate-pulse"></span>
      <span class="w-3 h-3 rounded-full bg-emerald-200 animate-pulse [animation-delay:.2s]"></span>
      <span class="w-3 h-3 rounded-full bg-emerald-100 animate-pulse [animation-delay:.4s]"></span>
    </div>
  </div>
{:else if authError}
  <!-- Identity service unreachable: a login button would bounce straight back, so offer a retry. -->
  <div class="min-h-screen flex items-center justify-center bg-[#F7F5F2]">
    <div class="w-full max-w-[460px] mx-4">
      <div class="bg-white border border-stone-200 rounded-2xl p-10 shadow-raised text-center">
        <h1 class="text-lg font-semibold text-stone-900 tracking-tight">无法连接服务器</h1>
        <p class="text-sm text-stone-500 mt-2 mb-6 leading-relaxed">
          没能确认登录状态，这通常是网络问题或服务端故障，不是你被登出了。<br />
          <span class="text-stone-400 text-xs font-mono">{authError}</span>
        </p>
        <button
          onclick={() => {
            location.reload();
          }}
          class="w-full px-6 py-3 bg-orange-500 hover:bg-orange-600 text-white font-medium rounded-xl
            transition-colors shadow-focus"
        >
          重试
        </button>
      </div>
    </div>
  </div>
{:else}
  <div class="min-h-screen flex items-center justify-center bg-[#F7F5F2]">
    <div class="w-full max-w-[460px] mx-4">
      <div class="bg-white border border-stone-200 rounded-2xl p-10 shadow-raised text-center">
        <div class="flex items-center justify-center gap-2.5 mb-5">
          <img src="/favicon.svg" alt="" class="w-[52px] h-[52px] rounded-xl" />
        </div>
        <h1 class="text-lg font-semibold text-stone-900 tracking-tight">验证码中心</h1>
        <p class="text-sm text-stone-500 mt-2 mb-6 leading-relaxed">
          需要公司邮箱和 sms 角色。<br />首次登录后默认为查看者。
        </p>
        <button
          onclick={() => {
            auth.login();
          }}
          class="w-full px-6 py-3 bg-orange-500 hover:bg-orange-600 text-white font-medium rounded-xl
            transition-colors shadow-focus"
        >
          使用 Auth0 登录
        </button>
        <p class="mt-5 text-[11px] font-mono text-stone-400">
          95 modems · 采集服务{daemonLabel}
        </p>
      </div>
    </div>
  </div>
{/if}
