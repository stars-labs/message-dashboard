import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CarrierWebBalanceJob } from '../../../../shared/api/carrier-web-balance.js';
import { errorText } from '../../../../shared/error-text.js';
import type { ControlClient } from '../control-client.js';
import type { CapabilityPresence } from '../presence.js';
import type { RunOutcome } from '../serial-runner.js';
import {
  createTemporaryChromePreferences,
  TEMPORARY_CHROME_ARGS,
} from './carrier-browser/chrome-profile.js';
import { createJobChannel } from './carrier-browser/job-channel.js';
import { simLabel, validateCarrierBrowserJob } from './carrier-browser/job-target.js';
import { loginM1, queryM1Balance } from './carrier-browser/m1-portal.js';
import type { BrowserContext, CarrierBalance, Logger, Page } from './carrier-browser/types.js';
import { runUnicomBalance } from './carrier-browser/unicom-portal.js';

interface BrowserLaunchOptions {
  executablePath: string;
  headless: false;
  viewport: { width: number; height: number };
  args: string[];
}

export interface BrowserLauncher {
  launchPersistentContext(
    userDataDir: string,
    options: BrowserLaunchOptions,
  ): Promise<BrowserContext>;
}

export function createCarrierBrowserJobProcessor({
  controlClient,
  presence,
  runnerId,
  browser,
  executablePath,
  diagnosticsDirectory = join(tmpdir(), 'message-dashboard-browser-diagnostics'),
  logger = console,
}: {
  controlClient: ControlClient;
  presence?: CapabilityPresence | null;
  runnerId: string;
  browser: BrowserLauncher;
  executablePath: string;
  diagnosticsDirectory?: string;
  logger?: Logger;
}) {
  let activePage: Page | null = null;
  const channel = createJobChannel({ controlClient, presence, runnerId, logger });

  async function captureDiagnostics(
    job: CarrierWebBalanceJob,
    page: Page | undefined,
  ): Promise<string | null> {
    if (!page) return null;
    await mkdir(diagnosticsDirectory, { recursive: true });
    const base = join(diagnosticsDirectory, job.id.replace(/[^a-zA-Z0-9_-]/g, '_'));
    const details = {
      captured_at: new Date().toISOString(),
      url: page.url(),
      title: await page.title().catch(() => ''),
      visible_text: (
        await page
          .locator('body')
          .innerText()
          .catch(() => '')
      ).slice(0, 20_000),
      frames: page.frames().map((frame) => ({ name: frame.name(), url: frame.url() })),
    };
    await Promise.all([
      writeFile(`${base}.json`, `${JSON.stringify(details, null, 2)}\n`),
      page.screenshot({ path: `${base}.png`, fullPage: true }),
    ]);
    return base;
  }

  async function processJob(
    job: CarrierWebBalanceJob,
    { signal }: { signal?: AbortSignal | null } = {},
  ): Promise<RunOutcome> {
    const target = validateCarrierBrowserJob(job);
    if (signal?.aborted) throw new Error('Browser query cancelled');
    const profileDir = await mkdtemp(join(tmpdir(), 'carrier-balance-'));
    const defaultProfileDir = join(profileDir, 'Default');
    await mkdir(defaultProfileDir, { recursive: true });
    await writeFile(
      join(defaultProfileDir, 'Preferences'),
      JSON.stringify(createTemporaryChromePreferences()),
    );
    let context: BrowserContext | undefined;
    let page: Page | undefined;
    const closeOnAbort = () => {
      void context?.close().catch(() => undefined);
    };
    signal?.addEventListener('abort', closeOnAbort, { once: true });
    try {
      context = await browser.launchPersistentContext(profileDir, {
        executablePath,
        headless: false,
        viewport: { width: 1280, height: 900 },
        args: [...TEMPORARY_CHROME_ARGS],
      });
      if (signal?.aborted) throw new Error('Browser query cancelled');
      page = context.pages()[0] ?? (await context.newPage());
      activePage = page;
      let parsed: CarrierBalance;
      if (target.provider === 'unicom') {
        parsed = await runUnicomBalance({
          channel,
          diagnosticsDirectory,
          job,
          target,
          context,
          page,
        });
      } else {
        await loginM1(channel, job, page);
        parsed = await queryM1Balance(channel, job, target.balanceUrl, page);
      }
      await channel.complete(job, parsed);
      logger.log(`Stored carrier balance for ${simLabel(job)}.`);
      return { handled: true, retryDelay: 0 };
    } catch (error) {
      const diagnosticBase = await captureDiagnostics(job, page).catch(() => null);
      const terminal =
        /(?:timed out|does not prove|multiple candidate|recognized available-balance|exact SGD balance|validity date|HTTP|did not return JSON)/i.test(
          errorText(error),
        );
      if (terminal) await channel.fail(job, error);
      else await channel.release(job, error);
      logger.error(`Carrier web balance job ${job.id} failed: ${errorText(error)}`);
      if (diagnosticBase)
        logger.error(`Diagnostics saved to ${diagnosticBase}.json and ${diagnosticBase}.png`);
      const retryDelay = Math.max(10, job.skill.cooldown_seconds ?? 10) * 1_000;
      return { handled: true, retryDelay };
    } finally {
      signal?.removeEventListener('abort', closeOnAbort);
      activePage = null;
      await context?.close().catch(() => undefined);
      await rm(profileDir, { recursive: true, force: true });
    }
  }

  return Object.freeze({
    processJob,
    async showActiveBrowser(): Promise<boolean> {
      if (!activePage || activePage.isClosed()) return false;
      await activePage.bringToFront();
      return true;
    },
  });
}
