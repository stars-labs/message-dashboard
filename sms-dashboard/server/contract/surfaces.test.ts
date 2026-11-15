import { describe, expect, spyOn, test } from 'bun:test';
import { implement, ORPCError } from '@orpc/server';
import * as v from 'valibot';
import { bodyObject } from '../../shared/api/body.js';
import { route } from '../../shared/api/contract/route.js';
import { TEST_API_KEY, testEnv } from '../../test/worker-harness.js';
import type { AppRequest } from '../worker-context.js';
import { createContractHandler } from './handler.js';
import type { ContractContext } from './router.js';

// A contract of its own, so the entry's rules are tested apart from the routes
// that happen to use them today.
const Body = bodyObject(
  { name: v.string('name must be text') },
  { name: 'name must be text' },
  'Body must be an object',
);

const contract = {
  control: route({ kind: 'daemon', errors: 'flagged' }, 'POST', '/api/control/broken').output(
    v.unknown(),
  ),
  flagged: route({ kind: 'daemon', errors: 'flagged' }, 'POST', '/api/control/flagged')
    .input(Body)
    .output(v.unknown()),
  plain: route({ kind: 'daemon', errors: 'plain' }, 'POST', '/api/control/plain')
    .input(Body)
    .output(v.unknown()),
  plainBroken: route(
    { kind: 'daemon', errors: 'plain' },
    'POST',
    '/api/control/plain-broken',
  ).output(v.unknown()),
  whole: route({ kind: 'daemon', errors: 'plain' }, 'POST', '/api/control/whole').output(
    v.unknown(),
  ),
  page: route({ kind: 'daemon', errors: 'flagged' }, 'POST', '/api/broken').output(v.unknown()),
};

const os = implement(contract).$context<ContractContext>();
const fault = new Error('the database went away');

const handle = createContractHandler(
  os.router({
    control: os.control.handler(() => Promise.reject(fault)),
    flagged: os.flagged.handler(({ input }) => input),
    plain: os.plain.handler(({ input }) => input),
    plainBroken: os.plainBroken.handler(() => Promise.reject(fault)),
    whole: os.whole.handler(() => {
      throw new ORPCError('CONFLICT', { data: { wire: { ok: false, reason: 'busy' } } });
    }),
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

  test("answers a daemon route's refusals in the format it declares", async () => {
    const refusals = [];
    for (const path of ['/api/control/flagged', '/api/control/plain']) {
      for (const body of [undefined, '', '{"name":', '{"name":5}']) {
        const { status, body: answered } = await answer(path, body);
        refusals.push([path, body, status, answered]);
      }
    }
    expect(refusals).toEqual([
      ['/api/control/flagged', undefined, 400, { success: false, error: 'Body must be JSON' }],
      ['/api/control/flagged', '', 400, { success: false, error: 'Body must be JSON' }],
      ['/api/control/flagged', '{"name":', 400, { success: false, error: 'Body must be JSON' }],
      ['/api/control/flagged', '{"name":5}', 400, { success: false, error: 'name must be text' }],
      ['/api/control/plain', undefined, 400, { error: 'Body must be JSON' }],
      ['/api/control/plain', '', 400, { error: 'Body must be JSON' }],
      ['/api/control/plain', '{"name":', 400, { error: 'Body must be JSON' }],
      ['/api/control/plain', '{"name":5}', 400, { error: 'name must be text' }],
    ]);
  });

  test('answers an unexpected failure on a plain daemon route as the Worker always has', async () => {
    expect(await answer('/api/control/plain-broken')).toEqual({
      status: 500,
      contentType: 'application/json;charset=utf-8',
      body: { error: 'Internal Server Error' },
      logged: true,
    });
  });

  test('answers a body a daemon route gives whole, as given', async () => {
    expect(await answer('/api/control/whole')).toEqual({
      status: 409,
      contentType: 'application/json;charset=utf-8',
      body: { ok: false, reason: 'busy' },
      logged: false,
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
