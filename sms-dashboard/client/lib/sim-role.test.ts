import { describe, expect, test } from 'bun:test';
import { getSimRoleLabel, SIM_ROLES } from './sim-role.js';

describe('SIM roles', () => {
  test('offers standalone, primary and secondary, in that order', () => {
    expect(SIM_ROLES.map((role) => role.value)).toEqual(['standalone', 'primary', 'secondary']);
  });

  test('labels each role', () => {
    expect(getSimRoleLabel('standalone')).toBe('独立');
    expect(getSimRoleLabel('primary')).toBe('主卡');
    expect(getSimRoleLabel('secondary')).toBe('副卡');
  });

  test('labels a missing or unknown role as standalone', () => {
    expect(getSimRoleLabel(null)).toBe('独立');
    expect(getSimRoleLabel(undefined)).toBe('独立');
    expect(getSimRoleLabel('tertiary')).toBe('独立');
  });
});
