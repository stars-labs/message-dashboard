// Screenshots every dashboard view at desktop and mobile width against a running
// dev server, and writes report.html beside the images with what the browser
// reported on each page. Login is a human step: when the profile has no session,
// a visible window opens on /login and the run waits for the operator.
//
//   bun run screenshots -- --profile <dir outside the repo> --out <dir>
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { isView, VIEW_PERMISSION } from '../shared/views.ts';
import { renderReport, type PageCapture, type PageIssue, type Viewport } from './page-report.ts';

const VIEWPORT_ORDER: Viewport[] = ['desktop', 'mobile'];

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 440, height: 900 },
} as const satisfies Record<Viewport, { width: number; height: number }>;

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const SETTLE_TIMEOUT_MS = 15_000;

const { values } = parseArgs({
  options: {
    'base-url': { type: 'string', default: 'http://localhost:8080' },
    profile: { type: 'string' },
    out: { type: 'string' },
  },
});
function required(value: string | undefined, flag: string): string {
  if (value === undefined) {
    throw new Error(`missing --${flag}; usage: bun run screenshots -- --profile <dir> --out <dir>`);
  }
  return value;
}

const baseUrl = values['base-url'];
const profile = required(values.profile, 'profile');
const out = required(values.out, 'out');

function launch(headless: boolean): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profile, {
    // The full Chromium build, also headless: the repo installs no headless shell.
    channel: 'chromium',
    headless,
    deviceScaleFactor: 2,
    viewport: VIEWPORTS.desktop,
  });
}

async function signedIn(context: BrowserContext): Promise<boolean> {
  const response = await context.request.get(`${baseUrl}/api/auth/me`);
  if (response.ok()) return true;
  if (response.status() === 401 || response.status() === 403) return false;
  throw new Error(`/api/auth/me answered ${String(response.status())}; is the dev server running?`);
}

async function waitForLogin(): Promise<void> {
  const context = await launch(false);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${baseUrl}/login`);
    console.log('Log in in the opened browser window; waiting up to 5 minutes.');
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (!(await signedIn(context))) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for login.');
      await page.waitForTimeout(2_000);
    }
  } finally {
    await context.close();
  }
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

async function capture(
  context: BrowserContext,
  view: string,
  viewport: Viewport,
): Promise<PageCapture> {
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
  const file = `${view}-${viewport}.png`;
  // The viewport, as the operator sees it: on mobile the page itself scrolls,
  // so a full-page shot of a long message list is tens of thousands of pixels.
  await page.screenshot({ path: join(out, file) });
  const finalHash = new URL(page.url()).hash;
  await page.close();
  return { view, viewport, file, finalHash, issues };
}

await mkdir(out, { recursive: true });

let context = await launch(true);
if (!(await signedIn(context))) {
  await context.close();
  await waitForLogin();
  context = await launch(true);
}

const captures: PageCapture[] = [];
try {
  for (const view of Object.keys(VIEW_PERMISSION).filter(isView)) {
    for (const viewport of VIEWPORT_ORDER) {
      const result = await capture(context, view, viewport);
      captures.push(result);
      console.log(`${result.file}: ${String(result.issues.length)} issues`);
    }
  }
} finally {
  await context.close();
}

const capturedAt = new Date().toISOString();
await writeFile(
  join(out, 'report.json'),
  JSON.stringify({ baseUrl, capturedAt, captures }, null, 2),
);
await writeFile(join(out, 'report.html'), renderReport(captures, { baseUrl, capturedAt }));
console.log(`Report: ${join(out, 'report.html')}`);
