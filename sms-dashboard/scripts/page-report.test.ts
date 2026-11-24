import { describe, expect, test } from 'bun:test';
import { renderReport, type PageCapture } from './page-report.ts';

const clean: PageCapture = {
  view: 'dashboard',
  viewport: 'desktop',
  file: 'dashboard-desktop.png',
  finalHash: '#dashboard',
  issues: [],
};

describe('renderReport', () => {
  test('shows every capture with its screenshot', () => {
    const html = renderReport(
      [clean, { ...clean, viewport: 'mobile', file: 'dashboard-mobile.png' }],
      {
        baseUrl: 'http://127.0.0.1:8080',
        capturedAt: '2026-11-14T12:00:00.000Z',
      },
    );

    expect(html).toContain('src="dashboard-desktop.png"');
    expect(html).toContain('src="dashboard-mobile.png"');
  });

  test('escapes page text so a captured message cannot inject markup', () => {
    const html = renderReport(
      [{ ...clean, issues: [{ kind: 'console', text: '<img src=x onerror=alert(1)>' }] }],
      { baseUrl: 'http://127.0.0.1:8080', capturedAt: '2026-11-14T12:00:00.000Z' },
    );

    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  test('flags a view that redirected away from its own route', () => {
    const html = renderReport([{ ...clean, view: 'users', finalHash: '#dashboard' }], {
      baseUrl: 'http://127.0.0.1:8080',
      capturedAt: '2026-11-14T12:00:00.000Z',
    });

    expect(html).toContain('redirected to #dashboard');
  });

  test('counts captures that have issues in the summary', () => {
    const html = renderReport(
      [
        clean,
        { ...clean, viewport: 'mobile', issues: [{ kind: 'http', text: '500 GET /api/phones' }] },
      ],
      { baseUrl: 'http://127.0.0.1:8080', capturedAt: '2026-11-14T12:00:00.000Z' },
    );

    expect(html).toContain('1 of 2 captures have issues');
  });
});
