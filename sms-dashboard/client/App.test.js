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
  document.documentElement.classList.remove('is-ios', 'is-standalone');
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
    const selection = mobileNav.querySelector('[data-mobile-tab-selection]');
    expect(selection).toBeTruthy();
    expect(mobileNav.style.getPropertyValue('--mobile-tab-selection-width')).toBe('20%');
    expect(mobileNav.style.getPropertyValue('--mobile-tab-selection-x')).toBe('0%');
    for (const button of mobileNav.querySelectorAll('button')) {
      expect(button.classList.contains('min-h-[var(--mobile-tab-content-height)]')).toBe(true);
      expect(button.classList.contains('justify-start')).toBe(true);
      expect(button.classList.contains('justify-center')).toBe(false);
      expect(button.classList.contains('pt-[var(--mobile-tab-content-top)]')).toBe(true);
    }
    const balances = [...mobileNav.querySelectorAll('button')]
      .find((button) => button.textContent.includes('余额'));
    await fireEvent.click(balances);

    expect(view.queryByRole('region', { name: '短信详情' })).toBeNull();
    expect(window.location.hash).toBe('#balances');
    expect(mobileNav.style.getPropertyValue('--mobile-tab-selection-x')).toBe(
      'calc(200% + 16px)',
    );
  });

  test('the shared mobile tab content height is 56px with a 6px top inset', () => {
    const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');
    expect(css).toContain('--mobile-tab-content-height: 56px;');
    expect(css).toContain('--mobile-tab-content-top: 6px;');
    expect(css).toContain(
      '--mobile-tab-bar-height: calc(var(--mobile-tab-content-height) + 1px + var(--mobile-tab-safe-area));',
    );
  });

  test('only standalone apps add the 20px bottom safe-area floor', () => {
    const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

    expect(css).toContain(
      '--mobile-tab-safe-area: env(safe-area-inset-bottom, 0px);',
    );
    expect(css).toContain('html.is-standalone {');
    expect(css).toContain(
      '--mobile-tab-safe-area: max(20px, env(safe-area-inset-bottom, 0px));',
    );
    expect(html).toContain("'standalone' in navigator");
    expect(html).toContain("classList.add('is-standalone')");
  });

  test('the liquid selection is scoped to iOS standalone mode and reduced motion', () => {
    const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');

    expect(css).toContain('html.is-ios.is-standalone .mobile-tab-bar');
    expect(css).toContain('html.is-ios.is-standalone .mobile-tab-selection');
    expect(css).toContain('backdrop-filter: blur(22px) saturate(165%);');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  test('the floating tab pill follows a touch pointer and navigates on release', async () => {
    document.documentElement.classList.add('is-ios', 'is-standalone');
    auth.baseUrl = '';
    globalThis.fetch = async (url) => responseFor(url);
    const view = render(App);
    await waitFor(() => expect(view.container.querySelector('[data-message-row]')).toBeTruthy());

    const mobileNav = view.container.querySelector('.mobile-tab-bar');
    mobileNav.getBoundingClientRect = () => ({ left: 0, width: 500 });
    mobileNav.setPointerCapture = () => {};
    mobileNav.releasePointerCapture = () => {};

    await fireEvent.pointerDown(mobileNav, {
      pointerId: 1,
      pointerType: 'touch',
      button: 0,
      clientX: 50,
    });
    await fireEvent.pointerMove(mobileNav, {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 250,
    });

    expect(window.location.hash).toBe('');
    expect(mobileNav.dataset.mobileTabDragging).toBe('true');
    expect(mobileNav.style.getPropertyValue('--mobile-tab-selection-x')).toBe('200px');

    await fireEvent.pointerUp(mobileNav, {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 250,
    });

    expect(window.location.hash).toBe('#balances');
    expect(mobileNav.dataset.mobileTabDragging).toBe('false');
  });

  test('the full glass tab bar is floating and suppresses native text selection', () => {
    const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');

    expect(css).toContain('bottom: var(--mobile-tab-safe-area);');
    expect(css).toContain('left: 10px;');
    expect(css).toContain('right: 10px;');
    expect(css).toContain('border-radius: 28px;');
    expect(css).toContain('-webkit-user-select: none;');
    expect(css).toContain('-webkit-touch-callout: none;');
  });
});
