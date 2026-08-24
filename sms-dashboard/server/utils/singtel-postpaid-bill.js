export const SINGTEL_POSTPAID_BILL_PARSER_VERSION = 'sg-singtel-postpaid-bill-sms-v1';

const MONTHS = new Map([
  ['Jan', 1],
  ['Feb', 2],
  ['Mar', 3],
  ['Apr', 4],
  ['May', 5],
  ['Jun', 6],
  ['Jul', 7],
  ['Aug', 8],
  ['Sep', 9],
  ['Oct', 10],
  ['Nov', 11],
  ['Dec', 12],
]);

const BILL_PATTERN = /^<Singtel>Dear customer, your latest bill for Singtel a\/c (\d{8}) is ready\. The total amount is SGD\$(\d{2,3})\.(\d{2}) due on (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (20\d{2})\. You can view and pay this bill via My Singtel app at www\.singtel\.com\/viewbill \.@?$/;

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function accountReferenceDigest(accountReference) {
  const encoded = new TextEncoder().encode(accountReference);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return bytesToHex(new Uint8Array(digest));
}

function isoDate(dayText, monthName, yearText) {
  const day = Number(dayText);
  const month = MONTHS.get(monthName);
  const year = Number(yearText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day) {
    return null;
  }
  return `${yearText}-${String(month).padStart(2, '0')}-${dayText}`;
}

export async function parseSingtelPostpaidBillSms({
  sender,
  content,
  expectedAccountRefDigest,
}) {
  if (sender !== 'Singtel'
    || typeof content !== 'string'
    || (expectedAccountRefDigest != null
      && !/^[a-f\d]{64}$/i.test(expectedAccountRefDigest))) {
    return null;
  }

  const match = content.trim().match(BILL_PATTERN);
  if (!match) return null;

  const [, accountReference, majorText, minorText, dayText, monthName, yearText] = match;
  const dueDate = isoDate(dayText, monthName, yearText);
  if (!dueDate) return null;

  const digest = await accountReferenceDigest(accountReference);
  if (expectedAccountRefDigest != null
    && digest !== expectedAccountRefDigest.toLowerCase()) return null;

  const amountMinor = (Number(majorText) * 100) + Number(minorText);
  if (!Number.isSafeInteger(amountMinor)) return null;

  return {
    parser_version: SINGTEL_POSTPAID_BILL_PARSER_VERSION,
    amount_minor: amountMinor,
    currency: 'SGD',
    due_date: dueDate,
    account_ref_last4: accountReference.slice(-4),
    account_ref_digest: digest,
  };
}
