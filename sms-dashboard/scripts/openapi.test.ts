import { describe, expect, test } from 'bun:test';
import { openapiDocument } from './openapi.js';

const doc = await openapiDocument();

function operation(path: string, method: 'get' | 'put' | 'post') {
  const found = doc.paths?.[path]?.[method];
  if (!found) throw new Error(`no ${method} ${path} in the document`);
  return found;
}

describe('the OpenAPI document', () => {
  test('lists every contract route', () => {
    expect(
      Object.entries(doc.paths ?? {}).flatMap(([path, item]) =>
        Object.keys(item ?? {}).map((method) => `${method.toUpperCase()} ${path}`),
      ),
    ).toEqual([
      'POST /api/control/heartbeat',
      'GET /api/live',
      'GET /api/health',
      'GET /api/daemon/status',
      'GET /api/auth/me',
      'GET /api/users',
      'PUT /api/users/{id}/role',
      'GET /api/phones',
      'GET /api/messages',
      'POST /api/messages/send',
      'GET /api/iccid-mappings',
      'POST /api/iccid-mappings',
      'GET /api/iccid-mappings/{id}',
      'PUT /api/iccid-mappings/{id}',
      'DELETE /api/iccid-mappings/{id}',
      'GET /api/iccid-mappings/by-iccid/{iccid}',
      'POST /api/iccid-mappings/bulk',
      'GET /api/keywords',
      'POST /api/keywords',
      'GET /api/keywords/{id}',
      'PUT /api/keywords/{id}',
      'DELETE /api/keywords/{id}',
      'POST /api/keywords/{id}/history',
      'POST /api/messages/batch-tags',
      'GET /api/messages/{id}/tags',
      'GET /api/filters',
      'POST /api/filters',
      'PUT /api/filters/{id}',
      'DELETE /api/filters/{id}',
      'POST /api/filters/{id}/history',
      'POST /api/verification/reprocess',
      'GET /api/balance-checks',
      'GET /api/balance-checks/status',
      'GET /api/balance-checks/query-preview',
      'POST /api/balance-checks/query-preview',
      'GET /api/balance-checks/query-preflight',
      'POST /api/balance-checks/query',
      'POST /api/balance-checks/query-batch',
      'GET /api/balance-checks/{id}',
      'GET /api/balance-runners',
      'GET /api/carrier-billing/accounts',
      'POST /api/carrier-billing/backfill/preview',
      'POST /api/carrier-billing/backfill/execute',
      'GET /api/carrier-bills',
      'GET /api/carrier-bills/{id}',
      'POST /api/carrier-bills/{id}/payment-planned',
      'POST /api/carrier-bills/{id}/mark-paid',
      'POST /api/carrier-bills/{id}/waive',
      'POST /api/carrier-bills/{id}/reopen',
    ]);
  });

  test('says who may call each route', () => {
    expect(operation('/api/control/heartbeat', 'post').security).toEqual([{ daemonKey: [] }]);
    expect(operation('/api/health', 'get').security).toEqual([]);
    expect(operation('/api/auth/me', 'get').security).toEqual([{ session: [] }, { auth0: [] }]);
    expect(operation('/api/users', 'get').security).toEqual([
      { session: ['users.read'] },
      { auth0: ['users.read'] },
    ]);
    expect(operation('/api/users/{id}/role', 'put').security).toEqual([
      { session: ['users.write'] },
      { auth0: ['users.write'] },
    ]);
  });

  test('describes the error format each route answers', () => {
    expect(operation('/api/control/heartbeat', 'post').responses['default']).toEqual({
      $ref: '#/components/responses/DaemonError',
    });
    for (const [path, method] of [
      ['/api/users', 'get'],
      ['/api/users/{id}/role', 'put'],
    ] as const) {
      expect(operation(path, method).responses['default']).toEqual({
        $ref: '#/components/responses/Problem',
      });
    }
  });

  test('carries the heartbeat answer the daemon reads', () => {
    expect(operation('/api/control/heartbeat', 'post').responses['200']).toMatchObject({
      content: {
        'application/json': {
          schema: {
            properties: {
              success: { const: true },
              message: { type: 'string' },
              received_at: { type: 'string' },
            },
          },
        },
      },
    });
  });
});
