import type { AppRequest } from '../../shared/worker-context.js';
import type { D1Database } from '../../shared/cf-bindings.js';

/** Display urgency derived from action_status and the due date. */
export type BillUrgency = 'needs_review' | 'paid' | 'waived' | 'overdue' | 'due_soon' | 'open';

/** The four operator mutations. */
type BillAction = 'payment_planned' | 'mark_paid' | 'waive' | 'reopen';

/** A carrier_bills row joined with its account and notification SIM. */
interface BillRow {
  id: string;
  billing_account_id: string;
  source_message_id: string | null;
  amount_minor: number;
  currency: string;
  due_date: string;
  action_status: 'unpaid' | 'payment_planned' | 'paid' | 'waived' | 'needs_review' | string;
  version: number;
  display_name?: string;
  carrier?: string;
  account_ref_last4: string | null;
  notification_sim_iccid: string | null;
  notification_sim_index: number | null;
  notification_sim_number: string | null;
  linked_sim_count?: number;
  [column: string]: unknown;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function singaporeDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function dateEpoch(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00Z`);
}

export function deriveBillUrgency(
  bill: Pick<BillRow, 'due_date' | 'action_status'>,
  today: string = singaporeDate(),
): { urgency: BillUrgency; days_remaining: number } {
  const daysRemaining = Math.round((dateEpoch(bill.due_date) - dateEpoch(today)) / 86_400_000);
  let urgency: BillUrgency;
  if (bill.action_status === 'needs_review') urgency = 'needs_review';
  else if (bill.action_status === 'paid') urgency = 'paid';
  else if (bill.action_status === 'waived') urgency = 'waived';
  else if (daysRemaining < 0) urgency = 'overdue';
  else if (daysRemaining <= 7) urgency = 'due_soon';
  else urgency = 'open';
  return { urgency, days_remaining: daysRemaining };
}

function maskedAccount(last4: string | null): string {
  return `•••• ${last4}`;
}

function presentBill(row: BillRow, today: string) {
  // Built by omitting the raw columns rather than deleting them afterwards:
  // `delete` on a required property is a type error, and the omission is also
  // what keeps account_ref_last4 out of the API response.
  const {
    account_ref_last4,
    notification_sim_index,
    notification_sim_number,
    ...rest
  } = row;
  return {
    ...rest,
    account_ref_masked: maskedAccount(account_ref_last4),
    notification_sim: {
      iccid: row.notification_sim_iccid,
      sim_index: notification_sim_index,
      number: notification_sim_number,
    },
    ...deriveBillUrgency(row, today),
  };
}

const BILL_SELECT = `
  SELECT
    b.*,
    a.display_name AS account_display_name,
    a.carrier,
    a.account_ref_last4,
    a.notification_sim_iccid,
    d.sim_index AS notification_sim_index,
    d.number AS notification_sim_number,
    (
      SELECT COUNT(*)
      FROM carrier_billing_account_sims s
      WHERE s.billing_account_id = a.id AND s.removed_at IS NULL
    ) AS linked_sim_count
  FROM carrier_bills b
  INNER JOIN carrier_billing_accounts a ON a.id = b.billing_account_id
  LEFT JOIN device_view d ON d.iccid = a.notification_sim_iccid
`;

async function findBill(db: D1Database, id: string | undefined): Promise<BillRow | null> {
  return db.prepare(`${BILL_SELECT} WHERE b.id = ?`).bind(id).first();
}

function parseMetadata(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? '{}'));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function billDetail(db: D1Database, id: string | undefined, today: string) {
  const row = await findBill(db, id);
  if (!row) return null;

  const [membersResult, eventsResult] = await Promise.all([
    db.prepare(`
      SELECT
        s.sim_iccid AS iccid,
        d.sim_index,
        d.number,
        s.verification_source,
        s.verified_at,
        s.verified_by
      FROM carrier_billing_account_sims s
      LEFT JOIN device_view d ON d.iccid = s.sim_iccid
      WHERE s.billing_account_id = ? AND s.removed_at IS NULL
      ORDER BY d.sim_index, s.sim_iccid
    `).bind(row.billing_account_id).all(),
    db.prepare(`
      SELECT id, event_type, actor_type, actor_subject, source_message_id,
        metadata_json, created_at
      FROM carrier_bill_events
      WHERE bill_id = ?
      ORDER BY created_at, id
    `).bind(id).all(),
  ]);

  let sourceMessage: Record<string, unknown> | null = null;
  if (row.source_message_id) {
    const source = await db.prepare(`
      SELECT id, phone_number AS sender, content, timestamp
      FROM messages WHERE id = ?
    `).bind(row.source_message_id).first();
    sourceMessage = source ?? null;
  }

  return {
    ...presentBill(row, today),
    linked_sims: membersResult.results,
    source_message: sourceMessage,
    events: eventsResult.results.map((event) => ({
      ...event,
      metadata: parseMetadata(event.metadata_json),
      metadata_json: undefined,
    })),
  };
}

const URGENCY_ORDER = new Map<string, number>([
  ['needs_review', 0],
  ['overdue', 1],
  ['due_soon', 2],
  ['open', 3],
  ['paid', 4],
  ['waived', 5],
]);

function validIsoDate(value: unknown): boolean {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

async function mutateBill(request: AppRequest, action: BillAction): Promise<Response> {
  const db = request.env.DB;
  const billId = request.params?.id;
  const actor = request.user?.id;
  const idempotencyKey = request.headers.get('Idempotency-Key')?.trim();
  if (!billId) return json({ error: 'Missing bill id' }, 400);
  if (!actor) return json({ error: 'Unauthorized' }, 401);
  if (!idempotencyKey || idempotencyKey.length > 200) {
    return json({ error: 'A bounded Idempotency-Key header is required' }, 400);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Body must be JSON' }, 400);
  }
  const expectedVersionRaw = body?.expected_version;
  if (typeof expectedVersionRaw !== 'number' || !Number.isInteger(expectedVersionRaw) || expectedVersionRaw < 1) {
    return json({ error: 'expected_version must be a positive integer' }, 400);
  }
  const expectedVersion = expectedVersionRaw;
  const note = body?.note ?? null;
  if (note !== null && (typeof note !== 'string' || note.trim().length > 1000)) {
    return json({ error: 'note must be a string of at most 1000 characters' }, 400);
  }

  const prior = await db.prepare(`
    SELECT bill_id FROM carrier_bill_events
    WHERE actor_subject = ? AND idempotency_key = ?
  `).bind(actor, idempotencyKey).first();
  if (prior) {
    if (prior.bill_id !== billId) {
      return json({ error: 'Idempotency key was already used for another bill' }, 409);
    }
    return json({
      success: true,
      idempotent: true,
      bill: await billDetail(db, billId, singaporeDate()),
    });
  }

  const current = await findBill(db, billId);
  if (!current) return json({ error: 'Bill not found' }, 404);
  if (current.version !== expectedVersion) {
    return json({
      error: 'Bill version conflict',
      current_version: current.version,
      bill: presentBill(current, singaporeDate()),
    }, 409);
  }

  const next = ({
    payment_planned: {
      status: 'payment_planned',
      event: 'payment_planned',
      planned: true,
      paid: false,
    },
    mark_paid: { status: 'paid', event: 'paid', planned: false, paid: true },
    waive: { status: 'waived', event: 'waived', planned: false, paid: false },
    reopen: { status: 'unpaid', event: 'reopened', planned: false, paid: false },
  } satisfies Record<BillAction, { status: string; event: string; planned: boolean; paid: boolean }>)[action];

  const eventId = crypto.randomUUID();
  const metadata = JSON.stringify({
    from: current.action_status,
    to: next.status,
    note: note?.trim() || null,
  });

  try {
    const results = await db.batch([
      db.prepare(`
        UPDATE carrier_bills
        SET action_status = ?,
            payment_planned_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
            paid_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
            paid_by = CASE WHEN ? = 1 THEN ? ELSE NULL END,
            operator_note = COALESCE(?, operator_note),
            version = version + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND version = ?
      `).bind(
        next.status,
        next.planned ? 1 : 0,
        next.paid ? 1 : 0,
        next.paid ? 1 : 0,
        actor,
        note?.trim() || null,
        billId,
        expectedVersion,
      ),
      db.prepare(`
        INSERT INTO carrier_bill_events (
          id, bill_id, event_type, actor_type, actor_subject,
          idempotency_key, metadata_json
        )
        SELECT ?, ?, ?, 'user', ?, ?, ?
        WHERE changes() = 1
      `).bind(eventId, billId, next.event, actor, idempotencyKey, metadata),
    ]);

    if (Number((results?.[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0) !== 1) {
      const latest = await findBill(db, billId);
      return json({
        error: 'Bill version conflict',
        current_version: latest?.version ?? null,
        bill: latest ? presentBill(latest, singaporeDate()) : null,
      }, 409);
    }
  } catch (error) {
    const raced = await db.prepare(`
      SELECT bill_id FROM carrier_bill_events
      WHERE actor_subject = ? AND idempotency_key = ?
    `).bind(actor, idempotencyKey).first();
    if (raced?.bill_id === billId) {
      return json({
        success: true,
        idempotent: true,
        bill: await billDetail(db, billId, singaporeDate()),
      });
    }
    throw error;
  }

  return json({ success: true, bill: await billDetail(db, billId, singaporeDate()) });
}

export const carrierBillsHandler = {
  async list(request: AppRequest, { today = singaporeDate() }: { today?: string } = {}) {
    const url = new URL(request.url);
    const clauses = [];
    const params = [];
    const carrier = url.searchParams.get('carrier');
    const accountId = url.searchParams.get('account_id');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const status = url.searchParams.get('status');

    if (carrier) {
      clauses.push('a.carrier = ?');
      params.push(carrier);
    }
    if (accountId) {
      clauses.push('a.id = ?');
      params.push(accountId);
    }
    if (from) {
      if (!validIsoDate(from)) return json({ error: 'from must be an ISO date' }, 400);
      clauses.push('b.due_date >= ?');
      params.push(from);
    }
    if (to) {
      if (!validIsoDate(to)) return json({ error: 'to must be an ISO date' }, 400);
      clauses.push('b.due_date <= ?');
      params.push(to);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const query = await request.env.DB.prepare(`
      ${BILL_SELECT}
      ${where}
      ORDER BY b.due_date, b.id
      LIMIT 500
    `).bind(...params).all<BillRow>();
    let bills = query.results.map((row) => presentBill(row, today));
    if (status) bills = bills.filter((bill) => bill.urgency === status || bill.action_status === status);
    bills.sort((left, right) => (
      (URGENCY_ORDER.get(left.urgency) ?? 99) - (URGENCY_ORDER.get(right.urgency) ?? 99)
      || left.due_date.localeCompare(right.due_date)
      || left.id.localeCompare(right.id)
    ));
    return json({ success: true, today, bills });
  },

  async listAccounts(request: AppRequest) {
    const [accountsResult, membersResult] = await Promise.all([
      request.env.DB.prepare(`
        SELECT
          a.id, a.country_code, a.carrier, a.currency, a.display_name,
          a.account_ref_last4, a.status, a.version, a.notification_sim_iccid,
          d.sim_index AS notification_sim_index,
          d.number AS notification_sim_number,
          (
            SELECT COUNT(*)
            FROM carrier_bills b
            WHERE b.billing_account_id = a.id
              AND b.action_status IN ('unpaid', 'payment_planned')
          ) AS payment_due_count
        FROM carrier_billing_accounts a
        LEFT JOIN device_view d ON d.iccid = a.notification_sim_iccid
        ORDER BY a.carrier, a.display_name, a.id
      `).bind().all<{ id: string; country_code: string; carrier: string; currency: string; display_name: string; account_ref_last4: string | null; status: string; version: number; notification_sim_iccid: string | null; notification_sim_index: number | null; notification_sim_number: string | null; payment_due_count: number }>(),
      request.env.DB.prepare(`
        SELECT
          s.billing_account_id,
          s.sim_iccid AS iccid,
          d.sim_index,
          d.number,
          s.verification_source,
          s.verified_at,
          s.verified_by
        FROM carrier_billing_account_sims s
        LEFT JOIN device_view d ON d.iccid = s.sim_iccid
        WHERE s.removed_at IS NULL
        ORDER BY s.billing_account_id, d.sim_index, s.sim_iccid
      `).bind().all<{ billing_account_id: string; iccid: string; sim_index: number | null; number: string | null; verification_source: string; verified_at: string | null; verified_by: string | null }>(),
    ]);
    const members = membersResult.results;
    const accounts = accountsResult.results.map((account) => ({
      id: account.id,
      country_code: account.country_code,
      carrier: account.carrier,
      currency: account.currency,
      display_name: account.display_name,
      account_ref_masked: maskedAccount(account.account_ref_last4),
      status: account.status,
      version: account.version,
      payment_due_count: Number(account.payment_due_count || 0),
      notification_sim: {
        iccid: account.notification_sim_iccid,
        sim_index: account.notification_sim_index,
        number: account.notification_sim_number,
      },
      linked_sims: members
        .filter((member) => member.billing_account_id === account.id)
        .map(({ billing_account_id: _accountId, ...member }) => member),
    }));
    return json({ success: true, accounts });
  },

  async get(request: AppRequest, { today = singaporeDate() }: { today?: string } = {}) {
    const bill = await billDetail(request.env.DB, request.params?.id, today);
    return bill ? json({ success: true, bill }) : json({ error: 'Bill not found' }, 404);
  },

  paymentPlanned: (request: AppRequest) => mutateBill(request, 'payment_planned'),
  markPaid: (request: AppRequest) => mutateBill(request, 'mark_paid'),
  waive: (request: AppRequest) => mutateBill(request, 'waive'),
  reopen: (request: AppRequest) => mutateBill(request, 'reopen'),
};
