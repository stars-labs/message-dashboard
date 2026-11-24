import type { buildBalanceRows } from '../balance-overview.js';
import type { BATCH_METHODS } from '../../../shared/api/balance-checks.js';
import type { CarrierBillingAccountsResponse } from '../../../shared/api/carrier-billing.js';
import type { CarrierBillResponse } from '../../../shared/api/carrier-bills.js';
import type { Phone } from '../../../shared/api/phones.js';
import type { SummaryStatus } from '../../../shared/prepaid-health.js';

export interface BalancePhone extends Pick<
  Phone,
  | 'iccid'
  | 'sim_index'
  | 'number'
  | 'carrier'
  | 'country'
  | 'service_type'
  | 'sim_role'
  | 'primary_iccid'
  | 'balance_threshold'
> {
  flag: string;
}

export type BalanceRow = ReturnType<typeof buildBalanceRows<BalancePhone>>[number];
export type GroupedBalanceRow = BalanceRow & { __depth: 0 | 1; __isSecondary: boolean };

export type BillAccount = CarrierBillingAccountsResponse['accounts'][number];
export type BillDetail = CarrierBillResponse['bill'];
export type BillAction = 'paymentPlanned' | 'markPaid' | 'waive' | 'reopen';
export type BatchMethod = (typeof BATCH_METHODS)[number];
export type StatusFilter = 'all' | 'payment' | 'expiry' | 'missing' | SummaryStatus;
export type OverviewSortKey =
  | 'sim'
  | 'carrier'
  | 'sim_role'
  | 'service_type'
  | 'balance'
  | 'expiry'
  | 'health'
  | 'threshold'
  | 'updated'
  | 'query';
export type HistorySortKey = 'time' | 'sim' | 'carrier' | 'method' | 'status' | 'balance';
export type SortDirection = 'asc' | 'desc';
export type SortValue = string | number | null | undefined;
export type FilterTab = readonly [StatusFilter, string, number];

export interface Notice {
  type: 'success' | 'error';
  message: string;
}
