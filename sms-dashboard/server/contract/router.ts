import { implement } from '@orpc/server';
import type * as v from 'valibot';
import type { CarrierBillMutationBody } from '../../shared/api/carrier-bills.js';
import { contract } from '../../shared/api/contract/index.js';
import { auth0Handler } from '../handlers/auth0.js';
import { balanceQueriesHandler } from '../handlers/balance-queries.js';
import { balanceRunnersHandler } from '../handlers/balance-runners.js';
import { balanceSkillRunnerHandler } from '../handlers/balance-skill-runner.js';
import { callsHandler, daemonCallsHandler } from '../handlers/calls.js';
import { carrierBillingBackfillHandler } from '../handlers/carrier-billing-backfill.js';
import { carrierBillsHandler } from '../handlers/carrier-bills.js';
import { carrierWebBalanceHandler } from '../handlers/carrier-web-balance.js';
import { controlHandler, recordHeartbeat } from '../handlers/control.js';
import { filtersHandler } from '../handlers/filters.js';
import { healthHandler } from '../handlers/health.js';
import { iccidMappingsHandler } from '../handlers/iccid-mappings.js';
import { keywordsHandler } from '../handlers/keywords.js';
import { messagesHandler } from '../handlers/messages.js';
import { phonesHandler } from '../handlers/phones.js';
import { usersHandler } from '../handlers/users.js';
import { verificationHandler } from '../handlers/verification.js';
import type { AuthorizedRunner } from '../utils/runner-auth.js';
import type { AppRequest } from '../worker-context.js';

export interface ContractContext {
  /** Authorized for the route's declared access before the procedure runs. */
  request: AppRequest;
  resHeaders: Headers;
  /** Who a runner route admitted; null on every other route. */
  runner: AuthorizedRunner | null;
}

const os = implement(contract).$context<ContractContext>();

function runnerOf({ runner }: ContractContext): AuthorizedRunner {
  if (runner === null) throw new Error('a runner route ran without an admitted runner');
  return runner;
}

function billMutation(input: {
  params: { id: string };
  headers: { 'idempotency-key'?: string | undefined };
  body: v.InferOutput<typeof CarrierBillMutationBody>;
}) {
  return {
    id: input.params.id,
    idempotencyKey: input.headers['idempotency-key'],
    body: input.body,
  };
}

export const router = os.router({
  control: {
    heartbeat: os.control.heartbeat.handler(({ context, input }) =>
      recordHeartbeat(context.request, input),
    ),
    devices: os.control.devices.handler(({ context, input }) =>
      controlHandler.updateDevices(context.request, input),
    ),
    uploadMessages: os.control.uploadMessages.handler(({ context, input }) =>
      controlHandler.uploadMessages(context.request, input),
    ),
    clearMessages: os.control.clearMessages.handler(({ context }) =>
      controlHandler.clearMessages(context.request),
    ),
    pendingSms: os.control.pendingSms.handler(({ context, input }) =>
      controlHandler.getPendingSMS(context.request, input.headers['x-daemon-session-id']),
    ),
    smsResult: os.control.smsResult.handler(({ context, input }) =>
      controlHandler.updateSMSResult(context.request, input),
    ),
    callIncoming: os.control.callIncoming.handler(({ context, input }) =>
      daemonCallsHandler.incoming(context.request, input),
    ),
    callEnded: os.control.callEnded.handler(({ context, input }) =>
      daemonCallsHandler.ended(context.request, input),
    ),
  },
  balanceCheckControl: {
    create: os.balanceCheckControl.create.handler(async ({ context, input }) => ({
      status: 202,
      body: await balanceQueriesHandler.create(context.request, input),
    })),
    continue: os.balanceCheckControl.continue.handler(async ({ context, input }) => ({
      status: 202,
      body: await balanceQueriesHandler.continue(context.request, input),
    })),
    retry: os.balanceCheckControl.retry.handler(async ({ context, input }) => ({
      status: 202,
      body: await balanceQueriesHandler.retry(context.request, input),
    })),
    stop: os.balanceCheckControl.stop.handler(({ context, input }) =>
      balanceQueriesHandler.stop(context.request, input),
    ),
  },
  balanceRunnerControl: {
    check: os.balanceRunnerControl.check.handler(() => ({ success: true }) as const),
    heartbeat: os.balanceRunnerControl.heartbeat.handler(({ context, input }) =>
      balanceRunnersHandler.heartbeat(context.request, runnerOf(context), input),
    ),
  },
  balanceSkillJobs: {
    claim: os.balanceSkillJobs.claim.handler(async ({ context, input }) => {
      const job = await balanceSkillRunnerHandler.claim(
        context.request,
        runnerOf(context),
        input.query.runner_id,
      );
      return job === null ? { status: 204 as const } : { status: 200 as const, body: job };
    }),
    decision: os.balanceSkillJobs.decision.handler(({ context, input }) =>
      balanceSkillRunnerHandler.decide(
        context.request,
        runnerOf(context),
        input.params.id,
        input.body,
      ),
    ),
    release: os.balanceSkillJobs.release.handler(({ context, input }) =>
      balanceSkillRunnerHandler.release(
        context.request,
        runnerOf(context),
        input.params.id,
        input.body,
      ),
    ),
  },
  carrierWebJobs: {
    claim: os.carrierWebJobs.claim.handler(async ({ context, input }) => {
      const job = await carrierWebBalanceHandler.claim(
        context.request,
        runnerOf(context),
        input.query.runner_id,
      );
      return job === null ? { status: 204 as const } : { status: 200 as const, body: job };
    }),
    otpRequested: os.carrierWebJobs.otpRequested.handler(({ context, input }) =>
      carrierWebBalanceHandler.otpRequested(
        context.request,
        runnerOf(context),
        input.params.id,
        input.body,
      ),
    ),
    otp: os.carrierWebJobs.otp.handler(async ({ context, input }) => {
      const otp = await carrierWebBalanceHandler.otp(
        context.request,
        runnerOf(context),
        input.params.id,
        input.query,
      );
      return otp === null ? { status: 204 as const } : { status: 200 as const, body: otp };
    }),
    heartbeat: os.carrierWebJobs.heartbeat.handler(({ context, input }) =>
      carrierWebBalanceHandler.heartbeat(
        context.request,
        runnerOf(context),
        input.params.id,
        input.body,
      ),
    ),
    complete: os.carrierWebJobs.complete.handler(({ context, input }) =>
      carrierWebBalanceHandler.complete(
        context.request,
        runnerOf(context),
        input.params.id,
        input.body,
      ),
    ),
    fail: os.carrierWebJobs.fail.handler(({ context, input }) =>
      carrierWebBalanceHandler.fail(
        context.request,
        runnerOf(context),
        input.params.id,
        input.body,
      ),
    ),
    release: os.carrierWebJobs.release.handler(({ context, input }) =>
      carrierWebBalanceHandler.release(
        context.request,
        runnerOf(context),
        input.params.id,
        input.body,
      ),
    ),
  },
  health: {
    live: os.health.live.handler(({ context }) => healthHandler.live(context)),
    ready: os.health.ready.handler(({ context: { request, resHeaders } }) =>
      healthHandler.check({ env: request.env, resHeaders }),
    ),
    daemonStatus: os.health.daemonStatus.handler(({ context: { request, resHeaders } }) =>
      healthHandler.daemonStatus({ env: request.env, resHeaders }),
    ),
  },
  auth: {
    me: os.auth.me.handler(({ context }) => auth0Handler.me(context.request)),
  },
  users: {
    list: os.users.list.handler(({ context: { request, resHeaders } }) =>
      usersHandler.list({ env: request.env, resHeaders }),
    ),
    setRole: os.users.setRole.handler(({ context: { request, resHeaders }, input }) =>
      usersHandler.setRole(
        { env: request.env, user: request.user, resHeaders },
        input.params.id,
        input.body.role,
      ),
    ),
  },
  messages: {
    phones: os.messages.phones.handler(({ context }) => phonesHandler.list(context.request)),
    list: os.messages.list.handler(({ context, input }) =>
      messagesHandler.list(context.request, input.query),
    ),
    send: os.messages.send.handler(({ context, input }) =>
      messagesHandler.send(context.request, input),
    ),
  },
  iccidMappings: {
    list: os.iccidMappings.list.handler(({ context, input }) =>
      iccidMappingsHandler.list(context.request, input.query),
    ),
    get: os.iccidMappings.get.handler(({ context, input }) =>
      iccidMappingsHandler.get(context.request, input.params.id),
    ),
    byIccid: os.iccidMappings.byIccid.handler(({ context, input }) =>
      iccidMappingsHandler.getByIccid(context.request, input.params.iccid),
    ),
    create: os.iccidMappings.create.handler(({ context, input }) =>
      iccidMappingsHandler.create(context.request, input),
    ),
    update: os.iccidMappings.update.handler(({ context, input }) =>
      iccidMappingsHandler.update(context.request, input.params.id, input.body),
    ),
    remove: os.iccidMappings.remove.handler(({ context, input }) =>
      iccidMappingsHandler.delete(context.request, input.params.id),
    ),
    bulk: os.iccidMappings.bulk.handler(({ context, input }) =>
      iccidMappingsHandler.bulkImport(context.request, input),
    ),
  },
  keywords: {
    list: os.keywords.list.handler(({ context }) => keywordsHandler.list(context.request)),
    get: os.keywords.get.handler(({ context, input }) =>
      keywordsHandler.get(context.request, input.params.id),
    ),
    create: os.keywords.create.handler(({ context, input }) =>
      keywordsHandler.create(context.request, input),
    ),
    update: os.keywords.update.handler(({ context, input }) =>
      keywordsHandler.update(context.request, input.params.id, input.body),
    ),
    remove: os.keywords.remove.handler(({ context, input }) =>
      keywordsHandler.remove(context.request, input.params.id),
    ),
    history: os.keywords.history.handler(({ context, input }) =>
      keywordsHandler.history(context.request, input.params.id, input.body),
    ),
    batchTags: os.keywords.batchTags.handler(({ context, input }) =>
      keywordsHandler.batchTags(context.request, input),
    ),
    messageTags: os.keywords.messageTags.handler(({ context, input }) =>
      keywordsHandler.messageTags(context.request, input.params.id),
    ),
  },
  filters: {
    list: os.filters.list.handler(({ context }) => filtersHandler.list(context.request)),
    create: os.filters.create.handler(({ context, input }) =>
      filtersHandler.create(context.request, input),
    ),
    update: os.filters.update.handler(({ context, input }) =>
      filtersHandler.update(context.request, input.params.id, input.body),
    ),
    remove: os.filters.remove.handler(({ context, input }) =>
      filtersHandler.remove(context.request, input.params.id),
    ),
    history: os.filters.history.handler(({ context, input }) =>
      filtersHandler.history(context.request, input.params.id, input.body),
    ),
  },
  verification: {
    reprocess: os.verification.reprocess.handler(({ context, input }) =>
      verificationHandler.reprocess(context.request, input.query),
    ),
  },
  balanceChecks: {
    list: os.balanceChecks.list.handler(({ context, input }) =>
      balanceQueriesHandler.list(context.request, input.query),
    ),
    status: os.balanceChecks.status.handler(({ context, input }) =>
      balanceQueriesHandler.status(context.request, input.query),
    ),
    detail: os.balanceChecks.detail.handler(({ context, input }) =>
      balanceQueriesHandler.detail(context.request, input.params.id),
    ),
    previewAll: os.balanceChecks.previewAll.handler(({ context }) =>
      balanceQueriesHandler.preview(context.request, null),
    ),
    preview: os.balanceChecks.preview.handler(({ context, input }) =>
      balanceQueriesHandler.preview(context.request, input.phone_iccids),
    ),
    preflight: os.balanceChecks.preflight.handler(({ context, input }) =>
      balanceQueriesHandler.preflight(context.request, input.query),
    ),
    query: os.balanceChecks.query.handler(async ({ context, input }) => ({
      status: 202,
      body: await balanceQueriesHandler.query(context.request, input),
    })),
    queryBatch: os.balanceChecks.queryBatch.handler(async ({ context, input }) => ({
      status: 202,
      body: await balanceQueriesHandler.queryBatch(context.request, input),
    })),
  },
  balanceRunners: {
    status: os.balanceRunners.status.handler(({ context }) =>
      balanceRunnersHandler.status(context.request),
    ),
  },
  carrierBills: {
    accounts: os.carrierBills.accounts.handler(({ context }) =>
      carrierBillsHandler.listAccounts(context.request),
    ),
    backfillPreview: os.carrierBills.backfillPreview.handler(({ context, input }) =>
      carrierBillingBackfillHandler.preview(context.request, input),
    ),
    backfillExecute: os.carrierBills.backfillExecute.handler(({ context, input }) =>
      carrierBillingBackfillHandler.execute(
        context.request,
        input.headers['idempotency-key'],
        input.body,
      ),
    ),
    list: os.carrierBills.list.handler(({ context, input }) =>
      carrierBillsHandler.list(context.request, input.query),
    ),
    get: os.carrierBills.get.handler(({ context, input }) =>
      carrierBillsHandler.get(context.request, input.params.id),
    ),
    paymentPlanned: os.carrierBills.paymentPlanned.handler(({ context, input }) =>
      carrierBillsHandler.paymentPlanned(context.request, billMutation(input)),
    ),
    markPaid: os.carrierBills.markPaid.handler(({ context, input }) =>
      carrierBillsHandler.markPaid(context.request, billMutation(input)),
    ),
    waive: os.carrierBills.waive.handler(({ context, input }) =>
      carrierBillsHandler.waive(context.request, billMutation(input)),
    ),
    reopen: os.carrierBills.reopen.handler(({ context, input }) =>
      carrierBillsHandler.reopen(context.request, billMutation(input)),
    ),
  },
  calls: {
    state: os.calls.state.handler(({ context }) => callsHandler.state(context.request)),
    history: os.calls.history.handler(({ context, input }) =>
      callsHandler.history(context.request, input.query),
    ),
    ice: os.calls.ice.handler(({ context }) => callsHandler.ice(context.request)),
    dial: os.calls.dial.handler(({ context, input }) => callsHandler.dial(context.request, input)),
    answer: os.calls.answer.handler(({ context, input }) =>
      callsHandler.answer(context.request, input),
    ),
    connect: os.calls.connect.handler(({ context, input }) =>
      callsHandler.connect(context.request, input),
    ),
    renegotiate: os.calls.renegotiate.handler(({ context, input }) =>
      callsHandler.renegotiate(context.request, input),
    ),
    hangup: os.calls.hangup.handler(({ context, input }) =>
      callsHandler.hangup(context.request, input),
    ),
  },
});
