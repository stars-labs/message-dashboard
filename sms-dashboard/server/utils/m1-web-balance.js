const MONTHS = new Map([
  ['jan', 1], ['feb', 2], ['mar', 3], ['apr', 4],
  ['may', 5], ['jun', 6], ['jul', 7], ['aug', 8],
  ['sep', 9], ['oct', 10], ['nov', 11], ['dec', 12],
]);

function localSingaporeNumber(value) {
  return String(value || '').replace(/\D/g, '').replace(/^65(?=\d{8}$)/, '');
}

function parseValidityDate(value) {
  const match = String(value || '').trim().match(
    /\bvalid\s+till\s+(\d{1,2})\s+([a-z]{3})\s+(\d{4})\b/i,
  );
  if (!match) return null;
  const day = Number(match[1]);
  const month = MONTHS.get(match[2].toLocaleLowerCase());
  const year = Number(match[3]);
  if (!month) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function extractM1WebBalance({ accountText, balanceText, validityText } = {}, expectedPhone) {
  const expected = localSingaporeNumber(expectedPhone);
  if (!/^\d{8}$/.test(expected)) throw new Error('M1 balance task SIM is not a valid Singapore number');
  if (localSingaporeNumber(accountText) !== expected) {
    throw new Error('M1 portal does not prove the authenticated account number');
  }

  const balanceMatch = String(balanceText || '').trim().match(/^\$\s*(\d+(?:\.\d{1,2})?)$/);
  if (!balanceMatch) throw new Error('M1 portal does not contain an exact SGD balance');
  const balance = Number(balanceMatch[1]);
  if (!Number.isFinite(balance)) throw new Error('M1 portal SGD balance is invalid');

  const expiresAt = parseValidityDate(validityText);
  if (!expiresAt) throw new Error('M1 portal does not contain a valid validity date');

  return {
    balance,
    currency: 'SGD',
    account_number: expectedPhone,
    expires_at: expiresAt,
    balance_path: '.balanceAmt.maBalanceDiv',
    expiry_path: '.balanceForBox .brand-color',
    account_path: '.numberTxt',
  };
}
