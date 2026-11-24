import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as v from 'valibot';
import type { CarrierWebBalanceJob } from '../../../../../shared/api/carrier-web-balance.js';
import { errorText } from '../../../../../shared/error-text.js';
import { parseJson } from '../../../../../shared/parse-json.js';
import { textOr } from '../../../../../shared/text.js';
import {
  extractUnicomWebBalance,
  UNICOM_BALANCE_FIELD,
} from '../../../../../shared/unicom-web-balance.js';
import type { JobChannel } from './job-channel.js';
import { humanVerificationSeconds, isUnicomErrorPage, simLabel } from './job-target.js';
import { firstVisible } from './locators.js';
import type {
  BrowserContext,
  CarrierBalance,
  CarrierTarget,
  LoginPanel,
  Page,
  PageResponse,
  Surface,
} from './types.js';

type UnicomTarget = Extract<CarrierTarget, { provider: 'unicom' }>;

const AuthenticatedBalanceBody = v.looseObject({
  [UNICOM_BALANCE_FIELD]: v.nonNullish(v.unknown()),
});

const CheckLoginBody = v.looseObject({
  isLogin: v.optional(v.unknown()),
  userInfo: v.optional(
    v.looseObject({ usernumber: v.optional(v.union([v.string(), v.number()])) }),
  ),
});

const JsonObject = v.looseObject({});

async function findRandomPasswordTab(page: Page): Promise<LoginPanel | null> {
  const contexts: Surface[] = [
    page,
    ...page.frames().filter((frame) => frame !== page.mainFrame()),
  ];
  for (const context of contexts) {
    const locator = await firstVisible([
      context.locator('#randomPwdTips'),
      context.getByText('随机密码登录', { exact: true }),
      context.getByText(/随机密码/),
    ]);
    if (locator) return { context, locator };
  }
  return null;
}

async function openLoginPanel(
  channel: JobChannel,
  job: CarrierWebBalanceJob,
  page: Page,
): Promise<LoginPanel | null> {
  let loginPanel = await findRandomPasswordTab(page);
  if (loginPanel) return loginPanel;

  const loginEntry = await firstVisible([
    page.getByRole('button', { name: /^(?:请)?登录$/ }),
    page.getByRole('link', { name: /^(?:请)?登录$/ }),
    page.getByText(/^(?:请)?登录$/, { exact: true }),
  ]);
  if (loginEntry) await loginEntry.click();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    loginPanel = await findRandomPasswordTab(page);
    if (loginPanel) return loginPanel;
    await page.waitForTimeout(500);
  }

  await channel.heartbeat(
    job,
    'human_verification_required',
    '联通登录遮罩已打开，但登录组件未加载；等待本机人工处理',
  );
  await channel.presence?.set('busy', job.id, 'human_verification_required');
  channel.logger.log(`${simLabel(job)} login panel needs attention in the open browser.`);
  const humanDeadline = Date.now() + humanVerificationSeconds(job) * 1000;
  let lastHeartbeat = Date.now();
  while (Date.now() < humanDeadline) {
    loginPanel = await findRandomPasswordTab(page);
    if (loginPanel) {
      await channel.heartbeat(job, 'leased');
      await channel.presence?.set('busy', job.id);
      return loginPanel;
    }
    if (Date.now() - lastHeartbeat >= 30_000) {
      await channel.heartbeat(
        job,
        'human_verification_required',
        '等待用户在本机浏览器恢复联通登录组件',
      );
      lastHeartbeat = Date.now();
    }
    await page.waitForTimeout(1_000);
  }
  return null;
}

async function activateRandomPasswordMode(loginPanel: LoginPanel): Promise<boolean> {
  const { context, locator } = loginPanel;
  const requestControl = context.locator('#randomCode');
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await locator.click().catch(() => undefined);
    if (await requestControl.isVisible().catch(() => false)) return true;
    await context.waitForTimeout(500);
  }
  return false;
}

async function login(channel: JobChannel, job: CarrierWebBalanceJob, page: Page): Promise<void> {
  await page.goto(job.login_url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(1_500);

  const loginPanel = await openLoginPanel(channel, job, page);
  if (!loginPanel) throw new Error('Could not find the random-password login tab');
  const loginContext = loginPanel.context;
  if (!(await activateRandomPasswordMode(loginPanel))) {
    throw new Error('Could not activate China Unicom random-password mode');
  }

  const phoneInput = await firstVisible([
    loginContext.locator('#userName'),
    loginContext.locator('input[placeholder*="手机号"]'),
    loginContext.locator('input[type="tel"]'),
  ]);
  if (!phoneInput) throw new Error('Could not find the China Unicom phone input');
  const localPhone = textOr(job.sim_number, '')
    .replace(/\D/g, '')
    .replace(/^86(?=1\d{10}$)/, '');
  if (!/^1\d{10}$/.test(localPhone))
    throw new Error('China Unicom account is not a valid mobile number');
  await phoneInput.fill(localPhone);

  const requestButton = await firstVisible([
    loginContext.locator('#randomCKCode'),
    loginContext.locator('#randomCode'),
    loginContext.getByRole('button', { name: /(?:获取|发送).*(?:随机密码|验证码)/ }),
    loginContext.getByText(/(?:获取|发送).*(?:随机密码|验证码)/),
  ]);
  if (!requestButton) throw new Error('Could not find the random-password request control');

  if (!job.otp_requested_at) {
    await channel.markOtpRequested(job);
    await requestButton.click();
  } else {
    channel.logger.log(`Reusing the existing login code request for ${simLabel(job)}.`);
  }
  const code = await channel.waitForOtp(job, page);

  const codeInput = await firstVisible([
    loginContext.locator('#userCK'),
    loginContext.locator('#userPwd'),
    loginContext.locator('input[placeholder*="随机密码"]'),
    loginContext.locator('input[placeholder*="验证码"]'),
    loginContext.locator('input[type="password"]'),
  ]);
  if (!codeInput) throw new Error('Could not find the random-password input');
  await codeInput.fill(code);
  const agreement = loginContext.locator('#checkAgree');
  if (
    (await agreement.isVisible().catch(() => false)) &&
    !(await agreement.isChecked().catch(() => false))
  ) {
    await agreement.check();
  }
  await channel.heartbeat(job, 'authenticating');

  const loginButton = await firstVisible([
    loginContext.locator('#login1'),
    loginContext.getByRole('button', { name: /^登\s*录$/ }),
    loginContext.getByText(/^登\s*录$/),
  ]);
  if (!loginButton) throw new Error('Could not find the China Unicom login button');
  await loginButton.click();
  await page.waitForTimeout(1_500);
  await channel.waitForChallengeCompletion(job, page);
}

async function queryBalance({
  channel,
  diagnosticsDirectory,
  job,
  target,
  context,
  nativeResponsePromise,
  sessionIdentityPromise,
  sessionIdentity,
}: {
  channel: JobChannel;
  diagnosticsDirectory: string;
  job: CarrierWebBalanceJob;
  target: UnicomTarget;
  context: BrowserContext;
  nativeResponsePromise: Promise<PageResponse | null>;
  sessionIdentityPromise: Promise<PageResponse | null>;
  sessionIdentity: () => string | null;
}): Promise<CarrierBalance> {
  await channel.heartbeat(job, 'querying');
  const nativeResponse = await nativeResponsePromise;
  await sessionIdentityPromise;

  // After login, Unicom sometimes redirects to #/errorpage while its backend is down;
  // release the job to retry later rather than fail it.
  const page = context.pages()[0];
  if (page && isUnicomErrorPage(page.url())) {
    throw new Error(
      'China Unicom balance service unavailable (redirected to error page); will retry',
    );
  }

  const response =
    nativeResponse ??
    (await context.request.post(`${target.queryEndpoint}?_=${Date.now()}`, {
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/x-www-form-urlencoded',
        origin: target.queryOrigin,
        referer: `${target.queryOrigin}/`,
      },
    }));
  const result = {
    status: response.status(),
    text: (await response.text()).slice(0, 1_000_000),
  };

  if (result.status < 200 || result.status >= 300) {
    throw new Error(`China Unicom balance endpoint returned HTTP ${result.status}`);
  }
  const parsedPayload = parseJson(result.text, v.unknown());
  if (!parsedPayload.ok) {
    throw new Error('China Unicom balance endpoint did not return JSON');
  }
  const payload = parsedPayload.value;
  // The balance payload carries no account number, so the session identity is merged in;
  // the extractor still matches it against the SIM.
  const payloadObject = v.safeParse(JsonObject, payload);
  const identity = sessionIdentity();
  const payloadWithIdentity = identity
    ? {
        ...(payloadObject.success ? payloadObject.output : {}),
        userInfo: { usernumber: identity },
      }
    : payload;
  try {
    return extractUnicomWebBalance(payloadWithIdentity, job.sim_number);
  } catch (error) {
    await mkdir(diagnosticsDirectory, { recursive: true });
    const responsePath = join(
      diagnosticsDirectory,
      `${job.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.response.json`,
    );
    await writeFile(responsePath, `${JSON.stringify(payload, null, 2)}\n`);
    throw new Error(`${errorText(error)}; response saved to ${responsePath}`, {
      cause: error,
    });
  }
}

export async function runUnicomBalance({
  channel,
  diagnosticsDirectory,
  job,
  target,
  context,
  page,
}: {
  channel: JobChannel;
  diagnosticsDirectory: string;
  job: CarrierWebBalanceJob;
  target: UnicomTarget;
  context: BrowserContext;
  page: Page;
}): Promise<CarrierBalance> {
  let sessionIdentity: string | null = null;
  // The portal calls this endpoint before login (logged-out payload) and again after.
  const nativeResponsePromise = page
    .waitForResponse(
      async (response) => {
        if (!response.url().startsWith(target.queryEndpoint)) return false;
        if (response.request().method() !== 'POST') return false;
        if (!response.ok()) return false;
        const body = await response.text().catch(() => '');
        return parseJson(body, AuthenticatedBalanceBody).ok;
      },
      { timeout: 120_000 },
    )
    .catch(() => null);
  const sessionIdentityPromise = page
    .waitForResponse(
      async (response) => {
        if (!response.url().includes('/mall/service/check/checklogin')) return false;
        if (!response.ok()) return false;
        const body = await response.text().catch(() => '');
        const parsedBody = parseJson(body, CheckLoginBody);
        if (!parsedBody.ok) return false;
        const usernumber = parsedBody.value.userInfo?.usernumber;
        if (!parsedBody.value.isLogin || !usernumber) return false;
        sessionIdentity = String(usernumber);
        return true;
      },
      { timeout: 120_000 },
    )
    .catch(() => null);
  await login(channel, job, page);
  return queryBalance({
    channel,
    diagnosticsDirectory,
    job,
    target,
    context,
    nativeResponsePromise,
    sessionIdentityPromise,
    sessionIdentity: () => sessionIdentity,
  });
}
