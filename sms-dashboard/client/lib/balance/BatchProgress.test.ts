import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { BalanceBatch } from '../../../shared/api/balance-batches.js';
import { auth } from '../auth.js';
import BatchProgress from './BatchProgress.svelte';

const originalBaseUrl = auth.baseUrl;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;

afterEach(() => {
  cleanup();
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
  auth.baseUrl = originalBaseUrl;
});

function d1Time(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');
}

function batch(overrides: Partial<BalanceBatch> = {}): BalanceBatch {
  return {
    id: 'batch-1',
    requested_by_subject: 'auth0|operator',
    created_at: d1Time(-60_000),
    cancelled_at: null,
    total: 30,
    parsed: 10,
    failed: 2,
    cancelled: 0,
    in_progress: 18,
    cancellable: 15,
    ...overrides,
  };
}

function serve(initial: BalanceBatch[]) {
  const calls: string[] = [];
  let batches = initial;
  auth.baseUrl = 'https://example.com';
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        calls.push(`${request.method} ${url.pathname}`);
        if (url.pathname === '/api/balance-batches') {
          return Promise.resolve(Response.json({ success: true, batches }));
        }
        if (url.pathname === '/api/balance-batches/batch-1/cancel') {
          batches = batches.map((row) =>
            row.id === 'batch-1'
              ? { ...row, cancelled: 15, in_progress: 3, cancellable: 0, cancelled_at: d1Time(0) }
              : row,
          );
          const [cancelled] = batches;
          return Promise.resolve(Response.json({ success: true, cancelled: 15, batch: cancelled }));
        }
        return Promise.reject(new Error(`Unexpected request: ${url.href}`));
      },
      { preconnect: () => undefined },
    ),
  );
  return calls;
}

describe('batch progress', () => {
  test('shows how far an unfinished batch has got', async () => {
    serve([batch()]);
    const view = render(BatchProgress, { canCancel: true, onCancelled: () => undefined });

    const region = await view.findByRole('region', { name: '批量查询进度' });
    const text = region.textContent.replaceAll(/\s+/g, ' ');
    expect(text).toContain('完成 12/30');
    expect(text).toContain('成功 10');
    expect(text).toContain('失败 2');
    expect(view.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('12');
    expect(view.getByRole('button', { name: '取消未开始的 15 张' })).toBeTruthy();
  });

  test('leaves out a batch that finished long ago', async () => {
    const calls = serve([
      batch({
        id: 'old',
        created_at: d1Time(-2 * 3_600_000),
        parsed: 30,
        failed: 0,
        in_progress: 0,
        cancellable: 0,
      }),
    ]);
    const view = render(BatchProgress, { canCancel: true, onCancelled: () => undefined });

    await waitFor(() => {
      expect(calls).toContain('GET /api/balance-batches');
    });
    expect(view.queryByRole('region', { name: '批量查询进度' })).toBeNull();
  });

  test('cancels the queries not yet started, after confirming', async () => {
    const calls = serve([batch()]);
    const confirmSpy = spyOn(window, 'confirm').mockReturnValue(true);
    let cancelledCalls = 0;
    const view = render(BatchProgress, {
      canCancel: true,
      onCancelled: () => {
        cancelledCalls += 1;
      },
    });

    await fireEvent.click(await view.findByRole('button', { name: '取消未开始的 15 张' }));

    await waitFor(() => {
      expect(calls).toContain('POST /api/balance-batches/batch-1/cancel');
    });
    await waitFor(() => {
      expect(view.getByRole('region', { name: '批量查询进度' }).textContent).toContain('已取消 15');
    });
    expect(view.queryByRole('button', { name: /取消未开始/ })).toBeNull();
    expect(cancelledCalls).toBe(1);
    confirmSpy.mockRestore();
  });

  test('offers no cancel to someone who may not query balances', async () => {
    serve([batch()]);
    const view = render(BatchProgress, { canCancel: false, onCancelled: () => undefined });

    await view.findByRole('region', { name: '批量查询进度' });
    expect(view.queryByRole('button', { name: /取消未开始/ })).toBeNull();
  });
});
