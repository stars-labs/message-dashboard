import { expect, test } from 'bun:test';
import { pollDelayMs } from './pace.js';

test('waits what the Worker says, held between one second and ten minutes', () => {
  expect(pollDelayMs({ 'x-poll-interval': '5' })).toBe(5_000);
  expect(pollDelayMs({ 'x-poll-interval': '0' })).toBe(1_000);
  expect(pollDelayMs({ 'x-poll-interval': '86400' })).toBe(600_000);
});
