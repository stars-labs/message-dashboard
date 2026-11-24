import type {
  CarrierWebBalanceJob,
  CarrierWebBalanceOtpWire,
} from '../../../../../shared/api/carrier-web-balance.js';
import type { ActiveWebJobStatus } from '../../../../../shared/balance-status.js';
import { errorText } from '../../../../../shared/error-text.js';
import { ControlError, type ControlClient } from '../../control-client.js';
import type { CapabilityPresence } from '../../presence.js';
import { abortableSleep } from '../../serial-runner.js';
import { carrierLabel, humanVerificationSeconds, simLabel } from './job-target.js';
import type { CarrierBalance, Logger, Page } from './types.js';

type OtpPoll = Awaited<ReturnType<ControlClient['carrierWebJobs']['otp']>>;

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

export function createJobChannel({
  controlClient,
  presence,
  runnerId,
  logger,
}: {
  controlClient: ControlClient;
  presence: CapabilityPresence | null | undefined;
  runnerId: string;
  logger: Logger;
}) {
  async function postJob(action: string, sent: Promise<unknown>): Promise<void> {
    try {
      await sent;
    } catch (error) {
      if (!(error instanceof ControlError)) throw error;
      throw new Error(
        `Worker rejected ${action} (${String(error.status)}): ${error.body.slice(0, 300)}`,
        { cause: error },
      );
    }
  }

  async function heartbeat(
    job: CarrierWebBalanceJob,
    status: ActiveWebJobStatus,
    reason: string | null = null,
  ): Promise<void> {
    await postJob(
      'heartbeat',
      controlClient.carrierWebJobs.heartbeat({
        params: { id: job.id },
        body: { runner_id: runnerId, status, ...(reason ? { reason } : {}) },
      }),
    );
  }

  async function markOtpRequested(job: CarrierWebBalanceJob): Promise<void> {
    await postJob(
      'otp-requested',
      controlClient.carrierWebJobs.otpRequested({
        params: { id: job.id },
        body: { runner_id: runnerId },
      }),
    );
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

      const poll: OtpPoll = await controlClient.carrierWebJobs
        .otp({
          params: { id: job.id },
          query: {
            runner_id: runnerId,
            ...(cursor
              ? {
                  after_created_at: cursor.created_at,
                  after_source_message_id: cursor.source_message_id,
                }
              : {}),
          },
        })
        .catch((error: unknown) => {
          if (!(error instanceof ControlError)) throw error;
          throw new Error(
            `Could not poll login code (${String(error.status)}): ${error.body.slice(0, 300)}`,
            { cause: error },
          );
        });
      if (poll.status === 204) {
        await abortableSleep(2_000);
        continue;
      }
      const payload: CarrierWebBalanceOtpWire = poll.body;
      if (payload.code === null) {
        if (payload.cursor.created_at && payload.cursor.source_message_id) {
          cursor = payload.cursor;
          await abortableSleep(2_000);
          continue;
        }
        throw new Error('Worker returned an empty carrier login code');
      }
      if (!payload.code) throw new Error('Worker returned an empty carrier login code');
      return payload.code;
    }
    throw new Error('Timed out waiting for carrier login code or human verification');
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

  async function release(job: CarrierWebBalanceJob, error: unknown): Promise<void> {
    try {
      await postJob(
        'release',
        controlClient.carrierWebJobs.release({
          params: { id: job.id },
          body: { runner_id: runnerId, error: errorText(error) },
        }),
      );
    } catch (releaseError) {
      logger.error(`Could not release web balance job ${job.id}: ${errorText(releaseError)}`);
    }
  }

  async function fail(job: CarrierWebBalanceJob, error: unknown): Promise<void> {
    try {
      await postJob(
        'fail',
        controlClient.carrierWebJobs.fail({
          params: { id: job.id },
          body: { runner_id: runnerId, error: errorText(error) },
        }),
      );
    } catch (failError) {
      logger.error(`Could not fail web balance job ${job.id}: ${errorText(failError)}`);
    }
  }

  async function complete(job: CarrierWebBalanceJob, balance: CarrierBalance): Promise<void> {
    await postJob(
      'complete',
      controlClient.carrierWebJobs.complete({
        params: { id: job.id },
        body: { runner_id: runnerId, ...balance },
      }),
    );
  }

  return Object.freeze({
    presence,
    logger,
    postJob,
    heartbeat,
    markOtpRequested,
    waitForOtp,
    waitForChallengeCompletion,
    release,
    fail,
    complete,
  });
}

export type JobChannel = ReturnType<typeof createJobChannel>;
