import * as v from 'valibot';
import { parseJson } from '../../shared/parse-json.js';
import type {
  CheckStatus,
  DisplayStatus,
  SkillJobStatus,
  WebJobStatus,
} from '../../shared/balance-status.js';
import { BalanceMetric, type BalanceCheck } from '../../shared/api/balance-checks.js';
import type { BalanceCheckListRow } from '../db/balance-checks.js';

const SkillOutputs = v.object({ outputs: v.array(v.unknown()) });

function profileOutputs(skillConfig: string): string[] {
  const parsed = parseJson(skillConfig, SkillOutputs);
  return parsed.ok
    ? parsed.value.outputs.filter((output): output is string => typeof output === 'string')
    : [];
}

function parseMetrics(metricsJson: string): BalanceMetric[] {
  const parsed = parseJson(metricsJson, v.array(BalanceMetric));
  return parsed.ok ? parsed.value : [];
}

function webDisplayStatus(status: WebJobStatus): DisplayStatus | null {
  switch (status) {
    case 'pending':
      return 'web_pending';
    case 'leased':
      return 'web_processing';
    case 'awaiting_otp':
      return 'web_otp';
    case 'authenticating':
      return 'web_authenticating';
    case 'querying':
      return 'web_querying';
    case 'human_verification_required':
      return 'web_human_required';
    case 'completed':
    case 'failed':
    case 'stopped':
      return null;
  }
}

export function displayBalanceStatus(record: {
  status: CheckStatus;
  skill_job_status: SkillJobStatus | null;
  web_job_status: WebJobStatus | null;
}): DisplayStatus {
  if (
    (record.status === 'response_received' || record.status === 'unparsed') &&
    (record.skill_job_status === 'pending' || record.skill_job_status === 'leased')
  ) {
    return record.skill_job_status === 'leased' ? 'skill_processing' : 'skill_pending';
  }
  if (record.status === 'queued' && record.web_job_status !== null) {
    return webDisplayStatus(record.web_job_status) ?? record.status;
  }
  return record.status;
}

export function toBalanceChecks(rows: readonly BalanceCheckListRow[]): BalanceCheck[] {
  return rows.map(({ metrics_json, skill_config, ...record }) => ({
    ...record,
    display_status: displayBalanceStatus(record),
    profile_outputs: profileOutputs(skill_config),
    metrics: parseMetrics(metrics_json),
  }));
}
