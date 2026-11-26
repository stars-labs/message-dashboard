import { expect, test } from 'bun:test';
import { intervalMs, RECURRING, type RecurringName } from './recurring.js';

test('a client waits each call’s registered interval, in milliseconds', () => {
  const names = Object.keys(RECURRING).filter((key): key is RecurringName => key in RECURRING);

  expect(names.map(intervalMs)).toEqual(names.map((name) => RECURRING[name].everySeconds * 1000));
  expect(intervalMs('dashboardMessages')).toBe(60_000);
});
