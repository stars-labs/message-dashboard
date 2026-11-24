// bun run screenshots -- --out <dir>: needs a running dev server; signs in with a
// short-lived admin session written to local KV and deleted afterwards.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type BrowserContext } from 'playwright-core';
import type { View } from '../shared/views.ts';
import { renderReport, type PageCapture, type Viewport } from './page-report.ts';
import { sessionRecord, signedIn, visit, VIEWPORT_ORDER, VIEWPORTS, VIEWS } from './page-visit.ts';

const SESSION_TTL_S = 30 * 60;
const ADMIN_ROLE = 'sms-admin';

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

async function capture(
  context: BrowserContext,
  view: View,
  viewport: Viewport,
): Promise<PageCapture> {
  const { page, issues, finalHash } = await visit(context, baseUrl, view, viewport);
  const file = `${view}-${viewport}.png`;
  // Viewport only: on mobile the page itself scrolls, so a full-page shot of a long
  // message list is tens of thousands of pixels.
  await page.screenshot({ path: join(out, file) });
  await page.close();
  return { view, viewport, file, finalHash, issues };
}

await mkdir(out, { recursive: true });

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
  sessionRecord('screenshots|local', [ADMIN_ROLE], SESSION_TTL_S),
]);

// The repo installs no headless shell, so launch the full Chromium build.
const browser = await chromium.launch({ channel: 'chromium' });
const captures: PageCapture[] = [];
try {
  const context = await browser.newContext({ deviceScaleFactor: 2, viewport: VIEWPORTS.desktop });
  await context.addCookies([{ name: 'auth_token', value: token, url: baseUrl, httpOnly: true }]);
  if (!(await signedIn(context, baseUrl))) {
    throw new Error(
      "the local session was not accepted; is dev-server using this checkout's .wrangler state?",
    );
  }
  for (const view of VIEWS) {
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
