// bun run e2e [-- --out <dir>]: every view, at desktop and mobile width, against
// the local stack (scripts/local-stack.ts). A view fails on any console error or
// warning, page error, failed or 4xx/5xx request, a redirect away from it, or
// (mobile) horizontal overflow.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import * as v from 'valibot';
import type { PageIssue } from './page-report.ts';
import { signedIn, visit, VIEWPORT_ORDER, VIEWPORTS, VIEWS } from './page-visit.ts';
import { startLocalStack } from './local-stack.ts';

const { values } = parseArgs({ options: { out: { type: 'string', default: 'e2e-results' } } });
const out = values.out;

const stack = await startLocalStack();
const failures: string[] = [];

try {
  await mkdir(out, { recursive: true });
  // The repo installs no headless shell, so launch the full Chromium build.
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const context = await browser.newContext({ viewport: VIEWPORTS.desktop });
    const login = await context.newPage();
    const landing = await login.goto(`${stack.baseUrl}/login`);
    if (!landing?.ok() || login.url() !== `${stack.baseUrl}/`) {
      throw new Error(
        `browser login ended on ${new URL(login.url()).pathname} (${String(landing?.status())})`,
      );
    }
    await login.close();
    if (!(await signedIn(context, stack.baseUrl))) {
      throw new Error('the session created by browser login was not accepted');
    }

    for (const view of VIEWS) {
      for (const viewport of VIEWPORT_ORDER) {
        const { page, issues, finalHash } = await visit(context, stack.baseUrl, view, viewport);
        const problems: PageIssue[] = [...issues];
        if (finalHash !== `#${view}`) {
          problems.push({ kind: 'route', text: `ended on ${finalHash || '(no hash)'}` });
        }
        if (viewport === 'mobile') {
          const overflow = v.parse(
            v.number(),
            await page.evaluate(
              'document.documentElement.scrollWidth - document.documentElement.clientWidth',
            ),
          );
          if (overflow > 0) {
            problems.push({ kind: 'route', text: `scrolls ${String(overflow)}px sideways` });
          }
        }
        const name = `${view}-${viewport}`;
        await page.screenshot({ path: join(out, `${name}.png`) });
        if (problems.length > 0) {
          failures.push(`${name}:\n${problems.map((p) => `  ${p.kind}: ${p.text}`).join('\n')}`);
        }
        console.log(`${problems.length === 0 ? 'ok  ' : 'FAIL'} ${name}`);
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
} finally {
  await stack.stop();
}

if (failures.length > 0) {
  console.error(`\n${failures.join('\n\n')}\n\nScreenshots: ${out}/`);
  process.exit(1);
}
console.log(`\nAll ${String(VIEWS.length * VIEWPORT_ORDER.length)} view checks passed.`);
