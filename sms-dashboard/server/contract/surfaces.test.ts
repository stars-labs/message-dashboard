import { describe, expect, spyOn, test } from 'bun:test';
import { implement } from '@orpc/server';
import * as v from 'valibot';
import { route } from '../../shared/api/contract/route.js';
import { TEST_API_KEY, testEnv } from '../../test/worker-harness.js';
import type { AppRequest } from '../worker-context.js';
import { createContractHandler } from './handler.js';
import type { ContractContext } from './router.js';

// A contract of its own, so the entry's rules are tested apart from the routes
// that happen to use them today.
const contract = {
  control: route({ kind: 'daemon' }, 'POST', '/api/control/broken').output(v.unknown()),
  page: route({ kind: 'daemon' }, 'POST', '/api/broken').output(v.unknown()),
};

const os = implement(contract).$context<ContractContext>();
const fault = new Error('the database went away');

const handle = createContractHandler(
  os.router({
    control: os.control.handler(() => Promise.reject(fault)),
    page: os.page.handler(() => Promise.reject(fault)),
  }),
);

function post(path: string, body?: string): AppRequest {
  return Object.assign(
    new Request(`https://worker.test${path}`, {
      method: 'POST',
      headers: { 'X-API-Key': TEST_API_KEY, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body }),
    }),
    { env: testEnv(), ctx: { waitUntil: () => undefined } },
  );
}

async function answer(path: string, body?: string) {
  const errors = spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const response = await handle(post(path, body));
    return {
      status: response?.status,
      contentType: response?.headers.get('Content-Type'),
      body: await response?.json(),
      logged: errors.mock.calls.length > 0,
    };
  } finally {
    errors.mockRestore();
  }
}

describe('the contract entry', () => {
  test('answers /api/control/ routes in the daemon error format', async () => {
    expect(await answer('/api/control/broken')).toEqual({
      status: 500,
      contentType: 'application/json;charset=utf-8',
      body: { success: false, error: 'Internal server error' },
      logged: true,
    });
  });

  test('answers every other route with a problem', async () => {
    expect(await answer('/api/broken')).toEqual({
      status: 500,
      contentType: 'application/problem+json',
      body: {
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'Internal server error',
        code: 'INTERNAL_SERVER_ERROR',
      },
      logged: true,
    });
  });

  test('does not log a body the caller got wrong', async () => {
    expect(await answer('/api/broken', '{"oops":')).toMatchObject({ status: 400, logged: false });
  });

  test('leaves a path outside the contract to the legacy Router', async () => {
    expect(await handle(post('/api/control/unknown'))).toBeNull();
  });
});
