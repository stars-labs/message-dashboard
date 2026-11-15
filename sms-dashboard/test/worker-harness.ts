// Drives the whole Worker in-process: a Request goes through handleRequest, as
// the runtime's fetch would send it, with every binding an in-memory double.
// Any call to the network fails the request and is reported in `outbound`.
import { mock, spyOn } from 'bun:test';
import type { AppContext, AppEnv, AppRequest } from '../server/worker-context.js';
import { memoryKv } from './memory-kv.js';
import { sqliteD1 } from './sqlite-d1.js';

// The generated module is gitignored and absent from a clean checkout.
await mock.module('../server/frontend-assets.js', () => ({
  FRONTEND_ASSETS: {
    'index.html': { content: '<!doctype html><title>app</title>', type: 'text/html' },
  },
}));

const { handleRequest, routeTable } = await import('../server/app.js');

export { routeTable };

export const TEST_API_KEY = 'test-api-key';

export function testEnv(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    DB: sqliteD1(),
    SESSIONS: memoryKv(),
    CALL_STATE: {
      getByName: () => ({
        fetch: () =>
          Promise.reject(new Error('the call-state Durable Object is not in this harness')),
      }),
    },
    VOICE_BRIDGE_HOST: 'voice-bridge.test',
    ALLOWED_EMAIL_DOMAINS: 'example.test',
    AUTH0_ADMIN_ROLE: 'sms-admin',
    AUTH0_VIEWER_ROLE: 'sms-viewer',
    AUTH0_ROLE_NAMESPACE: 'https://example.test/roles',
    AUTH0_DOMAIN: 'tenant.example.test',
    AUTH0_CLIENT_ID: 'test-client',
    API_KEY: TEST_API_KEY,
    ...overrides,
  };
}

interface WorkerCall {
  response: Response;
  /** URLs the Worker tried to fetch; the harness refuses every one unless `network` answers it. */
  outbound: string[];
}

interface WorkerInit {
  headers?: Record<string, string>;
  body?: string;
  bindings?: Partial<AppEnv>;
  /** Answers the Worker's outbound calls, standing in for an upstream such as Auth0. */
  network?: (url: string) => Response;
}

export async function callWorker(
  method: string,
  path: string,
  init: WorkerInit = {},
): Promise<WorkerCall> {
  const outbound: string[] = [];
  const network = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      (input: Parameters<typeof fetch>[0]) => {
        const url = input instanceof Request ? input.url : input.toString();
        outbound.push(url);
        if (init.network) return Promise.resolve(init.network(url));
        return Promise.reject(new Error(`the harness refuses network calls: ${url}`));
      },
      { preconnect: () => undefined },
    ),
  );
  const background: Promise<unknown>[] = [];
  const ctx: AppContext = { waitUntil: (promise) => background.push(promise) };
  const incoming = new Request(`https://worker.test${path}`, {
    method,
    headers: init.headers ?? {},
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  const request: AppRequest = Object.assign(incoming, { env: testEnv(init.bindings), ctx });
  try {
    const response = await handleRequest(request);
    await Promise.allSettled(background);
    return { response, outbound };
  } finally {
    network.mockRestore();
  }
}
