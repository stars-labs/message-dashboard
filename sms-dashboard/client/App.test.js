import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';
import valueParser from 'postcss-value-parser';
import App from './App.svelte';
import { auth } from './lib/auth.js';

/**
 * The parsed app.css. Tests read declarations by selector and property and
 * compare them in a canonical form, so layout and quote style cannot change
 * what they assert.
 */
const stylesheet = postcss.parse(readFileSync(new URL('./app.css', import.meta.url), 'utf8'));

function cssValue(text) {
  const parsed = valueParser(text);
  parsed.walk((node) => {
    if (node.type === 'function') {
      node.before = '';
      node.after = '';
    }
    if (node.type === 'div') {
      node.before = node.value === ',' ? '' : ' ';
      node.after = ' ';
    }
    if (node.type === 'space') node.value = ' ';
    if (node.type === 'string') node.quote = '"';
  });
  return parsed.toString().trim();
}

const canonicalSelector = selectorParser((root) => {
  root.walkAttributes((attribute) => {
    if (attribute.value !== undefined) attribute.quoteMark = '"';
  });
});

function cssSelector(text) {
  return canonicalSelector.processSync(text, { lossless: false });
}

function declarations(property) {
  const found = [];
  stylesheet.walkDecls(property, (decl) => {
    found.push({ selector: cssSelector(decl.parent.selector), value: cssValue(decl.value) });
  });
  return found;
}

function declarationValue(selector, property) {
  const match = declarations(property).find((decl) => decl.selector === cssSelector(selector));
  if (!match) throw new Error(`${selector} does not declare ${property}`);
  return match.value;
}

function declaresUnder(property, selector) {
  return declarations(property).some((decl) => decl.selector === cssSelector(selector));
}

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
    return Response.json({
      success: true,
      data: [
        {
          iccid: '8986000000000000001',
          sim_index: 1,
          number: '+8613800000000',
          country: 'CN',
          status: 'active',
          updated_at: new Date().toISOString(),
        },
      ],
    });
  }
  if (path === '/api/messages') {
    return Response.json({
      success: true,
      data: [
        {
          id: 'message-1',
          type: 'received',
          content: '用于测试导航关闭详情的短信',
          phone_number: '10086',
          phone_iccid: '8986000000000000001',
          phone_sim_index: 1,
          timestamp: '2026-08-26T12:00:00.000Z',
        },
      ],
      pagination: { total: 1 },
    });
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
  test('recurring dashboard refreshes avoid full-table stats and balance history reads', () => {
    const source = readFileSync(new URL('./App.svelte', import.meta.url), 'utf8');
    const pollingStart = source.indexOf('async function loadMessagesForPhone');
    const pollingEnd = source.indexOf('async function refreshBalanceChecksForView');
    const messagePolling = source.slice(pollingStart, pollingEnd);
    const balancePolling = source.slice(
      pollingEnd,
      source.indexOf('async function loadOlderMessages'),
    );

    expect(source).not.toContain('/api/stats');
    expect(source).not.toContain('/api/balance-checks?limit=500');
    expect(messagePolling).not.toContain('getBalanceChecks');
    expect(balancePolling).not.toContain('limit: 500');
  });

  test('uses cached incremental loading and only polls a visible dashboard once per minute', () => {
    const source = readFileSync(new URL('./App.svelte', import.meta.url), 'utf8');
    const loadData = source.slice(
      source.indexOf('async function loadData()'),
      source.indexOf('onMount(async () =>'),
    );
    const polling = source.slice(
      source.indexOf('function startPolling()'),
      source.indexOf('function stopPolling()'),
    );

    expect(source).toContain('const POLL_INTERVAL_MS = 60000');
    expect(source).toContain('const DAEMON_POLL_INTERVAL_MS = 300000');
    expect(loadData).toContain('api.getMessages({ limit: MESSAGE_PAGE_SIZE })');
    expect(loadData).not.toContain('authenticatedFetch(`/api/messages');
    expect(polling).toContain("document.visibilityState !== 'visible'");
    expect(polling).toContain('now - lastDaemonPollAt >= DAEMON_POLL_INTERVAL_MS');
    expect(polling).not.toContain('refreshBalanceChecksForView');
  });

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
      expect(button.classList.contains('justify-center')).toBe(true);
      expect(button.classList.contains('justify-start')).toBe(false);
      expect([...button.classList].some((className) => className.startsWith('pt-'))).toBe(false);
      expect([...button.classList].some((className) => className.startsWith('pb-'))).toBe(false);
    }
    const balances = [...mobileNav.querySelectorAll('button')].find((button) =>
      button.textContent.includes('余额'),
    );
    await fireEvent.click(balances);

    expect(view.queryByRole('region', { name: '短信详情' })).toBeNull();
    expect(window.location.hash).toBe('#balances');
    expect(mobileNav.style.getPropertyValue('--mobile-tab-selection-x')).toBe('calc(200% + 16px)');
  });

  test('the shared mobile tab content height is 60px without a vertical offset', () => {
    expect(declarationValue(':root', '--mobile-tab-content-height')).toBe('60px');
    expect(declarations('--mobile-tab-content-top')).toEqual([]);
    expect(declarationValue(':root', '--mobile-tab-bar-height')).toBe(
      'calc(var(--mobile-tab-content-height) + 1px + var(--mobile-tab-safe-area))',
    );
  });

  test('only standalone apps add the 20px bottom safe-area floor', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

    expect(declarationValue(':root', '--mobile-tab-safe-area')).toBe(
      'env(safe-area-inset-bottom, 0px)',
    );
    expect(declarationValue('html.is-standalone', '--mobile-tab-safe-area')).toBe(
      'max(20px, env(safe-area-inset-bottom, 0px))',
    );
    expect(html).toContain("'standalone' in navigator");
    expect(html).toContain("classList.add('is-standalone')");
  });

  test('the liquid selection is scoped to iOS standalone mode and reduced motion', () => {
    expect(declaresUnder('height', 'html.is-ios.is-standalone .mobile-tab-bar')).toBe(true);
    expect(declaresUnder('height', 'html.is-ios.is-standalone .mobile-tab-selection')).toBe(true);
    expect(declarationValue('html.is-ios.is-standalone .mobile-tab-bar', 'backdrop-filter')).toBe(
      'blur(22px) saturate(165%)',
    );

    const mediaQueries = [];
    stylesheet.walkAtRules('media', (rule) => mediaQueries.push(rule.params));
    expect(mediaQueries).toContain('(prefers-reduced-motion: reduce)');
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
      clientX: 280,
    });

    expect(window.location.hash).toBe('');
    expect(mobileNav.dataset.mobileTabDragging).toBe('true');
    expect(mobileNav.style.getPropertyValue('--mobile-tab-selection-x')).toBe('230px');
    expect(mobileNav.style.getPropertyValue('--mobile-tab-glow-x')).toBe('280px');
    expect(mobileNav.style.getPropertyValue('--mobile-tab-icon-shift-x')).toBe('1.2px');
    expect(mobileNav.querySelector('[data-mobile-tab-active="true"]')?.textContent).toContain(
      '余额',
    );

    await fireEvent.pointerUp(mobileNav, {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 280,
    });

    expect(window.location.hash).toBe('#balances');
    expect(mobileNav.dataset.mobileTabDragging).toBe('false');
    expect(mobileNav.style.getPropertyValue('--mobile-tab-glow-x')).toBe('50%');
    expect(mobileNav.style.getPropertyValue('--mobile-tab-icon-shift-x')).toBe('0px');
  });

  test('the full glass tab bar is floating and suppresses native text selection', () => {
    const bar = 'html.is-ios.is-standalone .mobile-tab-bar';
    expect(declarationValue(bar, 'bottom')).toBe('var(--mobile-tab-safe-area)');
    expect(declarationValue(bar, 'left')).toBe('10px');
    expect(declarationValue(bar, 'right')).toBe('10px');
    expect(declarationValue(bar, 'border-radius')).toBe('30px');
    expect(declarationValue(bar, 'background')).toBe('rgba(245, 245, 244, 0.54)');
    expect(declarationValue(`${bar}::before`, 'background')).toContain(
      'radial-gradient(circle at var(--mobile-tab-glow-x) 12%',
    );

    const selection = 'html.is-ios.is-standalone .mobile-tab-selection';
    expect(declarationValue(selection, 'border-radius')).toBe('26px');
    expect(declarationValue(selection, 'transform')).toContain(
      'scaleX(var(--mobile-tab-selection-scale-x, 1))',
    );
    expect(declarationValue(selection, 'transform')).toContain(
      'scaleY(var(--mobile-tab-selection-scale-y, 1))',
    );

    expect(
      declarations('transform').some((decl) =>
        decl.selector.includes(
          cssSelector('.mobile-tab-button[data-mobile-tab-active="true"] > svg'),
        ),
      ),
    ).toBe(true);

    const bar1 = '.mobile-tab-bar, .mobile-tab-bar *';
    expect(declarationValue(bar1, '-webkit-user-select')).toBe('none');
    expect(declarationValue(bar1, '-webkit-touch-callout')).toBe('none');
  });
});
