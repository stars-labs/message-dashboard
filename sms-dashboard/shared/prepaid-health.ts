export const PREPAID_STALE_DAYS = 35;

const DAY_MS = 24 * 60 * 60 * 1000;

const COUNTRY_TIME_ZONES: Record<string, string> = {
  CN: 'Asia/Shanghai',
  SG: 'Asia/Singapore',
  HK: 'Asia/Hong_Kong',
};

const SUMMARY_PRIORITY = [
  'expired',
  'zero_or_negative_balance',
  'query_failed',
  'verification_pending',
  'stale',
  'low_balance',
  'expiring_soon',
  'never_observed',
  'expiry_unknown',
] as const;

/** Headline verdict for a SIM. `healthy` is the absence of every reason above. */
export type SummaryStatus = (typeof SUMMARY_PRIORITY)[number] | 'healthy' | 'not_applicable';

/**
 * Reasons a health rule can fire. `automation_unsupported` is deliberately not
 * in SUMMARY_PRIORITY: it is evidence for the UI, never a headline status.
 */
export type HealthReason = (typeof SUMMARY_PRIORITY)[number] | 'automation_unsupported';

export interface Money {
  value: number | string;
  currency?: string | null;
}

export interface CashBalance extends Money {
  observedAt?: string | null;
}

export interface AccountExpiry {
  date?: string | null;
}

export interface PrepaidHealthInput {
  serviceType?: string;
  /** ISO country code from D1, unvalidated. Unknown values fall back to UTC. */
  country?: string | null;
  now?: Date;
  threshold?: Money | null;
  cashBalance?: CashBalance | null;
  accountExpiry?: AccountExpiry | null;
  latestQueryStatus?: string | null;
  automationSupported?: boolean;
  expiryExpected?: boolean;
  verificationPending?: boolean;
}

export interface PrepaidHealthResult {
  summaryStatus: SummaryStatus;
  reasons: HealthReason[];
}

interface DateParts {
  year: number;
  month: number;
  day: number;
  time: number;
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampValue(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function dateParts(value: string | null | undefined): DateParts | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return { year, month, day, time };
}

function regionalDate(now: Date, country: string | null): DateParts | null {
  const timeZone = (country ? COUNTRY_TIME_ZONES[country] : undefined) ?? 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return dateParts(`${values['year']}-${values['month']}-${values['day']}`);
}

function currenciesMatch(
  balance: Money | null | undefined,
  threshold: Money | null | undefined,
): boolean {
  if (!balance?.currency || !threshold?.currency) return true;
  return balance.currency === threshold.currency;
}

export function evaluatePrepaidHealth({
  serviceType = 'unknown',
  country = null,
  now = new Date(),
  threshold = null,
  cashBalance = null,
  accountExpiry = null,
  latestQueryStatus = null,
  automationSupported = true,
  expiryExpected = false,
  verificationPending = false,
}: PrepaidHealthInput = {}): PrepaidHealthResult {
  if (serviceType === 'postpaid') {
    return { summaryStatus: 'not_applicable', reasons: [] };
  }

  const reasons = new Set<HealthReason>();
  const balanceValue = finiteNumber(cashBalance?.value);
  const thresholdValue = finiteNumber(threshold?.value);
  const observedAt = timestampValue(cashBalance?.observedAt);
  const nowTime = now.getTime();

  if (latestQueryStatus === 'failed' || latestQueryStatus === 'timed_out') {
    reasons.add('query_failed');
  }
  if (!automationSupported) reasons.add('automation_unsupported');
  if (verificationPending) reasons.add('verification_pending');

  if (balanceValue == null) {
    reasons.add('never_observed');
  } else {
    if (observedAt == null || nowTime - observedAt > PREPAID_STALE_DAYS * DAY_MS) {
      reasons.add('stale');
    }
    if (balanceValue <= 0) reasons.add('zero_or_negative_balance');
    if (
      thresholdValue != null &&
      currenciesMatch(cashBalance, threshold) &&
      balanceValue < thresholdValue
    ) {
      reasons.add('low_balance');
    }
  }

  const expiry = dateParts(accountExpiry?.date);
  if (!expiry) {
    if (expiryExpected) reasons.add('expiry_unknown');
  } else {
    const today = regionalDate(now, country);
    if (!today) {
      // Unreachable while COUNTRY_TIME_ZONES holds valid ICU identifiers, but
      // a bad entry there would otherwise throw on .time and take the caller
      // down. Degrade to "we do not know" instead.
      reasons.add('expiry_unknown');
    } else {
      const daysRemaining = Math.round((expiry.time - today.time) / DAY_MS);
      if (daysRemaining < 0) reasons.add('expired');
      else if (daysRemaining <= 30) reasons.add('expiring_soon');
    }
  }

  const summaryStatus = SUMMARY_PRIORITY.find((status) => reasons.has(status)) ?? 'healthy';
  return { summaryStatus, reasons: [...reasons] };
}
