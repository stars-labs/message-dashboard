import { api } from '../lib/api.js';
import { confirmAction } from '../lib/confirm.svelte.js';
import { resetDashboardCache, resetServiceWorker } from '../lib/sw-reset.js';
import type { ToastType } from './toasts.svelte.js';

export async function resetLocalCache(showToast: (message: string, type: ToastType) => void) {
  const confirmed = await confirmAction({
    title: '清除本地缓存',
    message:
      '会删除这台设备上缓存的短信副本和离线资源，然后重新加载页面。\n\n' +
      '服务器上的短信不受影响，重新加载后会重新拉取。',
    confirmLabel: '清除并重载',
    danger: true,
  });
  if (!confirmed) return;
  const result = await resetDashboardCache({
    clearMessageCache: () => api.cache.clear(),
    resetOfflineCache: () => resetServiceWorker(),
  });
  if (!result.ok) {
    showToast('部分缓存未能清除，请重试', 'error');
    return;
  }
  window.location.reload();
}
