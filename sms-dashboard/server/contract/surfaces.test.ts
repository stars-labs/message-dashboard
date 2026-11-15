import { describe, expect, spyOn, test } from 'bun:test';
import { implement, ORPCError } from '@orpc/server';
import * as v from 'valibot';
import { bodyObject } from '../../shared/api/body.js';
import { route } from '../../shared/api/contract/route.js';
import { TEST_API_KEY, testEnv } from '../../test/worker-harness.js';
import { auth0Handler } from '../handlers/auth0.js';
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
  ownMessage: route({ kind: 'daemon', errors: 'flagged' }, 'POST', '/api/control/own-message')
    .input(
      bodyObject(
        { name: v.string('name is required') },
        { name: 'name is required' },
        'name is required',
        'name is required',
      ),
    )
    .output(v.unknown()),
  runner: route({ kind: 'runner', scope: 'balance:skills:run' }, 'POST', '/api/control/runner')
    .input(Body)
    .output(v.unknown()),
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
    ownMessage: os.ownMessage.handler(({ input }) => input),
    runner: os.runner.handler(({ context }) => context.runner),
  }),
);

const KEY = { 'X-API-Key': TEST_API_KEY };

function post(path: string, body?: string, credentials: Record<string, string> = KEY): AppRequest {
  return Object.assign(
    new Request(`https://worker.test${path}`, {
      method: 'POST',
      headers: { ...credentials, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body }),
    }),
    { env: testEnv(), ctx: { waitUntil: () => undefined } },
  );
}

async function answer(path: string, body?: string, credentials: Record<string, string> = KEY) {
  const errors = spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const response = await handle(post(path, body, credentials));
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
  test('answers an unexpected failure on a flagged daemon route as the Worker always has', async () => {
    expect(await answer('/api/control/broken')).toEqual({
      status: 500,
      contentType: 'application/json;charset=utf-8',
      body: { error: 'Internal Server Error' },
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

  test('answers a daemon body that is absent or not JSON with the message its schema gives', async () => {
    const refusals = [];
    for (const body of [undefined, '', '{"name":', '[]', '{}']) {
      const { status, body: answered } = await answer('/api/control/own-message', body);
      refusals.push([body, status, answered]);
    }
    expect(refusals).toEqual([
      [undefined, 400, { success: false, error: 'name is required' }],
      ['', 400, { success: false, error: 'name is required' }],
      ['{"name":', 400, { success: false, error: 'name is required' }],
      ['[]', 400, { success: false, error: 'name is required' }],
      ['{}', 400, { success: false, error: 'name is required' }],
    ]);
  });

  test('admits a runner by the API key or a token with its scope, and hands the handler who it is', async () => {
    const verify = spyOn(auth0Handler, 'verifyToken');
    try {
      expect(await answer('/api/control/runner', '{"name":"n"}')).toMatchObject({
        status: 200,
        body: { authorized: true, authMode: 'legacy_api_key', subject: null },
      });
      verify.mockResolvedValue({ sub: 'auth0|alice', permissions: ['balance:skills:run'] });
      expect(
        await answer('/api/control/runner', '{"name":"n"}', { Authorization: 'Bearer t' }),
      ).toMatchObject({
        status: 200,
        body: { authorized: true, authMode: 'auth0_device', subject: 'auth0|alice' },
      });
    } finally {
      verify.mockRestore();
    }
  });

  test('refuses a runner without its scope as the runner routes always have, before the body', async () => {
    const verify = spyOn(auth0Handler, 'verifyToken').mockResolvedValue({
      sub: 'auth0|alice',
      scope: 'balance:browser:run',
    });
    try {
      for (const credentials of [{}, { 'X-API-Key': 'wrong' }, { Authorization: 'Bearer t' }]) {
        expect(await answer('/api/control/runner', '{', credentials)).toEqual({
          status: 401,
          contentType: 'application/json;charset=utf-8',
          body: { error: 'Unauthorized' },
          logged: false,
        });
      }
    } finally {
      verify.mockRestore();
    }
  });

  test("answers a runner route's refusals in { error }", async () => {
    expect(await answer('/api/control/runner', '{"name":5}')).toMatchObject({
      status: 400,
      contentType: 'application/json;charset=utf-8',
      body: { error: 'name must be text' },
    });
  });

  test('leaves a path outside the contract to the legacy Router', async () => {
    expect(await handle(post('/api/control/unknown'))).toBeNull();
  });
});
