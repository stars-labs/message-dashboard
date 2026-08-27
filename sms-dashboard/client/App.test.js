import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import App from './App.svelte';
import { auth } from './lib/auth.js';

const originalFetch = globalThis.fetch;
const originalBaseUrl = auth.baseUrl;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  auth.user = null;
  auth.baseUrl = originalBaseUrl;
  window.location.hash = '';
});

function responseFor(url) {
  const path = new URL(String(url), 'http://localhost').pathname;
  if (path === '/api/auth/me') {
    return Response.json({
      success: true,
      user: {
        id: 'test-user',
        permissions: ['messages.read', 'messages.send', 'phones.write'],
      },
    });
  }
  if (path === '/api/phones') {
    return Response.json({ success: true, data: [{
      iccid: '8986000000000000001',
      sim_index: 1,
      number: '+8613800000000',
      country: 'CN',
      status: 'active',
      updated_at: new Date().toISOString(),
    }] });
  }
  if (path === '/api/messages') {
    return Response.json({ success: true, data: [{
      id: 'message-1',
      type: 'received',
      content: '用于测试导航关闭详情的短信',
      phone_number: '10086',
      phone_iccid: '8986000000000000001',
      phone_sim_index: 1,
      timestamp: '2026-08-26T12:00:00.000Z',
    }], pagination: { total: 1 } });
  }
  if (path === '/api/stats') {
    return Response.json({ success: true, data: {} });
  }
  if (path === '/api/balance-checks') {
    return Response.json({ success: true, data: [] });
  }
  if (path === '/api/daemon/status') {
    return Response.json({ status: 'healthy' });
  }
  if (path === '/api/keywords') {
    return Response.json({ keywords: [] });
  }
  return Response.json({ success: true, data: [] });
}

describe('mobile detail navigation', () => {
  test('bottom navigation closes an open message detail before changing views', async () => {
    auth.baseUrl = '';
    globalThis.fetch = async (url) => responseFor(url);
    const view = render(App);

    const messageRow = await waitFor(() => {
      const row = view.container.querySelector('[data-message-row]');
      expect(row).toBeTruthy();
      return row;
    });
    await fireEvent.click(messageRow);
    expect(view.getByRole('region', { name: '短信详情' })).toBeTruthy();

    const mobileNav = view.container.querySelector('nav.lg\\:hidden');
    for (const button of mobileNav.querySelectorAll('button')) {
      expect(button.classList.contains('min-h-[var(--mobile-tab-content-height)]')).toBe(true);
      expect(button.classList.contains('pt-[6px]')).toBe(true);
    }
    const balances = [...mobileNav.querySelectorAll('button')]
      .find((button) => button.textContent.includes('余额'));
    await fireEvent.click(balances);

    expect(view.queryByRole('region', { name: '短信详情' })).toBeNull();
    expect(window.location.hash).toBe('#balances');
  });

  test('the shared mobile tab content height is 58px', () => {
    const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');
    expect(css).toContain('--mobile-tab-content-height: 58px;');
    expect(css).toContain(
      '--mobile-tab-bar-height: calc(var(--mobile-tab-content-height) + 1px + var(--mobile-tab-safe-area));',
    );
  });
});
