import type { CarrierWebBalanceJob } from '../../../../../shared/api/carrier-web-balance.js';
import { extractM1WebBalance } from '../../../../../shared/m1-web-balance.js';
import { textOr } from '../../../../../shared/text.js';
import type { JobChannel } from './job-channel.js';
import { simLabel } from './job-target.js';
import { firstVisible, waitForFirstVisible } from './locators.js';
import type { CarrierBalance, Locator, Page } from './types.js';

export async function loginM1(
  channel: JobChannel,
  job: CarrierWebBalanceJob,
  page: Page,
): Promise<void> {
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
    await channel.markOtpRequested(job);
    await requestButton.click();
  } else {
    channel.logger.log(`Reusing the existing login code request for ${simLabel(job)}.`);
  }

  const code = await channel.waitForOtp(job, page);
  if (!/^\d{6}$/.test(code)) throw new Error('M1 login code must contain six digits');
  const inputs = page.locator('input.otp-input, input.otp-input-error');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && (await inputs.count().catch(() => 0)) < 6) {
    await page.waitForTimeout(250);
  }
  if ((await inputs.count().catch(() => 0)) < 6)
    throw new Error('Could not find the six M1 OTP inputs');
  for (let index = 0; index < 6; index += 1) await inputs.nth(index).fill(code.charAt(index));

  await channel.heartbeat(job, 'authenticating');
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
  await channel.waitForChallengeCompletion(job, page);
}

export async function queryM1Balance(
  channel: JobChannel,
  job: CarrierWebBalanceJob,
  balanceUrl: string,
  page: Page,
): Promise<CarrierBalance> {
  await channel.heartbeat(job, 'querying');
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
