import { describe, expect, test } from 'bun:test';
import { auditViolations, type Advisory } from './audit-rules.ts';

const glob: Advisory = {
  ghsa: 'GHSA-5j98-mcp5-4vw2',
  pkg: 'glob',
  severity: 'high',
  title: 'glob CLI: Command injection via -c/--cmd',
};

describe('auditViolations', () => {
  test('accepts an advisory recorded with a reason', () => {
    expect(
      auditViolations([glob], { 'GHSA-5j98-mcp5-4vw2': 'We never run the glob CLI.' }),
    ).toEqual([]);
  });

  test('rejects an advisory nobody has accepted', () => {
    expect(auditViolations([glob], {})).toEqual([
      'high glob GHSA-5j98-mcp5-4vw2: glob CLI: Command injection via -c/--cmd',
    ]);
  });

  test('rejects an accepted advisory that is no longer reported', () => {
    expect(auditViolations([], { 'GHSA-5j98-mcp5-4vw2': 'We never run the glob CLI.' })).toEqual([
      'GHSA-5j98-mcp5-4vw2 is accepted but no longer reported; remove it from ACCEPTED.',
    ]);
  });

  test('reports an advisory once, though several versions of the package match it', () => {
    expect(auditViolations([glob, glob], {})).toHaveLength(1);
  });
});
