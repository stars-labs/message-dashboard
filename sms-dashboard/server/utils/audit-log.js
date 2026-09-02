import { boundedErrorText, classifyD1Error } from './d1-error.js';

/** Single writer for audit_logs. Callers decide whether the event is required. */
export async function writeAuditLog(env, {
  action,
  resourceType = 'user',
  resourceId,
  userEmail = null,
  details = {},
}) {
  return env.DB.prepare(`
    INSERT INTO audit_logs (action, resource_type, resource_id, user_email, details, timestamp)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).bind(
    action,
    resourceType,
    resourceId,
    userEmail,
    JSON.stringify(details)
  ).run();
}

/**
 * Authentication audit events are observability, not an authentication authority.
 * Keep them off the callback's critical path and always contain their failures.
 */
export function scheduleAuthAudit(request, event) {
  const promise = writeAuditLog(request.env, event).catch((error) => {
    const classification = classifyD1Error(error);
    console.error(JSON.stringify({
      event: 'auth_audit_failed',
      action: event.action,
      error_code: classification.code,
      quota: classification.quota ?? null,
      retry_at: classification.retryAt?.toISOString() ?? null,
      error: boundedErrorText(error),
    }));
  });

  request.ctx.waitUntil(promise);
}
