import { json } from '../lib/response.js';
import * as v from 'valibot';
import { parseJson, readJson } from '../../shared/parse-json.js';
import { queryAll, queryFirst, type D1, type D1Batch } from '../lib/d1.js';

type BillUrgency = 'needs_review' | 'paid' | 'waived' | 'overdue' | 'due_soon' | 'open';

type BillAction = 'payment_planned' | 'mark_paid' | 'waive' | 'reopen';

const ActionStatus = v.picklist(['unpaid', 'payment_planned', 'paid', 'waived', 'needs_review']);

const BILL_COLUMNS = [
  'id',
  'billing_account_id',
  'source_message_id',
  'amount_minor',
  'currency',
  'due_date',
  'received_at',
  'parser_version',
  'action_status',
  'payment_planned_at',
  'paid_at',
  'paid_by',
  'operator_note',
  'version',
  'created_at',
  'updated_at',
]
  .map((column) => `b.${column}`)
  .join(', ');

/** A carrier_bills row joined with its account and notification SIM. */
const BillRow = v.object({
  id: v.string(),
  billing_account_id: v.string(),
  source_message_id: v.nullable(v.string()),
  amount_minor: v.number(),
  currency: v.string(),
  due_date: v.string(),
  received_at: v.string(),
  parser_version: v.string(),
  action_status: ActionStatus,
  payment_planned_at: v.nullable(v.string()),
  paid_at: v.nullable(v.string()),
  paid_by: v.nullable(v.string()),
  operator_note: v.nullable(v.string()),
  version: v.number(),
  created_at: v.string(),
  updated_at: v.string(),
  account_display_name: v.string(),
  carrier: v.string(),
  account_ref_last4: v.string(),
  notification_sim_iccid: v.string(),
  notification_sim_index: v.nullable(v.number()),
  notification_sim_number: v.nullable(v.string()),
  linked_sim_count: v.number(),
});

type BillRow = v.InferOutput<typeof BillRow>;

const BillMemberRow = v.object({
  iccid: v.string(),
  sim_index: v.nullable(v.number()),
  number: v.nullable(v.string()),
  verification_source: v.string(),
  verified_at: v.string(),
  verified_by: v.string(),
});

const BillEventRow = v.object({
  id: v.string(),
  event_type: v.string(),
  actor_type: v.string(),
  actor_subject: v.nullable(v.string()),
  source_message_id: v.nullable(v.string()),
  metadata_json: v.string(),
  created_at: v.string(),
});

const SourceMessageRow = v.object({
  id: v.string(),
  sender: v.nullable(v.string()),
  content: v.string(),
  timestamp: v.nullable(v.string()),
});

const PriorEventRow = v.object({ bill_id: v.string() });

const AccountRow = v.object({
  id: v.string(),
  country_code: v.string(),
  carrier: v.string(),
  currency: v.string(),
  display_name: v.string(),
  account_ref_last4: v.string(),
  status: v.string(),
  version: v.number(),
  notification_sim_iccid: v.string(),
  notification_sim_index: v.nullable(v.number()),
  notification_sim_number: v.nullable(v.string()),
  payment_due_count: v.number(),
});

const AccountMemberRow = v.object({
  billing_account_id: v.string(),
  iccid: v.string(),
  sim_index: v.nullable(v.number()),
  number: v.nullable(v.string()),
  verification_source: v.string(),
  verified_at: v.string(),
  verified_by: v.string(),
});

/** Request body of the four bill mutations; the note is stored trimmed. */
const VERSION_MESSAGE = 'expected_version must be a positive integer';
const NOTE_MESSAGE = 'note must be a string of at most 1000 characters';

const MutationBody = v.object(
  {
    expected_version: v.pipe(
      v.number(VERSION_MESSAGE),
      v.integer(VERSION_MESSAGE),
      v.minValue(1, VERSION_MESSAGE),
    ),
    note: v.optional(
      v.nullable(v.pipe(v.string(NOTE_MESSAGE), v.trim(), v.maxLength(1000, NOTE_MESSAGE))),
    ),
  },
  VERSION_MESSAGE,
);

type BillDb = D1<'all' | 'first' | 'run'> & D1Batch<'all' | 'first' | 'run'>;

interface ListRequest {
  url: string;
  env: { DB: D1<'all'> };
}

interface AccountsRequest {
  env: { DB: D1<'all'> };
}

interface GetRequest {
  env: { DB: D1<'all' | 'first'> };
  params?: Record<string, string>;
}

interface MutationRequest {
  env: { DB: BillDb };
  user?: { id: string };
  params?: Record<string, string>;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
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

function maskedAccount(last4: string): string {
  return `•••• ${last4}`;
}

function presentBill(row: BillRow, today: string) {
  const { account_ref_last4, notification_sim_index, notification_sim_number, ...rest } = row;
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
    ${BILL_COLUMNS},
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

async function findBill(db: D1<'first'>, id: string | undefined): Promise<BillRow | null> {
  return queryFirst(db.prepare(`${BILL_SELECT} WHERE b.id = ?`).bind(id), BillRow);
}

function parseMetadata(text: string): unknown {
  const parsed = parseJson(text, v.unknown());
  return parsed.ok && typeof parsed.value === 'object' && parsed.value !== null ? parsed.value : {};
}

async function billDetail(db: D1<'all' | 'first'>, id: string | undefined, today: string) {
  const row = await findBill(db, id);
  if (!row) return null;

  const [members, events] = await Promise.all([
    queryAll(
      db
        .prepare(
          `
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
    `,
        )
        .bind(row.billing_account_id),
      BillMemberRow,
    ),
    queryAll(
      db
        .prepare(
          `
      SELECT id, event_type, actor_type, actor_subject, source_message_id,
        metadata_json, created_at
      FROM carrier_bill_events
      WHERE bill_id = ?
      ORDER BY created_at, id
    `,
        )
        .bind(id),
      BillEventRow,
    ),
  ]);

  const sourceMessage = row.source_message_id
    ? await queryFirst(
        db
          .prepare(
            `
      SELECT id, phone_number AS sender, content, timestamp
      FROM messages WHERE id = ?
    `,
          )
          .bind(row.source_message_id),
        SourceMessageRow,
      )
    : null;

  return {
    ...presentBill(row, today),
    linked_sims: members,
    source_message: sourceMessage,
    events: events.map(({ metadata_json: metadataJson, ...event }) => ({
      ...event,
      metadata: parseMetadata(metadataJson),
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

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = dateEpoch(value);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function emptyToNull(value: string | null | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}

async function mutateBill(request: MutationRequest, action: BillAction): Promise<Response> {
  const db = request.env.DB;
  const billId = request.params?.['id'];
  const actor = request.user?.id;
  const idempotencyKey = request.headers.get('Idempotency-Key')?.trim();
  if (!billId) return json({ error: 'Missing bill id' }, 400);
  if (!actor) return json({ error: 'Unauthorized' }, 401);
  if (!idempotencyKey || idempotencyKey.length > 200) {
    return json({ error: 'A bounded Idempotency-Key header is required' }, 400);
  }

  const raw = await readJson(request, v.unknown());
  if (!raw.ok) return json({ error: 'Body must be JSON' }, 400);
  const body = v.safeParse(MutationBody, raw.value);
  if (!body.success) return json({ error: body.issues[0].message }, 400);
  const expectedVersion = body.output.expected_version;
  const note = emptyToNull(body.output.note);

  const prior = await queryFirst(
    db
      .prepare(
        `
    SELECT bill_id FROM carrier_bill_events
    WHERE actor_subject = ? AND idempotency_key = ?
  `,
      )
      .bind(actor, idempotencyKey),
    PriorEventRow,
  );
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
    return json(
      {
        error: 'Bill version conflict',
        current_version: current.version,
        bill: presentBill(current, singaporeDate()),
      },
      409,
    );
  }

  const next = (
    {
      payment_planned: {
        status: 'payment_planned',
        event: 'payment_planned',
        planned: true,
        paid: false,
      },
      mark_paid: { status: 'paid', event: 'paid', planned: false, paid: true },
      waive: { status: 'waived', event: 'waived', planned: false, paid: false },
      reopen: { status: 'unpaid', event: 'reopened', planned: false, paid: false },
    } satisfies Record<
      BillAction,
      { status: string; event: string; planned: boolean; paid: boolean }
    >
  )[action];

  const eventId = crypto.randomUUID();
  const metadata = JSON.stringify({
    from: current.action_status,
    to: next.status,
    note,
  });

  try {
    const results = await db.batch([
      db
        .prepare(
          `
        UPDATE carrier_bills
        SET action_status = ?,
            payment_planned_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
            paid_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
            paid_by = CASE WHEN ? = 1 THEN ? ELSE NULL END,
            operator_note = COALESCE(?, operator_note),
            version = version + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND version = ?
      `,
        )
        .bind(
          next.status,
          next.planned ? 1 : 0,
          next.paid ? 1 : 0,
          next.paid ? 1 : 0,
          actor,
          note,
          billId,
          expectedVersion,
        ),
      db
        .prepare(
          `
        INSERT INTO carrier_bill_events (
          id, bill_id, event_type, actor_type, actor_subject,
          idempotency_key, metadata_json
        )
        SELECT ?, ?, ?, 'user', ?, ?, ?
        WHERE changes() = 1
      `,
        )
        .bind(eventId, billId, next.event, actor, idempotencyKey, metadata),
    ]);

    if (results[0]?.meta.changes !== 1) {
      const latest = await findBill(db, billId);
      return json(
        {
          error: 'Bill version conflict',
          current_version: latest?.version ?? null,
          bill: latest ? presentBill(latest, singaporeDate()) : null,
        },
        409,
      );
    }
  } catch (error) {
    const raced = await queryFirst(
      db
        .prepare(
          `
      SELECT bill_id FROM carrier_bill_events
      WHERE actor_subject = ? AND idempotency_key = ?
    `,
        )
        .bind(actor, idempotencyKey),
      PriorEventRow,
    );
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
  async list(request: ListRequest, { today = singaporeDate() }: { today?: string } = {}) {
    const url = new URL(request.url);
    const clauses: string[] = [];
    const params: string[] = [];
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
    const rows = await queryAll(
      request.env.DB.prepare(
        `
      ${BILL_SELECT}
      ${where}
      ORDER BY b.due_date, b.id
      LIMIT 500
    `,
      ).bind(...params),
      BillRow,
    );
    let bills = rows.map((row) => presentBill(row, today));
    if (status)
      bills = bills.filter((bill) => bill.urgency === status || bill.action_status === status);
    bills.sort(
      (left, right) =>
        (URGENCY_ORDER.get(left.urgency) ?? 99) - (URGENCY_ORDER.get(right.urgency) ?? 99) ||
        left.due_date.localeCompare(right.due_date) ||
        left.id.localeCompare(right.id),
    );
    return json({ success: true, today, bills });
  },

  async listAccounts(request: AccountsRequest) {
    const [accounts, members] = await Promise.all([
      queryAll(
        request.env.DB.prepare(
          `
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
      `,
        ),
        AccountRow,
      ),
      queryAll(
        request.env.DB.prepare(
          `
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
      `,
        ),
        AccountMemberRow,
      ),
    ]);
    return json({
      success: true,
      accounts: accounts.map((account) => ({
        id: account.id,
        country_code: account.country_code,
        carrier: account.carrier,
        currency: account.currency,
        display_name: account.display_name,
        account_ref_masked: maskedAccount(account.account_ref_last4),
        status: account.status,
        version: account.version,
        payment_due_count: account.payment_due_count,
        notification_sim: {
          iccid: account.notification_sim_iccid,
          sim_index: account.notification_sim_index,
          number: account.notification_sim_number,
        },
        linked_sims: members
          .filter((member) => member.billing_account_id === account.id)
          .map(({ billing_account_id: _accountId, ...member }) => member),
      })),
    });
  },

  async get(request: GetRequest, { today = singaporeDate() }: { today?: string } = {}) {
    const bill = await billDetail(request.env.DB, request.params?.['id'], today);
    return bill ? json({ success: true, bill }) : json({ error: 'Bill not found' }, 404);
  },

  paymentPlanned: (request: MutationRequest) => mutateBill(request, 'payment_planned'),
  markPaid: (request: MutationRequest) => mutateBill(request, 'mark_paid'),
  waive: (request: MutationRequest) => mutateBill(request, 'waive'),
  reopen: (request: MutationRequest) => mutateBill(request, 'reopen'),
};
