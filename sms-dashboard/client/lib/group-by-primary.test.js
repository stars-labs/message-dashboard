import { test, expect } from 'bun:test';
import { groupByPrimary } from './group-by-primary.js';

const sim = (over) => ({ sim_role: 'standalone', primary_iccid: null, ...over });

test('all standalone: order unchanged, all depth 0', () => {
  const items = [
    sim({ iccid: 'A', sim_index: 1 }),
    sim({ iccid: 'B', sim_index: 2 }),
    sim({ iccid: 'C', sim_index: 3 }),
  ];
  const out = groupByPrimary(items);
  expect(out.map((r) => r.iccid)).toEqual(['A', 'B', 'C']);
  expect(out.every((r) => r.__depth === 0 && !r.__isSecondary)).toBe(true);
});

test('one primary two secondaries: secondaries follow primary, depth 1', () => {
  const items = [
    sim({ iccid: 'S1', sim_index: 2, sim_role: 'secondary', primary_iccid: 'P' }),
    sim({ iccid: 'P',  sim_index: 1, sim_role: 'primary' }),
    sim({ iccid: 'S2', sim_index: 3, sim_role: 'secondary', primary_iccid: 'P' }),
    sim({ iccid: 'X',  sim_index: 4 }),
  ];
  const out = groupByPrimary(items);
  expect(out.map((r) => r.iccid)).toEqual(['P', 'S1', 'S2', 'X']);
  const depths = Object.fromEntries(out.map((r) => [r.iccid, r.__depth]));
  expect(depths).toEqual({ P: 0, S1: 1, S2: 1, X: 0 });
  expect(out.find((r) => r.iccid === 'S1').__isSecondary).toBe(true);
  expect(out.find((r) => r.iccid === 'P').__isSecondary).toBe(false);
});

test('orphan secondary (primary not in set) renders at depth 0', () => {
  const items = [
    sim({ iccid: 'S', sim_index: 2, sim_role: 'secondary', primary_iccid: 'GONE' }),
    sim({ iccid: 'A', sim_index: 1 }),
  ];
  const out = groupByPrimary(items);
  expect(out.map((r) => r.iccid)).toEqual(['S', 'A']);
  expect(out.find((r) => r.iccid === 'S').__depth).toBe(0);
  expect(out.find((r) => r.iccid === 'S').__isSecondary).toBe(false);
});

test('balance-page shape: resolve through row.phone, preserve row payload', () => {
  const rows = [
    { phone: sim({ iccid: 'P', sim_index: 1, sim_role: 'primary' }), checks: [] },
    { phone: sim({ iccid: 'S', sim_index: 2, sim_role: 'secondary', primary_iccid: 'P' }), checks: [{ id: 9 }] },
  ];
  const out = groupByPrimary(rows, (row) => row.phone);
  expect(out.map((r) => r.phone.iccid)).toEqual(['P', 'S']);
  // The balance row's own payload (checks) survives the spread.
  expect(out.find((r) => r.phone.iccid === 'S').checks).toEqual([{ id: 9 }]);
  expect(out.find((r) => r.phone.iccid === 'S').__depth).toBe(1);
});

test('empty and null input', () => {
  expect(groupByPrimary([])).toEqual([]);
  expect(groupByPrimary(null)).toEqual([]);
  expect(groupByPrimary(undefined)).toEqual([]);
});
