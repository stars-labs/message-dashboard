import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { KeywordWithUsage } from '../../shared/api/keywords.js';
import { auth } from './auth.js';
import KeywordConfig from './KeywordConfig.svelte';

const originalBaseUrl = auth.baseUrl;
const originalConfirm = globalThis.confirm;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;

afterEach(() => {
  cleanup();
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
  auth.baseUrl = originalBaseUrl;
  globalThis.confirm = originalConfirm;
});

function stubFetch(handler: (input: string | URL | Request, init?: RequestInit) => Response): void {
  auth.baseUrl = 'https://example.com';
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      (input: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(input, init)),
      { preconnect: () => undefined },
    ),
  );
}

function keyword(overrides: Partial<KeywordWithUsage> = {}): KeywordWithUsage {
  return {
    id: 7,
    keyword: 'code',
    tag: 'OTP',
    color: '#3B82F6',
    priority: 0,
    case_sensitive: 0,
    whole_word: 0,
    is_active: 1,
    created_by: null,
    created_at: null,
    updated_at: null,
    usage_count: 4,
    ...overrides,
  };
}

function disabledOf(element: HTMLElement): boolean {
  if (element instanceof HTMLInputElement || element instanceof HTMLButtonElement) {
    return element.disabled;
  }
  throw new Error('element has no disabled state');
}

describe('KeywordConfig', () => {
  test('processes exactly one bounded history page per operator click', async () => {
    const methods: (string | undefined)[] = [];
    globalThis.confirm = () => true;
    stubFetch((_input, init) => {
      methods.push(init?.method);
      if (init?.method === 'POST') {
        return Response.json({
          processed: 200,
          eligible: 190,
          matched_messages: 12,
          inserted: 12,
          has_more: true,
          next_cursor: { created_at: '2026-09-02 00:00:00', id: 'm-200' },
        });
      }
      return Response.json({ keywords: [keyword()] });
    });

    const view = render(KeywordConfig);
    await waitFor(() => {
      expect(view.getAllByText('code').length).toBeGreaterThan(0);
    });
    const [apply] = view.getAllByRole('button', { name: '应用到历史' });
    if (!apply) throw new Error('no apply button rendered');
    await fireEvent.click(apply);
    await waitFor(() => {
      expect(view.getByText(/累计检查 200 条/)).toBeTruthy();
    });

    expect(methods.filter((method) => method === 'POST')).toHaveLength(1);
    expect(view.getAllByRole('button', { name: '继续历史处理' }).length).toBeGreaterThan(0);
  });

  test('never renders a keyword or its colour as markup', async () => {
    const hostile = keyword({
      keyword: '<img src=x onerror=alert(1)>',
      color: 'red" onmouseover="alert(1)',
    });
    stubFetch(() => Response.json({ keywords: [hostile] }));

    const view = render(KeywordConfig);
    await waitFor(() => {
      expect(view.getAllByText(/验证码|您的/).length).toBeGreaterThan(0);
    });
    const [edit] = view.getAllByRole('button', { name: '编辑关键词' });
    if (!edit) throw new Error('no edit button rendered');
    await fireEvent.click(edit);

    expect(view.container.querySelector('img')).toBeNull();
    expect(view.container.querySelector('[onmouseover]')).toBeNull();
    expect(document.body.querySelector('img')).toBeNull();
  });

  test('keeps matching identity read-only while editing metadata', async () => {
    stubFetch(() => Response.json({ keywords: [keyword()] }));

    const view = render(KeywordConfig);
    await waitFor(() => {
      expect(view.getAllByText('code').length).toBeGreaterThan(0);
    });
    const [edit] = view.getAllByRole('button', { name: '编辑关键词' });
    if (!edit) throw new Error('no edit button rendered');
    await fireEvent.click(edit);

    expect(disabledOf(view.getByLabelText('关键词'))).toBe(true);
    expect(disabledOf(view.getByRole('button', { name: '整词匹配' }))).toBe(true);
    expect(disabledOf(view.getByRole('button', { name: '区分大小写' }))).toBe(true);
    expect(disabledOf(view.getByLabelText('标签'))).toBe(false);
  });
});
