import type { CarrierWebBalanceJob } from '../../../../../shared/api/carrier-web-balance.js';
import type { CarrierTarget } from './types.js';

const LOGIN_ORIGIN = 'https://imgxx.client.10010.com';
const QUERY_ORIGIN = 'https://www.10010.com';
// The portal's read-only balance call moved from www.10010.com to mxx.client.10010.com;
// both hosts are allowed, and both only ever receive the balance request.
const BALANCE_API_ORIGINS = Object.freeze([QUERY_ORIGIN, 'https://mxx.client.10010.com']);
const M1_ORIGIN = 'https://mcardaccount.m1.com.sg';

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function simLabel(job: CarrierWebBalanceJob): string {
  return `S${String(job.sim_index).padStart(2, '0')}`;
}

export function humanVerificationSeconds(job: CarrierWebBalanceJob): number {
  return job.skill.human_verification_timeout_seconds ?? 900;
}

export function carrierLabel(job: CarrierWebBalanceJob): string {
  return job.skill.id === 'm1-prepaid-web-balance' ? 'M1' : '联通';
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
