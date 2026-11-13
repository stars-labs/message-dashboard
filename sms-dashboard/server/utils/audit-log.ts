import { boundedErrorText, classifyD1Error } from './d1-error.js';
import type { D1, D1RunResult } from '../lib/d1.js';

/** One audit_logs row. `details` is serialized; callers choose its shape. */
export interface AuditEvent {
  action: string;
  resourceType?: string;
  resourceId: string | null;
  userEmail?: string | null;
  details?: object;
}

interface AuditEnv {
  DB: D1<'run'>;
}

/** Single writer for audit_logs. Callers decide whether the event is required. */
export async function writeAuditLog(
  env: AuditEnv,
  { action, resourceType = 'user', resourceId, userEmail = null, details = {} }: AuditEvent,
): Promise<D1RunResult> {
  return env.DB.prepare(
    `
    INSERT INTO audit_logs (action, resource_type, resource_id, user_email, details, timestamp)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `,
  )
    .bind(action, resourceType, resourceId, userEmail, JSON.stringify(details))
    .run();
}

/**
 * Authentication audit events are observability, not an authentication authority.
 * Keep them off the callback's critical path and always contain their failures.
 */
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
