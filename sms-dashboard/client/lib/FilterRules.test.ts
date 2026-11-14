import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { FilterRule } from '../../shared/api/filters.js';
import { auth } from './auth.js';
import FilterRules from './FilterRules.svelte';

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

function rule(overrides: Partial<FilterRule> = {}): FilterRule {
  return {
    id: 1,
    rule_type: 'sender',
    pattern: '10655446',
    note: null,
    is_active: 1,
    created_by: null,
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

describe('FilterRules', () => {
  test('does not render an expensive historical hit count', async () => {
    stubFetch(() =>
      Response.json({ filters: [rule({ note: 'China Unicom marketing' })], pending: 0 }),
    );

    const view = render(FilterRules);
    await waitFor(() => {
      expect(view.getAllByText('10655446').length).toBeGreaterThan(0);
    });

    expect(view.queryByText('已隐藏')).toBeNull();
    expect(view.queryByRole('columnheader', { name: '已隐藏' })).toBeNull();
  });

  test('does not expose the old automatic pending-message sweep', async () => {
    stubFetch(() => Response.json({ filters: [rule()], pending: 5000 }));

    const view = render(FilterRules);
    await waitFor(() => {
      expect(view.getAllByText('10655446').length).toBeGreaterThan(0);
    });

    expect(view.queryByRole('button', { name: '继续处理' })).toBeNull();
    expect(view.queryByText('待判定')).toBeNull();
    expect(view.getAllByRole('button', { name: '应用到历史' }).length).toBeGreaterThan(0);
  });

  test('processes exactly one bounded history page per operator click', async () => {
    const methods: (string | undefined)[] = [];
    globalThis.confirm = () => true;
    stubFetch((_input, init) => {
      methods.push(init?.method);
      if (init?.method === 'POST') {
        return Response.json({
          mode: 'apply',
          processed: 200,
          changed: 12,
          has_more: true,
          next_cursor: { created_at: '2026-09-02 00:00:00', id: 'message-200' },
        });
      }
      return Response.json({ filters: [rule()] });
    });

    const view = render(FilterRules);
    await waitFor(() => {
      expect(view.getAllByText('10655446').length).toBeGreaterThan(0);
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
});
