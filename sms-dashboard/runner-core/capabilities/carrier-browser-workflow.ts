import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as v from 'valibot';
import {
  CarrierWebBalanceOtpResponse,
  type CarrierWebBalanceJob,
} from '../../shared/api/carrier-web-balance.js';
import type { ActiveWebJobStatus } from '../../shared/balance-status.js';
import { parseJson, readJson } from '../../shared/parse-json.js';
import { textOr } from '../../shared/text.js';
import { SuccessResponse } from '../../shared/api/success.js';
import {
  extractUnicomWebBalance,
  UNICOM_BALANCE_FIELD,
} from '../../server/utils/unicom-web-balance.js';
import { extractM1WebBalance } from '../../server/utils/m1-web-balance.js';
import type { ControlClient } from '../control-client.js';
import { errorMessage } from '../error-message.js';
import type { CapabilityPresence } from '../presence.js';
import { numberOr } from '../number-or.js';
import { abortableSleep, type RunOutcome } from '../serial-runner.js';

const LOGIN_ORIGIN = 'https://imgxx.client.10010.com';
const QUERY_ORIGIN = 'https://www.10010.com';
// The portal moved its read-only balance call off www.10010.com to
// mxx.client.10010.com. The old host stays allowed so an in-flight profile still
// validates; both are carrier-controlled and only ever receive the balance request.
const BALANCE_API_ORIGINS = Object.freeze([QUERY_ORIGIN, 'https://mxx.client.10010.com']);
const M1_ORIGIN = 'https://mcardaccount.m1.com.sg';

interface Candidate {
  isVisible(): Promise<boolean>;
  innerText(): Promise<string>;
}

interface CandidateList<C extends Candidate> {
  count(): Promise<number>;
  nth(index: number): C;
}

interface Locator extends Candidate, CandidateList<Locator> {
  click(): Promise<void>;
  fill(text: string): Promise<void>;
  check(): Promise<void>;
  isChecked(): Promise<boolean>;
}

interface Waiter {
  waitForTimeout(milliseconds: number): Promise<void>;
}

interface Surface extends Waiter {
  locator(selector: string): Locator;
  getByText(text: string | RegExp, options?: { exact?: boolean }): Locator;
  getByRole(role: 'button' | 'link', options: { name: RegExp }): Locator;
}

interface Frame extends Surface {
  name(): string;
  url(): string;
}

interface ApiResponse {
  status(): number;
  text(): Promise<string>;
}

interface PageResponse extends ApiResponse {
  url(): string;
  ok(): boolean;
  request(): { method(): string };
}

interface Page extends Surface {
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  frames(): Frame[];
  mainFrame(): Frame;
  screenshot(options: { path: string; fullPage: boolean }): Promise<unknown>;
  waitForResponse(
    predicate: (response: PageResponse) => Promise<boolean>,
    options: { timeout: number },
  ): Promise<PageResponse>;
  isClosed(): boolean;
  bringToFront(): Promise<void>;
}

interface BrowserContext {
  pages(): Page[];
  newPage(): Promise<Page>;
  close(): Promise<void>;
  request: {
    post(url: string, options: { headers: UnicomRequestHeaders }): Promise<ApiResponse>;
  };
}

interface UnicomRequestHeaders {
  accept: string;
  'content-type': string;
  origin: string;
  referer: string;
}

interface BrowserLaunchOptions {
  executablePath: string;
  headless: false;
  viewport: { width: number; height: number };
  args: readonly string[];
}

interface BrowserLauncher {
  launchPersistentContext(
    userDataDir: string,
    options: BrowserLaunchOptions,
  ): Promise<BrowserContext>;
}

interface Logger {
  log(message: string): void;
  error(message: string): void;
}

interface LoginPanel {
  context: Surface;
  locator: Locator;
}

type CarrierBalance =
  ReturnType<typeof extractM1WebBalance> | ReturnType<typeof extractUnicomWebBalance>;

type CarrierTarget =
  | { provider: 'unicom'; queryOrigin: string; queryEndpoint: string }
  | { provider: 'm1'; balanceUrl: string };

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

export function createTemporaryChromePreferences() {
  return {
    credentials_enable_service: false,
    profile: {
      password_manager_enabled: false,
      default_content_setting_values: {
        notifications: 2,
      },
    },
    autofill: {
      profile_enabled: false,
      credit_card_enabled: false,
    },
  };
}

export const TEMPORARY_CHROME_ARGS = Object.freeze([
  '--disable-notifications',
  '--disable-save-password-bubble',
  '--disable-features=PasswordManagerOnboarding,PasswordManagerRedesign,PasswordGeneration',
]);

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function simLabel(job: CarrierWebBalanceJob): string {
  return `S${String(job.sim_index).padStart(2, '0')}`;
}

function humanVerificationSeconds(job: CarrierWebBalanceJob): number {
  return numberOr(job.skill.human_verification_timeout_seconds, 900);
}

function assertOfficialUrlIn(value: unknown, allowedOrigins: readonly string[], label: string) {
  let url: URL;
  try {
    url = new URL(textOf(value));
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (!allowedOrigins.includes(url.origin)) {
    throw new Error(`${label} must use an approved carrier origin`);
  }
  return url.toString();
}

function assertOfficialUrl(value: unknown, expectedOrigin: string, label: string) {
  return assertOfficialUrlIn(value, [expectedOrigin], label);
}

export function validateUnicomBrowserJob(job: CarrierWebBalanceJob): CarrierTarget {
  assertOfficialUrl(job.login_url, LOGIN_ORIGIN, 'Login URL');
  assertOfficialUrl(job.skill.query_origin, LOGIN_ORIGIN, 'Query page origin');
  assertOfficialUrlIn(job.skill.query_endpoint, BALANCE_API_ORIGINS, 'Balance endpoint');
  return {
    provider: 'unicom',
    queryOrigin: textOf(job.skill.query_origin),
    queryEndpoint: textOf(job.skill.query_endpoint),
  };
}

export function validateCarrierBrowserJob(job: CarrierWebBalanceJob): CarrierTarget {
  if (job.skill.id === 'unicom-web-balance') return validateUnicomBrowserJob(job);
  if (job.skill.id !== 'm1-prepaid-web-balance') {
    throw new Error('Carrier browser job uses an unsupported skill');
  }
  assertOfficialUrl(job.login_url, M1_ORIGIN, 'Login URL');
  assertOfficialUrl(job.skill.balance_url, M1_ORIGIN, 'Balance URL');
  return { provider: 'm1', balanceUrl: textOf(job.skill.balance_url) };
}

export function isUnicomErrorPage(url: string | null): boolean {
  return /[#/]errorpage/i.test(url ?? '');
}

async function firstVisible<C extends Candidate>(
  candidates: readonly CandidateList<C>[],
  textPattern: RegExp | null = null,
): Promise<C | null> {
  for (const locator of candidates) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      if (!textPattern) return candidate;
      const candidateText = await candidate.innerText().catch(() => '');
      textPattern.lastIndex = 0;
      if (textPattern.test(candidateText)) return candidate;
    }
  }
  return null;
}

export async function waitForFirstVisible<C extends Candidate>(
  candidates: readonly CandidateList<C>[],
  page: Waiter,
  {
    timeoutMs = 30_000,
    pollMs = 250,
    textPattern = null,
  }: { timeoutMs?: number; pollMs?: number; textPattern?: RegExp | null } = {},
): Promise<C | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const candidate = await firstVisible(candidates, textPattern);
    if (candidate) return candidate;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await page.waitForTimeout(Math.min(pollMs, remaining));
  }
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
  // The authenticated account the portal reported for the current task. Set by
  // the checklogin interception, read by queryBalance.
  let sessionIdentity: string | null = null;

  async function postJob(
    job: CarrierWebBalanceJob,
    action: 'otp-requested' | 'heartbeat' | 'complete' | 'fail' | 'release',
    body: object = {},
  ): Promise<void> {
    const response = await controlClient.request(
      `/api/control/carrier-web-balance/jobs/${encodeURIComponent(job.id)}/${action}`,
      {
        method: 'POST',
        body: JSON.stringify({ runner_id: runnerId, ...body }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Worker rejected ${action} (${response.status}): ${(await response.text()).slice(0, 300)}`,
      );
    }
    const answer = await readJson(response, SuccessResponse);
    if (!answer.ok) throw new Error(`Worker returned an unreadable ${action} answer`);
  }

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

  async function openLoginPanel(job: CarrierWebBalanceJob, page: Page): Promise<LoginPanel | null> {
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

    await heartbeat(
      job,
      'human_verification_required',
      '联通登录遮罩已打开，但登录组件未加载；等待本机人工处理',
    );
    await presence?.set('busy', job.id, 'human_verification_required');
    logger.log(`${simLabel(job)} login panel needs attention in the open browser.`);
    const humanDeadline = Date.now() + humanVerificationSeconds(job) * 1000;
    let lastHeartbeat = Date.now();
    while (Date.now() < humanDeadline) {
      loginPanel = await findRandomPasswordTab(page);
      if (loginPanel) {
        await heartbeat(job, 'leased');
        await presence?.set('busy', job.id);
        return loginPanel;
      }
      if (Date.now() - lastHeartbeat >= 30_000) {
        await heartbeat(job, 'human_verification_required', '等待用户在本机浏览器恢复联通登录组件');
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

  async function hasHumanChallenge(page: Page): Promise<boolean> {
    const selectors = [
      '[class*="geetest"]',
      '[class*="captcha"]',
      '[id*="captcha"]',
      'iframe[src*="captcha"]',
      'iframe[src*="verify"]',
    ];
    for (const selector of selectors) {
      if (
        await page
          .locator(selector)
          .nth(0)
          .isVisible()
          .catch(() => false)
      )
        return true;
    }
    return page
      .getByText(/(?:请完成验证|安全验证|拖动滑块|点击图片)/)
      .nth(0)
      .isVisible()
      .catch(() => false);
  }

  async function heartbeat(
    job: CarrierWebBalanceJob,
    status: ActiveWebJobStatus,
    reason: string | null = null,
  ): Promise<void> {
    await postJob(job, 'heartbeat', { status, ...(reason ? { reason } : {}) });
  }

  function carrierLabel(job: CarrierWebBalanceJob): string {
    return job.skill.id === 'm1-prepaid-web-balance' ? 'M1' : '联通';
  }

  async function waitForOtp(job: CarrierWebBalanceJob, page: Page): Promise<string> {
    const deadline = Date.now() + humanVerificationSeconds(job) * 1000;
    let humanReported = false;
    let lastHeartbeat = 0;
    let cursor: { created_at: string; source_message_id: string } | null = null;
    while (Date.now() < deadline) {
      if (await hasHumanChallenge(page)) {
        if (!humanReported || Date.now() - lastHeartbeat > 30_000) {
          await heartbeat(
            job,
            'human_verification_required',
            `${carrierLabel(job)}网站要求在本机浏览器完成人工验证`,
          );
          await presence?.set('busy', job.id, 'human_verification_required');
          humanReported = true;
          lastHeartbeat = Date.now();
          logger.log(`${simLabel(job)} needs human verification in the open browser.`);
        }
      } else if (Date.now() - lastHeartbeat > 30_000) {
        await heartbeat(job, 'awaiting_otp');
        await presence?.set('busy', job.id);
        humanReported = false;
        lastHeartbeat = Date.now();
      }

      const query = new URLSearchParams({ runner_id: runnerId });
      if (cursor) {
        query.set('after_created_at', cursor.created_at);
        query.set('after_source_message_id', cursor.source_message_id);
      }
      const response = await controlClient.request(
        `/api/control/carrier-web-balance/jobs/${encodeURIComponent(job.id)}/otp?${query.toString()}`,
      );
      if (response.status === 204) {
        await abortableSleep(2_000);
        continue;
      }
      if (!response.ok) {
        throw new Error(
          `Could not poll login code (${response.status}): ${(await response.text()).slice(0, 300)}`,
        );
      }
      const answer = await readJson(response, CarrierWebBalanceOtpResponse);
      if (!answer.ok) throw new Error(`Could not read the carrier login code: ${answer.error}`);
      const payload = answer.value;
      if (!payload.code) {
        if (payload.cursor?.created_at && payload.cursor.source_message_id) {
          cursor = payload.cursor;
          await abortableSleep(2_000);
          continue;
        }
        throw new Error('Worker returned an empty carrier login code');
      }
      return payload.code;
    }
    throw new Error('Timed out waiting for carrier login code or human verification');
  }

  async function loginM1(job: CarrierWebBalanceJob, page: Page): Promise<void> {
    await page.goto(job.login_url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const phoneInput = await waitForFirstVisible(
      [page.locator('#msisdnContainer .typeContactNum'), page.locator('input.typeContactNum')],
      page,
    );
    if (!phoneInput) throw new Error('Could not find the M1 prepaid phone input');
    const localPhone = textOr(job.sim_number, '')
      .replace(/\D/g, '')
      .replace(/^65(?=\d{8}$)/, '');
    if (!/^\d{8}$/.test(localPhone))
      throw new Error('M1 prepaid account is not a valid Singapore number');
    await phoneInput.fill(localPhone);

    const requestButton = await waitForFirstVisible(
      [
        page.locator('#msisdnContainer .loginPageLoginButton'),
        page.locator('button.loginPageLoginButton'),
      ],
      page,
    );
    if (!requestButton) throw new Error('Could not find the M1 OTP request button');
    if (!job.otp_requested_at) {
      await postJob(job, 'otp-requested');
      await requestButton.click();
    } else {
      logger.log(`Reusing the existing login code request for ${simLabel(job)}.`);
    }

    const code = await waitForOtp(job, page);
    if (!/^\d{6}$/.test(code)) throw new Error('M1 login code must contain six digits');
    const inputs = page.locator('input.otp-input, input.otp-input-error');
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && (await inputs.count().catch(() => 0)) < 6) {
      await page.waitForTimeout(250);
    }
    if ((await inputs.count().catch(() => 0)) < 6)
      throw new Error('Could not find the six M1 OTP inputs');
    for (let index = 0; index < 6; index += 1) await inputs.nth(index).fill(code.charAt(index));

    await heartbeat(job, 'authenticating');
    const loginButton = await firstVisible([
      page.locator('button.loginPageLoginButton'),
      page.locator('.loginPageLoginButton'),
    ]);
    if (!loginButton) throw new Error('Could not find the M1 login confirmation button');
    await loginButton.click();
    const accountDeadline = Date.now() + 60_000;
    let account: Locator | null = null;
    while (Date.now() < accountDeadline) {
      account = await firstVisible([page.locator('.numberTxt')]);
      if (account) break;
      await page.waitForTimeout(500);
    }
    if (!account) throw new Error('M1 login did not expose the authenticated account');
    await waitForChallengeCompletion(job, page);
  }

  async function queryM1Balance(
    job: CarrierWebBalanceJob,
    balanceUrl: string,
    page: Page,
  ): Promise<CarrierBalance> {
    await heartbeat(job, 'querying');
    await page.goto(balanceUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const account = await waitForFirstVisible([page.locator('.numberTxt')], page, {
      timeoutMs: 60_000,
    });
    const balance = await waitForFirstVisible(
      [
        page.locator('.balanceForBox .balanceAmt.maBalanceDiv'),
        page.locator('.balanceAmt.maBalanceDiv'),
      ],
      page,
      { timeoutMs: 60_000 },
    );
    const validity = await waitForFirstVisible(
      [
        page.locator('.balanceForBox .brand-color'),
        page.getByText(/Valid\s+Till\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{4}/i),
      ],
      page,
      {
        timeoutMs: 60_000,
        textPattern: /Valid\s+Till\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{4}/i,
      },
    );
    if (!account || !balance || !validity) {
      throw new Error('M1 balance page is missing account, balance, or validity fields');
    }
    return extractM1WebBalance(
      {
        accountText: await account.innerText(),
        balanceText: await balance.innerText(),
        validityText: await validity.innerText(),
      },
      job.sim_number,
    );
  }

  async function waitForChallengeCompletion(job: CarrierWebBalanceJob, page: Page): Promise<void> {
    if (!(await hasHumanChallenge(page))) return;
    await heartbeat(job, 'human_verification_required', `${carrierLabel(job)}登录要求人工验证`);
    await presence?.set('busy', job.id, 'human_verification_required');
    logger.log(`${simLabel(job)} needs human verification in the open browser.`);
    const deadline = Date.now() + humanVerificationSeconds(job) * 1000;
    while (Date.now() < deadline) {
      if (!(await hasHumanChallenge(page))) return;
      await heartbeat(
        job,
        'human_verification_required',
        `等待用户在本机浏览器完成${carrierLabel(job)}验证`,
      );
      await abortableSleep(30_000);
    }
    throw new Error('Human verification timed out');
  }

  async function login(job: CarrierWebBalanceJob, page: Page): Promise<void> {
    await page.goto(job.login_url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(1_500);

    const loginPanel = await openLoginPanel(job, page);
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
      await postJob(job, 'otp-requested');
      await requestButton.click();
    } else {
      logger.log(`Reusing the existing login code request for ${simLabel(job)}.`);
    }
    const code = await waitForOtp(job, page);

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
    await heartbeat(job, 'authenticating');

    const loginButton = await firstVisible([
      loginContext.locator('#login1'),
      loginContext.getByRole('button', { name: /^登\s*录$/ }),
      loginContext.getByText(/^登\s*录$/),
    ]);
    if (!loginButton) throw new Error('Could not find the China Unicom login button');
    await loginButton.click();
    await page.waitForTimeout(1_500);
    await waitForChallengeCompletion(job, page);
  }

  async function queryBalance(
    job: CarrierWebBalanceJob,
    target: Extract<CarrierTarget, { provider: 'unicom' }>,
    context: BrowserContext,
    nativeResponsePromise: Promise<PageResponse | null>,
    sessionIdentityPromise: Promise<PageResponse | null>,
  ): Promise<CarrierBalance> {
    await heartbeat(job, 'querying');
    const nativeResponse = await nativeResponsePromise;
    await sessionIdentityPromise;

    // After login, Unicom sometimes redirects to #/errorpage instead of
    // serving balance data — their backend is temporarily unavailable.
    // Check the active page URL before attempting the API post so we can
    // release (retry later) rather than fail the job permanently.
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
    // The balance payload carries no account number, so the session identity is
    // merged in. The extractor still matches it against the SIM; this supplies the
    // proof, it does not bypass the check.
    const payloadObject = v.safeParse(JsonObject, payload);
    const payloadWithIdentity = sessionIdentity
      ? {
          ...(payloadObject.success ? payloadObject.output : {}),
          userInfo: { usernumber: sessionIdentity },
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
      throw new Error(`${errorMessage(error)}; response saved to ${responsePath}`, {
        cause: error,
      });
    }
  }

  async function release(job: CarrierWebBalanceJob, error: unknown): Promise<void> {
    try {
      await postJob(job, 'release', { error: errorMessage(error) });
    } catch (releaseError) {
      logger.error(`Could not release web balance job ${job.id}: ${errorMessage(releaseError)}`);
    }
  }

  async function fail(job: CarrierWebBalanceJob, error: unknown): Promise<void> {
    try {
      await postJob(job, 'fail', { error: errorMessage(error) });
    } catch (failError) {
      logger.error(`Could not fail web balance job ${job.id}: ${errorMessage(failError)}`);
    }
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
        args: TEMPORARY_CHROME_ARGS,
      });
      if (signal?.aborted) throw new Error('Browser query cancelled');
      page = context.pages()[0] ?? (await context.newPage());
      activePage = page;
      sessionIdentity = null;
      let parsed: CarrierBalance;
      if (target.provider === 'unicom') {
        // The portal calls this endpoint before login (answered with a logged-out
        // payload) and again after. Wait for the authenticated one.
        const nativeResponsePromise = page
          .waitForResponse(
            async (response) => {
              if (!response.url().startsWith(target.queryEndpoint)) return false;
              if (response.request().method() !== 'POST') return false;
              if (!response.ok()) return false;
              const body = await response.text().catch(() => '');
              // Only the authenticated response carries the balance.
              return parseJson(body, AuthenticatedBalanceBody).ok;
            },
            { timeout: 120_000 },
          )
          .catch(() => null);
        // The balance payload has no account field, so capture the signed-in number
        // the portal reports separately on checklogin.
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
        await login(job, page);
        parsed = await queryBalance(
          job,
          target,
          context,
          nativeResponsePromise,
          sessionIdentityPromise,
        );
      } else {
        await loginM1(job, page);
        parsed = await queryM1Balance(job, target.balanceUrl, page);
      }
      await postJob(job, 'complete', parsed);
      logger.log(`Stored carrier balance for ${simLabel(job)}.`);
      return { handled: true, retryDelay: 0 };
    } catch (error) {
      const diagnosticBase = await captureDiagnostics(job, page).catch(() => null);
      const terminal =
        /(?:timed out|does not prove|multiple candidate|recognized available-balance|exact SGD balance|validity date|HTTP|did not return JSON)/i.test(
          errorMessage(error),
        );
      if (terminal) await fail(job, error);
      else await release(job, error);
      logger.error(`Carrier web balance job ${job.id} failed: ${errorMessage(error)}`);
      if (diagnosticBase)
        logger.error(`Diagnostics saved to ${diagnosticBase}.json and ${diagnosticBase}.png`);
      const retryDelay = Math.max(10, numberOr(job.skill.cooldown_seconds, 10)) * 1_000;
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
