// bun run verify -- --journey <file.ts> --out <dir>: runs one journey (see
// scripts/verify/journey.ts) against a fresh local stack (scripts/local-stack.ts)
// and the fake company AI, then tears both down. <out> keeps report.json, a
// screenshot of every page the journey opened, trace.zip and its evidence.
//
// bun run verify -- doctor: is this machine fit to run one?
import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Page } from 'playwright-core';
import * as v from 'valibot';
import { errorText } from '../shared/error-text.ts';
import { startFakeAI } from './e2e/fake-ai.ts';
import { startLocalStack } from './local-stack.ts';
import type { PageIssue, Viewport } from './page-report.ts';
import { recordIssues, VIEWPORTS } from './page-visit.ts';
import { startAgentSandbox, type AgentSandbox } from './verify/agent.ts';
import { launchAgentApp } from './verify/agent-app.ts';
import { daemonClient } from './verify/daemon.ts';
import { remoteBindings, strayKeychainServices, strayStacks } from './verify/doctor.ts';
import type { JourneyContext } from './verify/journey.ts';
import { verdict } from './verify/verdict.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { journey: { type: 'string' }, out: { type: 'string' } },
});

async function doctor(): Promise<number> {
  const ps = Bun.spawnSync(['ps', '-axo', 'pid=,command=']).stdout.toString();
  const leftovers = (await readdir(tmpdir())).filter(
    (name) => name.startsWith('sms-dashboard-stack-') || name.startsWith('sms-dashboard-agent-'),
  );
  // Attributes only: without -d, dump-keychain prints no secret.
  const keychain = Bun.spawnSync(['/usr/bin/security', 'dump-keychain']).stdout.toString();
  const checks: [string, string[]][] = [
    ['wrangler.toml binds nothing remote', remoteBindings(await Bun.file('wrangler.toml').text())],
    ['no stack process is still running', strayStacks(ps).map((pid) => `pid ${pid}`)],
    [
      'no stack or agent state is left in the temp dir',
      leftovers.map((name) => join(tmpdir(), name)),
    ],
    ['no agent Keychain items are left', strayKeychainServices(keychain)],
    [
      'Chromium is installed for Playwright',
      existsSync(chromium.executablePath()) ? [] : [chromium.executablePath()],
    ],
  ];
  for (const [check, problems] of checks) {
    console.log(`${problems.length === 0 ? 'ok  ' : 'FAIL'} ${check}`);
    for (const problem of problems) console.log(`     ${problem}`);
  }
  return checks.some(([, problems]) => problems.length > 0) ? 1 : 0;
}

const JourneyModule = v.object({ default: v.function() });

async function loadJourney(file: string): Promise<(context: JourneyContext) => unknown> {
  const module = v.safeParse(JourneyModule, await import(resolve(file)));
  if (!module.success) throw new Error(`${file} must default-export a journey function`);
  return module.output.default;
}

async function verify(journeyFile: string, out: string): Promise<number> {
  const journey = await loadJourney(journeyFile);
  await mkdir(out, { recursive: true });

  const pages: { label: string; page: Page; issues: PageIssue[] }[] = [];
  const agents: AgentSandbox[] = [];
  const apps: { close: () => Promise<{ forced: boolean }> }[] = [];
  const notes: string[] = [];
  const evidence: string[] = [];
  const teardown: string[] = [];
  let error: string | null = null;

  // Teardown keeps going past a failure, so the report is always written.
  async function attempt(label: string, step: () => Promise<unknown>): Promise<void> {
    try {
      await step();
    } catch (caught) {
      teardown.push(`${label}: ${errorText(caught)}`);
    }
  }

  function track(label: string, page: Page): Page {
    const issues: PageIssue[] = [];
    recordIssues(page, issues);
    pages.push({ label: `${label}#${String(pages.length + 1)}`, page, issues });
    return page;
  }

  const ai = startFakeAI();
  const stack = await startLocalStack().catch(async (caught: unknown) => {
    await ai.stop();
    throw caught;
  });
  try {
    // The repo installs no headless shell, so launch the full Chromium build.
    const browser = await chromium.launch({ channel: 'chromium' });
    try {
      const context = await browser.newContext({
        viewport: VIEWPORTS.desktop,
        permissions: ['clipboard-read', 'clipboard-write'],
      });
      await context.addCookies([
        { name: 'auth_token', value: stack.token, url: stack.baseUrl, httpOnly: true },
      ]);
      await context.tracing.start({ screenshots: true, snapshots: true });
      try {
        await journey({
          stack,
          ai,
          out,
          daemon: daemonClient(stack.baseUrl, stack.apiKey),
          async agent() {
            const sandbox = await startAgentSandbox();
            agents.push(sandbox);
            return sandbox;
          },
          async agentApp() {
            const launched = await launchAgentApp();
            apps.push(launched);
            return {
              app: launched.app,
              userData: launched.userData,
              open: async () => track('agent-app', await launched.open()),
            };
          },
          async page(viewport: Viewport = 'desktop') {
            const page = await context.newPage();
            await page.setViewportSize(VIEWPORTS[viewport]);
            return track(viewport, page);
          },
          async evidence(name, data) {
            await writeFile(join(out, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);
            evidence.push(`${name}.json`);
          },
        });
      } catch (caught) {
        error = errorText(caught);
      }
      for (const { label, page } of pages) {
        if (!page.isClosed()) {
          await attempt(`screenshot ${label}`, () =>
            page.screenshot({ path: join(out, `${label}.png`) }),
          );
        }
      }
      await attempt('trace', () => context.tracing.stop({ path: join(out, 'trace.zip') }));
    } finally {
      for (const app of apps) {
        await attempt('Balance Agent app', async () => {
          if ((await app.close()).forced) {
            notes.push('the Balance Agent app did not quit within 10s and was killed');
          }
        });
      }
      await attempt('browser', () => browser.close());
    }
  } finally {
    for (const sandbox of agents) await attempt('Balance Agent sandbox', () => sandbox.stop());
    await attempt('fake AI', () => ai.stop());
    await attempt('stack', () => stack.stop());
  }

  const result = verdict({
    error,
    pages: pages.map(({ label, issues }) => ({ label, issues })),
    teardown,
  });
  await writeFile(
    join(out, 'report.json'),
    `${JSON.stringify({ journey: resolve(journeyFile), ...result, notes, evidence, aiPrompts: ai.prompts }, null, 2)}\n`,
  );
  for (const note of notes) console.error(`NOTE ${note}`);
  for (const failure of result.failures) console.error(`FAIL ${failure}`);
  console.log(`${result.ok ? 'PASS' : 'FAIL'} ${journeyFile} — evidence in ${out}/`);
  return result.ok ? 0 : 1;
}

if (positionals[0] === 'doctor') {
  process.exit(await doctor());
}
if (values.journey === undefined || values.out === undefined) {
  throw new Error(
    'usage: bun run verify -- --journey <file.ts> --out <dir> | bun run verify -- doctor',
  );
}
process.exit(await verify(values.journey, values.out));
