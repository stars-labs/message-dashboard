const BALANCE_KEYS = new Set([
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

const ACCOUNT_KEYS = new Set([
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

function normalizedKey(value) {
  return String(value || '').toLocaleLowerCase().replace(/[\s_-]/g, '');
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '').replace(/^86(?=1\d{10}$)/, '');
}

function accountMatches(value, expectedPhone) {
  const expected = normalizePhone(expectedPhone);
  if (normalizePhone(value) === expected) return true;

  const masked = String(value || '').trim().match(/^(\d{3})\*+(\d{4})$/);
  return Boolean(masked
    && expected.length === 11
    && expected.startsWith(masked[1])
    && expected.endsWith(masked[2]));
}

function walk(value, visit, path = []) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visit, [...path, String(index)]));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    visit(key, child, [...path, key]);
    walk(child, visit, [...path, key]);
  }
}

function parseMoney(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^\s*(?:CNY|RMB|￥|¥)?\s*(-?\d+(?:\.\d{1,2})?)\s*(?:元|CNY|RMB)?\s*$/i);
  return match ? Number(match[1]) : null;
}

export function extractUnicomWebBalance(payload, expectedPhone) {
  const balances = [];
  const accounts = [];
  const dataList = payload?.resource?.dataList;
  if (Array.isArray(dataList)) {
    dataList.forEach((item, index) => {
      if (item?.remainTitle !== '剩余话费' || item?.unit !== '元') return;
      const amount = parseMoney(item.number);
      if (amount != null) {
        balances.push({ amount, path: `resource.dataList.${index}.number` });
      }
    });
  }
  walk(payload, (key, value, path) => {
    const normalized = normalizedKey(key);
    if (BALANCE_KEYS.has(normalized)) {
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
    account_number: expectedPhone,
    balance_path: balances[0].path,
    account_path: account.path,
  };
}
