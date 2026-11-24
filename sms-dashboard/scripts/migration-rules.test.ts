import { describe, expect, test } from 'bun:test';
import { migrationViolations } from './migration-rules.ts';

const applied = [
  { name: '006_drop_phones_table.sql', sql: 'DROP TABLE phones;' },
  { name: '006_fix_normalization.sql', sql: 'SELECT 1;' },
  { name: '0011_add_daemon_health.sql', sql: 'SELECT 2;' },
  { name: '080_fix_unicom_balance_endpoint.sql', sql: 'SELECT 3;' },
];

describe('migrationViolations', () => {
  test('accepts the applied migrations unchanged, duplicate numbers included', () => {
    expect(migrationViolations(applied, applied)).toEqual([]);
  });

  test('accepts a new migration numbered above every applied one', () => {
    const current = [...applied, { name: '081_add_widgets.sql', sql: 'SELECT 4;' }];

    expect(migrationViolations(applied, current)).toEqual([]);
  });

  test('rejects a change to an applied migration', () => {
    const current = applied.map((file) =>
      file.name === '006_fix_normalization.sql' ? { ...file, sql: 'SELECT 9;' } : file,
    );

    expect(migrationViolations(applied, current)).toEqual([
      '006_fix_normalization.sql changed; an applied migration is never edited, add a new one.',
    ]);
  });

  test('rejects removing or renaming an applied migration', () => {
    const current = [
      ...applied.filter((file) => file.name !== '080_fix_unicom_balance_endpoint.sql'),
      { name: '081_fix_unicom_balance_endpoint.sql', sql: 'SELECT 3;' },
    ];

    expect(migrationViolations(applied, current)).toEqual([
      '080_fix_unicom_balance_endpoint.sql was removed; an applied migration stays.',
    ]);
  });

  test('rejects a new migration that does not number above the applied ones', () => {
    const current = [...applied, { name: '080_again.sql', sql: 'SELECT 5;' }];

    expect(migrationViolations(applied, current)).toEqual([
      '080_again.sql must be numbered above 080.',
    ]);
  });

  test('rejects two new migrations with one number', () => {
    const current = [
      ...applied,
      { name: '081_one.sql', sql: 'SELECT 5;' },
      { name: '081_two.sql', sql: 'SELECT 6;' },
    ];

    expect(migrationViolations(applied, current)).toEqual([
      '081_two.sql reuses number 081 (081_one.sql).',
    ]);
  });

  test('rejects a new migration not named NNN_snake_case.sql', () => {
    const current = [
      ...applied,
      { name: '0081_four_digits.sql', sql: 'SELECT 5;' },
      { name: '082b_suffix.sql', sql: 'SELECT 6;' },
      { name: '083_Mixed-Case.sql', sql: 'SELECT 7;' },
    ];

    expect(migrationViolations(applied, current)).toEqual([
      '0081_four_digits.sql must be named NNN_snake_case.sql.',
      '082b_suffix.sql must be named NNN_snake_case.sql.',
      '083_Mixed-Case.sql must be named NNN_snake_case.sql.',
    ]);
  });
});
