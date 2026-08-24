export const PREPAID_STALE_DAYS = 35;

const DAY_MS = 24 * 60 * 60 * 1000;

const COUNTRY_TIME_ZONES = {
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
];

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampValue(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function dateParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day) return null;
  return { year, month, day, time };
}

function regionalDate(now, country) {
  const timeZone = COUNTRY_TIME_ZONES[country] || 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return dateParts(`${values.year}-${values.month}-${values.day}`);
}

function currenciesMatch(balance, threshold) {
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
} = {}) {
  if (serviceType === 'postpaid') {
    return { summaryStatus: 'not_applicable', reasons: [] };
  }

  const reasons = new Set();
  const balanceValue = finiteNumber(cashBalance?.value);
  const thresholdValue = finiteNumber(threshold?.value);
  const observedAt = timestampValue(cashBalance?.observedAt);
  const nowTime = now.getTime();

  if (['failed', 'timed_out'].includes(latestQueryStatus)) {
    reasons.add('query_failed');
  }
  if (automationSupported === false) reasons.add('automation_unsupported');
  if (verificationPending) reasons.add('verification_pending');

  if (balanceValue == null) {
    reasons.add('never_observed');
  } else {
    if (observedAt == null || nowTime - observedAt > PREPAID_STALE_DAYS * DAY_MS) {
      reasons.add('stale');
    }
    if (balanceValue <= 0) reasons.add('zero_or_negative_balance');
    if (thresholdValue != null
      && currenciesMatch(cashBalance, threshold)
      && balanceValue < thresholdValue) {
      reasons.add('low_balance');
    }
  }

  const expiry = dateParts(accountExpiry?.date);
  if (!expiry) {
    if (expiryExpected) reasons.add('expiry_unknown');
  } else {
    const today = regionalDate(now, country);
    const daysRemaining = Math.round((expiry.time - today.time) / DAY_MS);
    if (daysRemaining < 0) reasons.add('expired');
    else if (daysRemaining <= 30) reasons.add('expiring_soon');
  }

  const summaryStatus = SUMMARY_PRIORITY.find((status) => reasons.has(status)) || 'healthy';
  return { summaryStatus, reasons: [...reasons] };
}
