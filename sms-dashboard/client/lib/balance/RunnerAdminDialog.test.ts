import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type {
  RunnerInstallation,
  RunnerInstallationsResponse,
} from '../../../shared/api/balance-runners.js';
import { auth } from '../auth.js';
import RunnerAdminDialog from './RunnerAdminDialog.svelte';

const originalBaseUrl = auth.baseUrl;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined;

afterEach(() => {
  cleanup();
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
  auth.baseUrl = originalBaseUrl;
});

function runner(overrides: Partial<RunnerInstallation> = {}): RunnerInstallation {
  return {
    id: 'alice-mac',
    display_name: 'Alice MacBook',
    auth_mode: 'auth0_device',
    auth_subject: 'auth0|alice',
    platform: 'darwin',
    version: '1.2.0',
    last_heartbeat: '2026-11-26 08:00:00',
    online: true,
    revoked_at: null,
    ...overrides,
  };
}

function serve(runners: RunnerInstallation[]) {
  const calls: string[] = [];
  let current = runners;
  auth.baseUrl = 'https://example.com';
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        calls.push(`${request.method} ${url.pathname}`);
        if (url.pathname === '/api/balance-runners/installations') {
          const body: RunnerInstallationsResponse = { success: true, runners: current };
          return Promise.resolve(Response.json(body));
        }
        const revoke = /^\/api\/balance-runners\/([^/]+)\/revoke$/.exec(url.pathname);
        if (revoke?.[1] !== undefined && request.method === 'POST') {
          const id = decodeURIComponent(revoke[1]);
          current = current.map((row) =>
            row.id === id ? { ...row, online: false, revoked_at: '2026-11-26 09:00:00' } : row,
          );
          return Promise.resolve(
            Response.json({ success: true, runner_id: id, revoked_at: '2026-11-26 09:00:00' }),
          );
        }
        return Promise.reject(new Error(`Unexpected request: ${url.href}`));
      },
      { preconnect: () => undefined },
    ),
  );
  return calls;
}

describe('runner administration dialog', () => {
  test('lists every runner with its owner, version and state', async () => {
    serve([
      runner(),
      runner({ id: 'bob-mac', display_name: 'Bob iMac', auth_subject: 'auth0|bob', online: false }),
      runner({
        id: 'old-mac',
        display_name: 'Old Mac',
        online: false,
        revoked_at: '2026-11-01 08:00:00',
      }),
    ]);
    const view = render(RunnerAdminDialog, { onClose: () => undefined });

    const rows = await view.findAllByRole('row');
    const text = rows.slice(1).map((row) => row.textContent.replaceAll(/\s+/g, ' ').trim());
    expect(text[0]).toContain('Alice MacBook');
    expect(text[0]).toContain('auth0|alice');
    expect(text[0]).toContain('1.2.0');
    expect(text[0]).toContain('在线');
    expect(text[1]).toContain('离线');
    expect(text[2]).toContain('已撤销');
    expect(view.getAllByRole('button', { name: /^撤销/ })).toHaveLength(2);
  });

  test('revokes one runner after confirmation and shows it revoked', async () => {
    const calls = serve([runner(), runner({ id: 'bob-mac', display_name: 'Bob iMac' })]);
    const confirmSpy = spyOn(window, 'confirm').mockReturnValue(true);
    const view = render(RunnerAdminDialog, { onClose: () => undefined });

    await fireEvent.click(await view.findByRole('button', { name: '撤销 Bob iMac' }));

    await waitFor(() => {
      expect(calls).toContain('POST /api/balance-runners/bob-mac/revoke');
    });
    await waitFor(() => {
      expect(view.queryByRole('button', { name: '撤销 Bob iMac' })).toBeNull();
    });
    expect(view.getByRole('button', { name: '撤销 Alice MacBook' })).toBeTruthy();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  test('does nothing when the confirmation is declined', async () => {
    const calls = serve([runner()]);
    const confirmSpy = spyOn(window, 'confirm').mockReturnValue(false);
    const view = render(RunnerAdminDialog, { onClose: () => undefined });

    await fireEvent.click(await view.findByRole('button', { name: '撤销 Alice MacBook' }));

    expect(calls).not.toContain('POST /api/balance-runners/alice-mac/revoke');
    confirmSpy.mockRestore();
  });
});
