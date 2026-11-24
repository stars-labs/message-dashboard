import type { BrowserContext, Page } from 'playwright-core';
import { isView, VIEW_PERMISSION, type View } from '../shared/views.ts';
import type { PageIssue, Viewport } from './page-report.ts';

export const VIEWPORT_ORDER: Viewport[] = ['desktop', 'mobile'];

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 440, height: 900 },
} as const satisfies Record<Viewport, { width: number; height: number }>;

const SETTLE_TIMEOUT_MS = 15_000;

export const VIEWS: View[] = Object.keys(VIEW_PERMISSION).filter(isView);

/** A session shaped like the one the Auth0 callback writes to SESSIONS. */
export function sessionRecord(id: string, roles: string[], ttlSeconds: number): string {
  return JSON.stringify({
    user: { id, email: `${id.replace(/\W/g, '-')}@example.test`, name: id, roles },
    expires_at: Date.now() + ttlSeconds * 1000,
  });
}

export async function signedIn(context: BrowserContext, baseUrl: string): Promise<boolean> {
  const response = await context.request.get(`${baseUrl}/api/auth/me`);
  if (response.ok()) return true;
  if (response.status() === 401 || response.status() === 403) return false;
  throw new Error(`/api/auth/me answered ${String(response.status())}; is the Worker running?`);
}

function recordIssues(page: Page, issues: PageIssue[]): void {
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      issues.push({ kind: 'console', text: `${message.type()}: ${message.text()}` });
    }
  });
  page.on('pageerror', (error) => {
    issues.push({ kind: 'pageerror', text: error.message });
  });
  page.on('requestfailed', (request) => {
    issues.push({
      kind: 'requestfailed',
      text: `${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`,
    });
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      issues.push({
        kind: 'http',
        text: `${String(response.status())} ${response.request().method()} ${response.url()}`,
      });
    }
  });
}

export interface Visit {
  page: Page;
  issues: PageIssue[];
  finalHash: string;
}

/** Opens `#view` at the viewport and waits for the network to go quiet; the caller closes the page. */
export async function visit(
  context: BrowserContext,
  baseUrl: string,
  view: View,
  viewport: Viewport,
): Promise<Visit> {
  const page = await context.newPage();
  const issues: PageIssue[] = [];
  recordIssues(page, issues);
  await page.setViewportSize(VIEWPORTS[viewport]);
  await page.goto(`${baseUrl}/#${view}`);
  try {
    await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS });
  } catch {
    issues.push({
      kind: 'settle',
      text: `network still busy after ${String(SETTLE_TIMEOUT_MS)} ms`,
    });
  }
  return { page, issues, finalHash: new URL(page.url()).hash };
}
