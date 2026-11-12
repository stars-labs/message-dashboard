/** A candidate balance and where it was found, for diagnostics. */
interface BalanceCandidate {
  amount: number;
  path: string;
}

/** A candidate account number and where it was found. */
interface AccountCandidate {
  value: string;
  path: string;
}

/** What a Unicom web balance query proves. */
export interface UnicomWebBalance {
  balance: number;
  currency: 'CNY';
  account_number: string;
  balance_path: string;
  account_path: string;
}

/** A value the recursive scan walks. */
type JsonValue = unknown;

const BALANCE_KEYS = new Set<string>([
  'availablebalance',
  'availablefee',
  'balance',
  'balanceamount',
  'cashbalance',
  'remainbalance',
  'remainfee',
  'remainingbalance',
  '剩余话费',
  '可用余额',
  '账户余额',
]);

const ACCOUNT_KEYS = new Set<string>([
  'account',
  'accountnumber',
  'loginname',
  'mobile',
  'mobilenumber',
  'phone',
  'phonenumber',
  'serialnumber',
  'usernumber',
  '手机号',
  '手机号码',
]);

function normalizedKey(value: unknown): string {
  return String(value || '').toLocaleLowerCase().replace(/[\s_-]/g, '');
}

function normalizePhone(value: unknown): string {
  return String(value || '').replace(/\D/g, '').replace(/^86(?=1\d{10}$)/, '');
}

function accountMatches(value: unknown, expectedPhone: unknown): boolean {
  const expected = normalizePhone(expectedPhone);
  if (normalizePhone(value) === expected) return true;

  const masked = String(value || '').trim().match(/^(\d{3})\*+(\d{4})$/);
  return Boolean(masked
    && expected.length === 11
    && expected.startsWith(masked[1])
    && expected.endsWith(masked[2]));
}

function walk(
  value: JsonValue,
  visit: (key: string, value: unknown, path: string[]) => void,
  path: string[] = [],
): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visit, [...path, String(index)]));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    visit(key, child, [...path, key]);
    walk(child, visit, [...path, key]);
  }
}

function parseMoney(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^\s*(?:CNY|RMB|￥|¥)?\s*(-?\d+(?:\.\d{1,2})?)\s*(?:元|CNY|RMB)?\s*$/i);
  return match ? Number(match[1]) : null;
}

// The portal's balance endpoint answers with a flat object whose account balance
// is `curntbalancecust`. Its itemised bill breakdown nests unrelated `balance`
// fields, so this is read by exact key instead of joining BALANCE_KEYS — the
// generic scan would otherwise collect several candidates and refuse the response.
const ACCOUNT_BALANCE_KEY = 'curntbalancecust';

// Exported so the browser workflow can identify the authenticated response.
export const UNICOM_BALANCE_FIELD = ACCOUNT_BALANCE_KEY;

function explicitAccountBalance(payload: Record<string, unknown> | null | undefined) {
  const amount = parseMoney(payload?.[ACCOUNT_BALANCE_KEY]);
  return amount == null ? null : { amount, path: ACCOUNT_BALANCE_KEY };
}

export function extractUnicomWebBalance(
  payload: Record<string, unknown> | null | undefined,
  expectedPhone: unknown,
): UnicomWebBalance {
  const balances: BalanceCandidate[] = [];
  const accounts: AccountCandidate[] = [];
  const explicit = explicitAccountBalance(payload);
  if (explicit) balances.push(explicit);

  const resource = payload?.resource as { dataList?: unknown } | undefined;
  const dataList = resource?.dataList;
  if (Array.isArray(dataList)) {
    (dataList as Array<Record<string, unknown>>).forEach((item, index) => {
      if (item?.remainTitle !== '剩余话费' || item?.unit !== '元') return;
      const amount = parseMoney(item.number);
      if (amount != null) {
        balances.push({ amount, path: `resource.dataList.${index}.number` });
      }
    });
  }
  walk(payload, (key, value, path) => {
    const normalized = normalizedKey(key);
    // Skipped once the exact key matched: the nested bill breakdown repeats
    // `balance` for individual charge items, which are not account balances.
    if (!explicit && BALANCE_KEYS.has(normalized)) {
      const amount = parseMoney(value);
      if (amount != null) balances.push({ amount, path: path.join('.') });
    }
    if (ACCOUNT_KEYS.has(normalized) && ['string', 'number'].includes(typeof value)) {
      accounts.push({ value: String(value), path: path.join('.') });
    }
  });

  if (balances.length !== 1) {
    throw new Error(balances.length
      ? 'Unicom response contains multiple candidate balance fields'
      : 'Unicom response does not contain a recognized available-balance field');
  }

  const account = accounts.find((candidate) => accountMatches(candidate.value, expectedPhone));
  if (!account) throw new Error('Unicom response does not prove the authenticated account number');

  return {
    balance: balances[0].amount,
    currency: 'CNY',
    account_number: String(expectedPhone),
    balance_path: balances[0].path,
    account_path: account.path,
  };
}
