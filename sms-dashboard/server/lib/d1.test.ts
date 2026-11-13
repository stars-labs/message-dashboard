import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { queryAll, queryFirst } from './d1.js';

const Row = v.object({ iccid: v.string(), sim_index: v.nullable(v.number()) });

function statement(rows: Record<string, unknown>[]) {
  return {
    all: () => Promise.resolve({ results: rows }),
    first: () => Promise.resolve(rows[0] ?? null),
  };
}

describe('queryAll', () => {
  test('returns every row parsed by the row schema', async () => {
    const rows = [
      { iccid: 'A', sim_index: 1 },
      { iccid: 'B', sim_index: null },
    ];
    expect(await queryAll(statement(rows), Row)).toEqual(rows);
  });

  test('throws when a row does not match, so a schema drift fails loudly', async () => {
    const rows = [{ iccid: 'A', sim_index: 1 }, { iccid: 7 }];
    let thrown: unknown;
    try {
      await queryAll(statement(rows), Row);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(v.ValiError);
  });
});

describe('queryFirst', () => {
  test('returns the first row parsed by the row schema', async () => {
    expect(await queryFirst(statement([{ iccid: 'A', sim_index: 2, extra: 'x' }]), Row)).toEqual({
      iccid: 'A',
      sim_index: 2,
    });
  });

  test('returns null when there is no row', async () => {
    expect(await queryFirst(statement([]), Row)).toBeNull();
  });

  test('throws when the row does not match', async () => {
    let thrown: unknown;
    try {
      await queryFirst(statement([{ iccid: 'A' }]), Row);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(v.ValiError);
  });
});
