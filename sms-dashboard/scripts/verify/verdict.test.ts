import { describe, expect, test } from 'bun:test';
import { verdict } from './verdict.ts';

describe('verify verdict', () => {
  test('passes a journey that finished with quiet pages', () => {
    expect(verdict({ error: null, pages: [{ label: 'desktop#1', issues: [] }] })).toEqual({
      ok: true,
      failures: [],
    });
  });

  test('fails on the journey error and on every page issue', () => {
    expect(
      verdict({
        error: 'toast never showed 482913',
        pages: [
          { label: 'desktop#1', issues: [{ kind: 'console', text: 'error: boom' }] },
          { label: 'mobile#2', issues: [{ kind: 'http', text: '500 GET /api/messages' }] },
        ],
      }),
    ).toEqual({
      ok: false,
      failures: [
        'journey: toast never showed 482913',
        'desktop#1 console: error: boom',
        'mobile#2 http: 500 GET /api/messages',
      ],
    });
  });
});
