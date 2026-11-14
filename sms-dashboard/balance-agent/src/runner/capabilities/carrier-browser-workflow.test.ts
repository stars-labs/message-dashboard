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
import type { CarrierWebBalanceJob } from '../../../../shared/api/carrier-web-balance.js';

function webJob(
  skill: CarrierWebBalanceJob['skill'],
  loginUrl: string,
  id = 'job-1',
): CarrierWebBalanceJob {
  return {
    id,
    check_id: 'check-1',
    sim_iccid: '8986000000000000001',
    sim_number: null,
    sim_index: 36,
    login_url: loginUrl,
    otp_requested_at: null,
    skill,
  };
}

function validJob(): CarrierWebBalanceJob {
  return webJob(
    {
      id: 'unicom-web-balance',
      query_origin: 'https://imgxx.client.10010.com',
      query_endpoint: 'https://www.10010.com/mall/service/query/userinfoquery',
    },
    'https://imgxx.client.10010.com/shengyuhuafeiwt2024/index.html#/',
  );
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
    const job = webJob(
      {
        id: 'm1-prepaid-web-balance',
        balance_url: 'https://mcardaccount.m1.com.sg/balance',
      },
      'https://mcardaccount.m1.com.sg/login',
      'm1-job',
    );
    expect(() => validateCarrierBrowserJob(job)).not.toThrow();
    job.skill.balance_url = 'https://mcardaccount.m1.com.sg.evil.example/balance';
    expect(() => validateCarrierBrowserJob(job)).toThrow('approved carrier origin');
  });

  test('waits for React-rendered M1 controls instead of checking only once', async () => {
    let attempts = 0;
    const candidate = {
      isVisible: () => Promise.resolve(true),
      innerText: () => Promise.resolve(''),
    };
    const locator = {
      count: () => {
        attempts += 1;
        return Promise.resolve(attempts >= 3 ? 1 : 0);
      },
      nth: () => candidate,
    };
    const waits: number[] = [];

    const found = await waitForFirstVisible(
      [locator],
      {
        waitForTimeout: (milliseconds) => {
          waits.push(milliseconds);
          return Promise.resolve();
        },
      },
      { timeoutMs: 1_000, pollMs: 0 },
    );

    expect(found).toBe(candidate);
    expect(attempts).toBe(3);
    expect(waits).toEqual([0, 0]);
  });

  test('waits for M1 validity placeholder text to become a real date', async () => {
    let attempts = 0;
    const candidate = {
      isVisible: () => Promise.resolve(true),
      innerText: () => {
        attempts += 1;
        return Promise.resolve(attempts >= 3 ? 'Valid Till 22 Sep 2026' : 'Valid Till NA');
      },
    };
    const locator = { count: () => Promise.resolve(1), nth: () => candidate };

    const found = await waitForFirstVisible(
      [locator],
      { waitForTimeout: () => Promise.resolve() },
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
      controlClient: { request: () => Promise.resolve(new Response(null, { status: 204 })) },
      presence: { set: () => Promise.resolve() },
      runnerId: 'runner-1',
      browser: {
        launchPersistentContext: () => {
          launched = true;
          return Promise.reject(new Error('must not launch'));
        },
      },
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    const controller = new AbortController();
    controller.abort();

    const outcome = await processor.processJob(validJob(), { signal: controller.signal }).then(
      () => 'resolved',
      (error: unknown) => error,
    );
    expect(outcome).toEqual(new Error('Browser query cancelled'));
    expect(launched).toBe(false);
  });

  test('detects Unicom error page URLs', () => {
    expect(
      isUnicomErrorPage('https://imgxx.client.10010.com/shengyuhuafeiwt2024/index.html#/errorpage'),
    ).toBe(true);
    expect(
      isUnicomErrorPage('https://imgxx.client.10010.com/shengyuhuafeiwt2024/index.html#/Errorpage'),
    ).toBe(true);
    expect(
      isUnicomErrorPage('https://imgxx.client.10010.com/shengyuhuafeiwt2024/index.html#/'),
    ).toBe(false);
    expect(
      isUnicomErrorPage('https://imgxx.client.10010.com/shengyuhuafeiwt2024/index.html#/home'),
    ).toBe(false);
    expect(isUnicomErrorPage(null)).toBe(false);
    expect(isUnicomErrorPage('')).toBe(false);
  });

  test('reports that there is no verification window before a job starts', async () => {
    const processor = createCarrierBrowserJobProcessor({
      controlClient: { request: () => Promise.resolve(new Response(null, { status: 204 })) },
      presence: { set: () => Promise.resolve() },
      runnerId: 'runner-1',
      browser: {
        launchPersistentContext: () => Promise.reject(new Error('must not launch')),
      },
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });

    expect(await processor.showActiveBrowser()).toBe(false);
  });
});
