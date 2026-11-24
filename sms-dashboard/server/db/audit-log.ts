import type { D1, D1RunResult } from '../lib/d1.js';

export function insertAuditLog(
  db: D1<'run'>,
  entry: {
    action: string;
    resourceType: string;
    resourceId: string | null;
    userEmail: string | null;
    details: string;
  },
): Promise<D1RunResult> {
  return db
    .prepare(
      `
    INSERT INTO audit_logs (action, resource_type, resource_id, user_email, details, timestamp)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `,
    )
    .bind(entry.action, entry.resourceType, entry.resourceId, entry.userEmail, entry.details)
    .run();
}
