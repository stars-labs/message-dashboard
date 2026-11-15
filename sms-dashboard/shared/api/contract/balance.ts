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
import { BalanceRunnersResponse } from '../balance-runners.js';
import { route } from './route.js';

/** The balance checks the dashboard lists, polls and opens. */
export const balanceChecks = {
  list: route({ kind: 'user', permission: 'messages.read' }, 'GET', '/api/balance-checks')
    .route({ inputStructure: 'detailed' })
    .input(v.object({ query: BalanceChecksQuery }))
    .output(BalanceChecksResponse),
  status: route({ kind: 'user', permission: 'messages.read' }, 'GET', '/api/balance-checks/status')
    .route({ inputStructure: 'detailed' })
    .input(v.object({ query: BalanceCheckStatusQuery }))
    .output(BalanceCheckStatusResponse),
  /** Every SIM's plan. */
  previewAll: route(
    { kind: 'user', permission: 'balances.query' },
    'GET',
    '/api/balance-checks/query-preview',
  ).output(BalanceQueryPreviewResponse),
  /** The plan of the SIMs the operator named. */
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

/** The signed-in user's Balance Agent runners and what they can do now. */
export const balanceRunners = {
  status: route(
    { kind: 'user', permission: 'messages.read' },
    'GET',
    '/api/balance-runners',
  ).output(BalanceRunnersResponse),
};
