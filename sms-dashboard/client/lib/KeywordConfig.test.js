import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import KeywordConfig from './KeywordConfig.svelte';

const originalFetch = globalThis.fetch;
const originalConfirm = globalThis.confirm;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.confirm = originalConfirm;
});

function keyword() {
  return {
    id: 7,
    keyword: 'code',
    tag: 'OTP',
    color: '#3B82F6',
    priority: 0,
    case_sensitive: 0,
    whole_word: 0,
    is_active: 1,
    usage_count: 4,
  };
}

describe('KeywordConfig', () => {
  test('processes exactly one bounded history page per operator click', async () => {
    const requests = [];
    globalThis.confirm = () => true;
    globalThis.fetch = async (url, options = {}) => {
      requests.push({ url, options });
      if (options.method === 'POST') {
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
    };

    const view = render(KeywordConfig);
    await waitFor(() => expect(view.getAllByText('code').length).toBeGreaterThan(0));
    await fireEvent.click(view.getAllByRole('button', { name: '应用到历史' })[0]);
    await waitFor(() => expect(view.getByText(/累计检查 200 条/)).toBeTruthy());

    expect(requests.filter(({ options }) => options.method === 'POST')).toHaveLength(1);
    expect(view.getAllByRole('button', { name: '继续历史处理' }).length).toBeGreaterThan(0);
  });

  test('keeps matching identity read-only while editing metadata', async () => {
    globalThis.fetch = async () => Response.json({ keywords: [keyword()] });

    const view = render(KeywordConfig);
    await waitFor(() => expect(view.getAllByText('code').length).toBeGreaterThan(0));
    await fireEvent.click(view.getAllByRole('button', { name: '编辑关键词' })[0]);

    expect(view.getByLabelText('关键词').disabled).toBe(true);
    expect(view.getByRole('button', { name: '整词匹配' }).disabled).toBe(true);
    expect(view.getByRole('button', { name: '区分大小写' }).disabled).toBe(true);
    expect(view.getByLabelText('标签').disabled).toBe(false);
  });
});
