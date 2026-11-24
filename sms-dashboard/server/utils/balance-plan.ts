import * as v from 'valibot';
import { parseJson } from '../../shared/parse-json.js';
import { parseBalanceSkillConfig } from '../../shared/balance-skill.js';
import {
  BATCH_METHODS,
  INELIGIBLE_REASONS,
  type BalanceMethod,
  type RecentBalanceCheck,
} from '../../shared/api/balance-checks.js';
import type { BalanceProfile, ParsedCheck, PlanPhone } from '../db/balance-plan.js';

type BatchMethod = (typeof BATCH_METHODS)[number];
type IneligibleReason = (typeof INELIGIBLE_REASONS)[number];

/** One SIM's balance-query eligibility. An eligible SIM always has a profile. */
export type PlanItem =
  | {
      phone: PlanPhone;
      profile: BalanceProfile;
      eligible: true;
      reason: null;
      recentCheck: null;
    }
  | {
      phone: PlanPhone;
      profile: BalanceProfile | null;
      eligible: false;
      reason: IneligibleReason;
      recentCheck: RecentBalanceCheck | null;
    };

export type EligiblePlanItem = Extract<PlanItem, { eligible: true }>;

const RequiredServiceType = v.object({ required_service_type: v.pipe(v.string(), v.nonEmpty()) });

const CHINA_MOBILE_NAMES = ['china mobile', 'cmcc', '中国移动', '移动'];
const CHINA_UNICOM_NAMES = ['china unicom', 'unicom', '中国联通', '联通'];
const CHINA_TELECOM_NAMES = ['china telecom', 'telecom', 'ctcc', '中国电信', '电信'];
const CMHK_NAMES = ['cmhk', 'china mobile hong kong', '中国移动香港', '中移香港', '香港移动'];

function normalizeCarrier(value: string | null): string {
  return (value ?? '').trim().toLocaleLowerCase();
}

function checkKey(simIccid: string, profileId: string): string {
  return `${simIccid}\u0000${profileId}`;
}

function requiredServiceType(profile: BalanceProfile): string | null {
  const parsed = parseJson(profile.skill_config, RequiredServiceType);
  return parsed.ok ? parsed.value.required_service_type : null;
}

export function carrierMatchesProfile(
  actualCarrier: string | null,
  profileCarrier: string,
): boolean {
  const actual = normalizeCarrier(actualCarrier);
  const expected = normalizeCarrier(profileCarrier);
  if (!actual || !expected) return false;
  if (actual === expected) return true;

  if (CHINA_MOBILE_NAMES.includes(expected)) {
    return CHINA_MOBILE_NAMES.some((name) => actual.includes(name));
  }

  if (CHINA_UNICOM_NAMES.includes(expected)) {
    return CHINA_UNICOM_NAMES.some((name) => actual.includes(name));
  }

  if (CHINA_TELECOM_NAMES.includes(expected)) {
    return CHINA_TELECOM_NAMES.some((name) => actual.includes(name));
  }

  if (CMHK_NAMES.includes(expected)) {
    return CMHK_NAMES.some((name) => actual.includes(name)) || actual === '移动';
  }

  return actual.includes(expected) || expected.includes(actual);
}

export function buildBalanceQueryPlan({
  phones,
  profiles,
  recentChecks = [],
  successfulChecks = [],
  allowDiscovery = false,
}: {
  phones: readonly PlanPhone[];
  profiles: readonly BalanceProfile[];
  recentChecks?: readonly RecentBalanceCheck[];
  successfulChecks?: readonly ParsedCheck[];
  allowDiscovery?: boolean;
}): PlanItem[] {
  const recentBySim = new Map(recentChecks.map((check) => [check.sim_iccid, check]));
  const successful = new Set(
    successfulChecks.map((check) => checkKey(check.sim_iccid, check.profile_id)),
  );

  return phones.map((phone): PlanItem => {
    const matchingProfiles = profiles
      .filter(
        (profile) =>
          phone.country === profile.country_code &&
          carrierMatchesProfile(phone.carrier, profile.carrier),
      )
      .sort((a, b) => b.enabled - a.enabled);
    const profile =
      matchingProfiles.find(
        (candidate) =>
          candidate.enabled === 1 ||
          (candidate.discovery_enabled === 1 &&
            (allowDiscovery || successful.has(checkKey(phone.iccid, candidate.id)))),
      ) ?? null;
    const recentCheck = recentBySim.get(phone.iccid) ?? null;
    const ineligible = (reason: IneligibleReason): PlanItem => ({
      phone,
      profile,
      eligible: false,
      reason,
      recentCheck,
    });

    if (phone.sim_role === 'secondary') return ineligible('secondary');
    if (phone.sim_status !== 'active') return ineligible('offline');
    if (!profile) return ineligible(matchingProfiles.length ? 'unverified' : 'unsupported');
    const serviceType = requiredServiceType(profile);
    if (serviceType !== null && phone.service_type !== serviceType) {
      return ineligible('service_type');
    }
    if (recentCheck) return ineligible('cooldown');
    return { phone, profile, eligible: true, reason: null, recentCheck: null };
  });
}

export function summarizePlan(plan: readonly PlanItem[]) {
  const summary = {
    total: plan.length,
    eligible: 0,
    offline: 0,
    unsupported: 0,
    unverified: 0,
    cooldown: 0,
    secondary: 0,
    service_type: 0,
  };
  for (const item of plan) {
    if (item.eligible) summary.eligible += 1;
    else summary[item.reason] += 1;
  }
  return summary;
}

export function queryMethod(
  profile: Pick<BalanceProfile, 'method' | 'skill_config'>,
): BalanceMethod & { category: BatchMethod } {
  switch (profile.method) {
    case 'browser':
      return { category: 'browser', capability: 'carrier_browser', interactive: true };
    case 'sms':
      return parseBalanceSkillConfig(profile.skill_config)
        ? { category: 'sms_ai', capability: 'sms_ai', interactive: false }
        : { category: 'direct_sms', capability: null, interactive: false };
  }
}

export function describeBalanceMethod(
  profile: Pick<BalanceProfile, 'method' | 'skill_config'> | null,
): BalanceMethod {
  return profile
    ? queryMethod(profile)
    : { category: 'unsupported', capability: null, interactive: false };
}

export function summarizeMethods(plan: readonly PlanItem[]): Record<BatchMethod, number> {
  const summary = { direct_sms: 0, sms_ai: 0, browser: 0 };
  for (const item of plan) {
    if (item.eligible) summary[queryMethod(item.profile).category] += 1;
  }
  return summary;
}

export function filterBalancePlanByMethods(
  plan: readonly PlanItem[],
  methods: readonly BatchMethod[],
): EligiblePlanItem[] {
  const selected = new Set(methods);
  return plan.filter(
    (item): item is EligiblePlanItem =>
      item.eligible && selected.has(queryMethod(item.profile).category),
  );
}
