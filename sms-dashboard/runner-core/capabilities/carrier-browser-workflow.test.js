import { describe, expect, test } from 'bun:test';
import {
  TEMPORARY_CHROME_ARGS,
  createCarrierBrowserJobProcessor,
  createTemporaryChromePreferences,
  isUnicomErrorPage,
  validateCarrierBrowserJob,
  validateUnicomBrowserJob,
  waitForFirstVisible,
} from './carrier-browser-workflow.js';

function validJob() {
  return {
    id: 'job-1',
    login_url: 'https://imgxx.client.10010.com/shengyuhuafeiwt2024/index.html#/',
    skill: {
      id: 'unicom-web-balance',
      query_origin: 'https://imgxx.client.10010.com',
      query_endpoint: 'https://www.10010.com/mall/service/query/userinfoquery',
    },
  };
}

describe('carrier browser workflow', () => {
  test('disables notifications and credential prompts in temporary profiles', () => {
    const preferences = createTemporaryChromePreferences();
    expect(preferences.credentials_enable_service).toBe(false);
    expect(preferences.profile.password_manager_enabled).toBe(false);
    expect(preferences.profile.default_content_setting_values.notifications).toBe(2);
    expect(TEMPORARY_CHROME_ARGS).toContain('--disable-notifications');
  });

  test('accepts only the approved official login and API origins', () => {
    expect(() => validateUnicomBrowserJob(validJob())).not.toThrow();
    for (const value of [
      'http://imgxx.client.10010.com/login',
      'https://imgxx.client.10010.com.evil.example/login',
      'https://evil.example/login',
    ]) {
      const job = validJob();
      job.login_url = value;
      expect(() => validateUnicomBrowserJob(job)).toThrow('approved carrier origin');
    }
  });

  test('accepts only the official M1 prepaid login and balance origins', () => {
    const job = {
      id: 'm1-job',
      login_url: 'https://mcardaccount.m1.com.sg/login',
      skill: {
        id: 'm1-prepaid-web-balance',
        balance_url: 'https://mcardaccount.m1.com.sg/balance',
      },
    };
    expect(() => validateCarrierBrowserJob(job)).not.toThrow();
    job.skill.balance_url = 'https://mcardaccount.m1.com.sg.evil.example/balance';
    expect(() => validateCarrierBrowserJob(job)).toThrow('approved carrier origin');
  });

  test('waits for React-rendered M1 controls instead of checking only once', async () => {
    let attempts = 0;
    const candidate = { isVisible: async () => true };
    const locator = {
      count: async () => {
        attempts += 1;
        return attempts >= 3 ? 1 : 0;
      },
      nth: () => candidate,
    };
    const waits = [];

    const found = await waitForFirstVisible(
      [locator],
      { waitForTimeout: async (milliseconds) => waits.push(milliseconds) },
      { timeoutMs: 1_000, pollMs: 0 },
    );

    expect(found).toBe(candidate);
    expect(attempts).toBe(3);
    expect(waits).toEqual([0, 0]);
  });

  test('waits for M1 validity placeholder text to become a real date', async () => {
    let attempts = 0;
    const candidate = {
      isVisible: async () => true,
      innerText: async () => {
        attempts += 1;
        return attempts >= 3 ? 'Valid Till 22 Sep 2026' : 'Valid Till NA';
      },
    };
    const locator = { count: async () => 1, nth: () => candidate };

    const found = await waitForFirstVisible(
      [locator],
      { waitForTimeout: async () => {} },
      {
        timeoutMs: 1_000,
        pollMs: 0,
        textPattern: /Valid\s+Till\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{4}/i,
      },
    );

    expect(found).toBe(candidate);
    expect(attempts).toBe(3);
  });

  test('cancels before opening a browser when the agent is stopping', async () => {
    let launched = false;
    const processor = createCarrierBrowserJobProcessor({
      controlClient: { request: async () => new Response(null, { status: 204 }) },
      presence: { set: async () => {} },
      runnerId: 'runner-1',
      browser: {
        launchPersistentContext: async () => {
          launched = true;
          throw new Error('must not launch');
        },
      },
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    const controller = new AbortController();
    controller.abort();

    await expect(processor.processJob(validJob(), { signal: controller.signal }))
      .rejects.toThrow('cancelled');
    expect(launched).toBe(false);
  });

  test('detects Unicom error page URLs', () => {
    expect(isUnicomErrorPage('https://imgxx.client.10010.com/shengyuhuafeiwt2024/index.html#/errorpage')).toBe(true);
    expect(isUnicomErrorPage('https://imgxx.client.10010.com/shengyuhuafeiwt2024/index.html#/Errorpage')).toBe(true);
    expect(isUnicomErrorPage('https://imgxx.client.10010.com/shengyuhuafeiwt2024/index.html#/')).toBe(false);
    expect(isUnicomErrorPage('https://imgxx.client.10010.com/shengyuhuafeiwt2024/index.html#/home')).toBe(false);
    expect(isUnicomErrorPage(null)).toBe(false);
    expect(isUnicomErrorPage('')).toBe(false);
  });

  test('reports that there is no verification window before a job starts', async () => {
    const processor = createCarrierBrowserJobProcessor({
      controlClient: { request: async () => new Response(null, { status: 204 }) },
      presence: { set: async () => {} },
      runnerId: 'runner-1',
      browser: { launchPersistentContext: async () => { throw new Error('must not launch'); } },
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });

    expect(await processor.showActiveBrowser()).toBe(false);
  });
});
