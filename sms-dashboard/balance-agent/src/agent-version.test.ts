import { describe, expect, test } from 'bun:test';
import { isNewerAgentVersion } from './agent-version.js';

describe('Balance Agent version comparison', () => {
  test.each([
    ['0.1.5', '0.1.4', true],
    ['0.2.0', '0.1.9', true],
    ['0.10.0', '0.9.9', true],
    ['1.0.0', '0.99.99', true],
    ['0.1.4', '0.1.4', false],
    ['0.1.3', '0.1.4', false],
    ['0.1.5', 'development', false],
    ['beta', '0.1.4', false],
  ])('%s is newer than %s: %p', (candidate, current, newer) => {
    expect(isNewerAgentVersion(candidate, current)).toBe(newer);
  });
});
