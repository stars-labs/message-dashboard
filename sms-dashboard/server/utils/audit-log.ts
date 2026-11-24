import { boundedErrorText, classifyD1Error } from './d1-error.js';
import { insertAuditLog } from '../db/audit-log.js';
import type { D1, D1RunResult } from '../lib/d1.js';

interface AuditEvent {
  action: string;
  resourceType?: string;
  resourceId: string | null;
  userEmail?: string | null;
  details?: object;
}

interface AuditEnv {
  DB: D1<'run'>;
}

export async function writeAuditLog(
  env: AuditEnv,
  { action, resourceType = 'user', resourceId, userEmail = null, details = {} }: AuditEvent,
): Promise<D1RunResult> {
  return insertAuditLog(env.DB, {
    action,
    resourceType,
    resourceId,
    userEmail,
    details: JSON.stringify(details),
  });
}

/** Observability only: kept off the auth callback's critical path, failures contained. */
export function scheduleAuthAudit(
  request: { env: AuditEnv; ctx: { waitUntil(promise: Promise<unknown>): void } },
  event: AuditEvent,
): void {
  const promise = writeAuditLog(request.env, event).catch((error: unknown) => {
    const classification = classifyD1Error(error);
    console.error(
      JSON.stringify({
        event: 'auth_audit_failed',
        action: event.action,
        error_code: classification.code,
        quota: classification.quota ?? null,
        retry_at: classification.retryAt?.toISOString() ?? null,
        error: boundedErrorText(error),
      }),
    );
  });

  request.ctx.waitUntil(promise);
}
