import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';
import FilterRules from './FilterRules.svelte';

const originalFetch = globalThis.fetch;
const originalConfirm = globalThis.confirm;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.confirm = originalConfirm;
});

describe('FilterRules', () => {
  test('does not render an expensive historical hit count', async () => {
    globalThis.fetch = async () => Response.json({
      filters: [{
        id: 1,
        rule_type: 'sender',
        pattern: '10655446',
        note: 'China Unicom marketing',
        is_active: 1,
      }],
      pending: 0,
    });

    const view = render(FilterRules);
    await waitFor(() => expect(view.getAllByText('10655446').length).toBeGreaterThan(0));

    expect(view.queryByText('已隐藏')).toBeNull();
    expect(view.queryByRole('columnheader', { name: '已隐藏' })).toBeNull();
  });

  test('does not expose the old automatic pending-message sweep', async () => {
    globalThis.fetch = async () => Response.json({
      filters: [{
        id: 1,
        rule_type: 'sender',
        pattern: '10655446',
        note: null,
        is_active: 1,
      }],
      pending: 5000,
    });

    const view = render(FilterRules);
    await waitFor(() => expect(view.getAllByText('10655446').length).toBeGreaterThan(0));

    expect(view.queryByRole('button', { name: '继续处理' })).toBeNull();
    expect(view.queryByText('待判定')).toBeNull();
    expect(view.getAllByRole('button', { name: '应用到历史' }).length).toBeGreaterThan(0);
  });

  test('processes exactly one bounded history page per operator click', async () => {
    const requests = [];
    globalThis.confirm = () => true;
    globalThis.fetch = async (url, options = {}) => {
      requests.push({ url, options });
      if (options.method === 'POST') {
        return Response.json({
          mode: 'apply',
          processed: 200,
          changed: 12,
          has_more: true,
          next_cursor: { created_at: '2026-09-02 00:00:00', id: 'message-200' },
        });
      }
      return Response.json({
        filters: [{
          id: 1,
          rule_type: 'sender',
          pattern: '10655446',
          note: null,
          is_active: 1,
        }],
      });
    };

    const view = render(FilterRules);
    await waitFor(() => expect(view.getAllByText('10655446').length).toBeGreaterThan(0));
    await fireEvent.click(view.getAllByRole('button', { name: '应用到历史' })[0]);
    await waitFor(() => expect(view.getByText(/累计检查 200 条/)).toBeTruthy());

    expect(requests.filter(({ options }) => options.method === 'POST')).toHaveLength(1);
    expect(view.getAllByRole('button', { name: '继续历史处理' }).length).toBeGreaterThan(0);
  });
});
