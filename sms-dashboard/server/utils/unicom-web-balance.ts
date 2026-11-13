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

function textOf(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizedKey(key: string): string {
  return key.toLocaleLowerCase().replace(/[\s_-]/g, '');
}

function normalizePhone(value: unknown): string {
  return textOf(value)
    .replace(/\D/g, '')
    .replace(/^86(?=1\d{10}$)/, '');
}

function accountMatches(value: string, expectedPhone: unknown): boolean {
  const expected = normalizePhone(expectedPhone);
  if (normalizePhone(value) === expected) return true;

  const [, prefix, suffix] = /^(\d{3})\*+(\d{4})$/.exec(value.trim()) ?? [];
  return (
    prefix !== undefined &&
    suffix !== undefined &&
    expected.length === 11 &&
    expected.startsWith(prefix) &&
    expected.endsWith(suffix)
  );
}

function walk(
  value: unknown,
  visit: (key: string, value: unknown, path: string[]) => void,
  path: string[] = [],
): void {
  if (Array.isArray(value)) {
    value.forEach((item: unknown, index) => {
      walk(item, visit, [...path, String(index)]);
    });
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    visit(key, child, [...path, key]);
    walk(child, visit, [...path, key]);
  }
}

function parseMoney(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const match = /^\s*(?:CNY|RMB|￥|¥)?\s*(-?\d+(?:\.\d{1,2})?)\s*(?:元|CNY|RMB)?\s*$/i.exec(
    value.trim(),
  );
  const amountText = match?.[1];
  return amountText === undefined ? null : Number(amountText);
}

// The portal's balance endpoint answers with a flat object whose account balance
// is `curntbalancecust`. Its itemised bill breakdown nests unrelated `balance`
// fields, so this is read by exact key instead of joining BALANCE_KEYS — the
// generic scan would otherwise collect several candidates and refuse the response.
const ACCOUNT_BALANCE_KEY = 'curntbalancecust';

// Exported so the browser workflow can identify the authenticated response.
export const UNICOM_BALANCE_FIELD = ACCOUNT_BALANCE_KEY;

function explicitAccountBalance(payload: unknown): BalanceCandidate | null {
  const amount = parseMoney(isRecord(payload) ? payload[ACCOUNT_BALANCE_KEY] : undefined);
  return amount === null ? null : { amount, path: ACCOUNT_BALANCE_KEY };
}

export function extractUnicomWebBalance(
  payload: unknown,
  expectedPhone: unknown,
): UnicomWebBalance {
  const balances: BalanceCandidate[] = [];
  const accounts: AccountCandidate[] = [];
  const explicit = explicitAccountBalance(payload);
  if (explicit) balances.push(explicit);

  const resource = isRecord(payload) ? payload['resource'] : undefined;
  const dataList = isRecord(resource) ? resource['dataList'] : undefined;
  if (Array.isArray(dataList)) {
    dataList.forEach((item: unknown, index) => {
      if (!isRecord(item) || item['remainTitle'] !== '剩余话费' || item['unit'] !== '元') return;
      const amount = parseMoney(item['number']);
      if (amount !== null) {
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
      if (amount !== null) balances.push({ amount, path: path.join('.') });
    }
    if (ACCOUNT_KEYS.has(normalized) && (typeof value === 'string' || typeof value === 'number')) {
      accounts.push({ value: String(value), path: path.join('.') });
    }
  });

  if (balances.length > 1) {
    throw new Error('Unicom response contains multiple candidate balance fields');
  }
  const [balance] = balances;
  if (!balance) {
    throw new Error('Unicom response does not contain a recognized available-balance field');
  }

  const account = accounts.find((candidate) => accountMatches(candidate.value, expectedPhone));
  if (!account) throw new Error('Unicom response does not prove the authenticated account number');

  return {
    balance: balance.amount,
    currency: 'CNY',
    account_number: textOf(expectedPhone),
    balance_path: balance.path,
    account_path: account.path,
  };
}
