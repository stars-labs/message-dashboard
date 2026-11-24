// bun run screenshots -- --out <dir>: needs a running dev server; signs in with a
// short-lived admin session written to local KV and deleted afterwards.
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

const SESSION_TTL_S = 30 * 60;
const ADMIN_ROLE = 'sms-admin';
const SETTLE_TIMEOUT_MS = 15_000;

const { values } = parseArgs({
  options: {
    'base-url': { type: 'string', default: 'http://localhost:8080' },
    out: { type: 'string' },
  },
});
function required(value: string | undefined, flag: string): string {
  if (value === undefined) {
    throw new Error(`missing --${flag}; usage: bun run screenshots -- --out <dir>`);
  }
  return value;
}

const baseUrl = values['base-url'];
const out = required(values.out, 'out');

async function wrangler(args: string[]): Promise<void> {
  const proc = Bun.spawn(['bunx', 'wrangler', ...args], { stdout: 'ignore', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(
      `wrangler ${args.slice(0, 3).join(' ')} failed: ${await new Response(proc.stderr).text()}`,
    );
  }
}

async function signedIn(context: BrowserContext): Promise<boolean> {
  const response = await context.request.get(`${baseUrl}/api/auth/me`);
  if (response.ok()) return true;
  if (response.status() === 401 || response.status() === 403) return false;
  throw new Error(`/api/auth/me answered ${String(response.status())}; is the dev server running?`);
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
  // Viewport only: on mobile the page itself scrolls, so a full-page shot of a long
  // message list is tens of thousands of pixels.
  await page.screenshot({ path: join(out, file) });
  const finalHash = new URL(page.url()).hash;
  await page.close();
  return { view, viewport, file, finalHash, issues };
}

await mkdir(out, { recursive: true });

// Written straight into the local SESSIONS namespace, shaped like the Auth0 callback's.
const token = `screenshots-${crypto.randomUUID()}`;
await wrangler([
  'kv',
  'key',
  'put',
  '--binding',
  'SESSIONS',
  '--local',
  '--ttl',
  String(SESSION_TTL_S),
  token,
  JSON.stringify({
    user: {
      id: 'screenshots|local',
      email: 'screenshots@localhost',
      name: 'Screenshots',
      roles: [ADMIN_ROLE],
    },
    expires_at: Date.now() + SESSION_TTL_S * 1000,
  }),
]);

// The repo installs no headless shell, so launch the full Chromium build.
const browser = await chromium.launch({ channel: 'chromium' });
const captures: PageCapture[] = [];
try {
  const context = await browser.newContext({ deviceScaleFactor: 2, viewport: VIEWPORTS.desktop });
  await context.addCookies([{ name: 'auth_token', value: token, url: baseUrl, httpOnly: true }]);
  if (!(await signedIn(context))) {
    throw new Error(
      "the local session was not accepted; is dev-server using this checkout's .wrangler state?",
    );
  }
  for (const view of Object.keys(VIEW_PERMISSION).filter(isView)) {
    for (const viewport of VIEWPORT_ORDER) {
      const result = await capture(context, view, viewport);
      captures.push(result);
      console.log(`${result.file}: ${String(result.issues.length)} issues`);
    }
  }
} finally {
  await browser.close();
  await wrangler(['kv', 'key', 'delete', '--binding', 'SESSIONS', '--local', token]);
}

const capturedAt = new Date().toISOString();
await writeFile(
  join(out, 'report.json'),
  JSON.stringify({ baseUrl, capturedAt, captures }, null, 2),
);
await writeFile(join(out, 'report.html'), renderReport(captures, { baseUrl, capturedAt }));
console.log(`Report: ${join(out, 'report.html')}`);
