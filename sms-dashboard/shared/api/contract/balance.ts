import * as v from 'valibot';
import {
  BalanceCheckDetailResponse,
  BalanceCheckStatusQuery,
  BalanceCheckStatusResponse,
  BalanceChecksQuery,
  BalanceChecksResponse,
  BalanceQueryBatchBody,
  BalanceQueryBatchResponse,
  BalanceQueryBody,
  BalanceQueryPreflightQuery,
  BalanceQueryPreflightResponse,
  BalanceQueryPreviewBody,
  BalanceQueryPreviewResponse,
  BalanceQueryResponse,
} from '../balance-checks.js';
import {
  BalanceRunnersResponse,
  RunnerInstallationsResponse,
  RunnerRevokeResponse,
} from '../balance-runners.js';
import { route } from './route.js';

export const balanceChecks = {
  list: route({ kind: 'user', permission: 'messages.read' }, 'GET', '/api/balance-checks')
    .route({ inputStructure: 'detailed' })
    .input(v.object({ query: BalanceChecksQuery }))
    .output(BalanceChecksResponse),
  status: route({ kind: 'user', permission: 'messages.read' }, 'GET', '/api/balance-checks/status')
    .route({ inputStructure: 'detailed' })
    .input(v.object({ query: BalanceCheckStatusQuery }))
    .output(BalanceCheckStatusResponse),
  preview: route(
    { kind: 'user', permission: 'balances.query' },
    'POST',
    '/api/balance-checks/query-preview',
  )
    .input(BalanceQueryPreviewBody)
    .output(BalanceQueryPreviewResponse),
  preflight: route(
    { kind: 'user', permission: 'balances.query' },
    'GET',
    '/api/balance-checks/query-preflight',
  )
    .route({ inputStructure: 'detailed' })
    .input(v.object({ query: BalanceQueryPreflightQuery }))
    .output(BalanceQueryPreflightResponse),
  // 202: the check is queued; its SMS or browser job runs later.
  query: route({ kind: 'user', permission: 'balances.query' }, 'POST', '/api/balance-checks/query')
    .route({ outputStructure: 'detailed' })
    .input(BalanceQueryBody)
    .output(v.object({ status: v.literal(202), body: BalanceQueryResponse })),
  queryBatch: route(
    { kind: 'user', permission: 'balances.query' },
    'POST',
    '/api/balance-checks/query-batch',
  )
    .route({ outputStructure: 'detailed' })
    .input(BalanceQueryBatchBody)
    .output(v.object({ status: v.literal(202), body: BalanceQueryBatchResponse })),
  detail: route({ kind: 'user', permission: 'messages.read' }, 'GET', '/api/balance-checks/{id}')
    .route({ inputStructure: 'detailed' })
    .input(v.object({ params: v.object({ id: v.string() }) }))
    .output(BalanceCheckDetailResponse),
};

export const balanceRunners = {
  status: route(
    { kind: 'user', permission: 'messages.read' },
    'GET',
    '/api/balance-runners',
  ).output(BalanceRunnersResponse),
  installations: route(
    { kind: 'user', permission: 'runners.read' },
    'GET',
    '/api/balance-runners/installations',
  ).output(RunnerInstallationsResponse),
  revoke: route(
    { kind: 'user', permission: 'runners.write' },
    'POST',
    '/api/balance-runners/{id}/revoke',
  )
    .route({ inputStructure: 'detailed' })
    .input(v.object({ params: v.object({ id: v.string() }) }))
    .output(RunnerRevokeResponse),
};
