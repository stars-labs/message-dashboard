import * as v from 'valibot';
import {
  BackfillExecuteBody,
  BackfillExecuteResponse,
  BackfillPreviewBody,
  BackfillPreviewResponse,
  CarrierBillingAccountsResponse,
} from '../carrier-billing.js';
import {
  CarrierBillMutationBody,
  CarrierBillMutationResponse,
  CarrierBillResponse,
  CarrierBillsQuery,
  CarrierBillsResponse,
  IdempotencyHeaders,
} from '../carrier-bills.js';
import { route } from './route.js';

/** An action on one bill, retried under its Idempotency-Key header. */
function billAction(path: `/api/carrier-bills/{id}/${string}`) {
  return route({ kind: 'user', permission: 'bills.write' }, 'POST', path)
    .route({ inputStructure: 'detailed' })
    .input(
      v.object({
        params: v.object({ id: v.string() }),
        headers: IdempotencyHeaders,
        body: CarrierBillMutationBody,
      }),
    )
    .output(CarrierBillMutationResponse);
}

/** Postpaid carrier bills, the billing accounts they belong to, and what an operator did with them. */
export const carrierBills = {
  accounts: route(
    { kind: 'user', permission: 'bills.read' },
    'GET',
    '/api/carrier-billing/accounts',
  ).output(CarrierBillingAccountsResponse),
  /** The account's historical bill messages a backfill would store. */
  backfillPreview: route(
    { kind: 'user', permission: 'bills.write' },
    'POST',
    '/api/carrier-billing/backfill/preview',
  )
    .input(BackfillPreviewBody)
    .output(BackfillPreviewResponse),
  /** Stores exactly the preview the operator saw, retried under its Idempotency-Key header. */
  backfillExecute: route(
    { kind: 'user', permission: 'bills.write' },
    'POST',
    '/api/carrier-billing/backfill/execute',
  )
    .route({ inputStructure: 'detailed' })
    .input(v.object({ headers: IdempotencyHeaders, body: BackfillExecuteBody }))
    .output(BackfillExecuteResponse),
  list: route({ kind: 'user', permission: 'bills.read' }, 'GET', '/api/carrier-bills')
    .route({ inputStructure: 'detailed' })
    .input(v.object({ query: CarrierBillsQuery }))
    .output(CarrierBillsResponse),
  get: route({ kind: 'user', permission: 'bills.read' }, 'GET', '/api/carrier-bills/{id}')
    .route({ inputStructure: 'detailed' })
    .input(v.object({ params: v.object({ id: v.string() }) }))
    .output(CarrierBillResponse),
  paymentPlanned: billAction('/api/carrier-bills/{id}/payment-planned'),
  markPaid: billAction('/api/carrier-bills/{id}/mark-paid'),
  waive: billAction('/api/carrier-bills/{id}/waive'),
  reopen: billAction('/api/carrier-bills/{id}/reopen'),
};
