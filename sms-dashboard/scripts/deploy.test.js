import { describe, expect, test } from 'bun:test';
import { deployRefProblems } from './deploy.js';

const clean = { branch: 'main', dirty: false, head: 'abc1234', remoteHead: 'abc1234' };

describe('deployRefProblems', () => {
  test('a clean main that matches origin/main may deploy', () => {
    expect(deployRefProblems(clean)).toEqual([]);
  });

  test('rejects any branch other than main', () => {
    expect(deployRefProblems({ ...clean, branch: 'feat/x' })).toEqual([
      'on branch feat/x, production deploys only from main',
    ]);
  });

  test('rejects uncommitted changes', () => {
    expect(deployRefProblems({ ...clean, dirty: true })).toEqual([
      'working tree has uncommitted changes',
    ]);
  });

  test('rejects a main that differs from origin/main', () => {
    expect(deployRefProblems({ ...clean, remoteHead: 'def5678' })).toEqual([
      'HEAD abc1234 differs from origin/main def5678; push or pull first',
    ]);
  });

  test('reports every problem at once', () => {
    expect(deployRefProblems({ branch: 'dev', dirty: true, head: 'a', remoteHead: 'b' })).toHaveLength(3);
  });
});
