import { parseSingtelPostpaidBillSms } from './singtel-postpaid-bill.js';

const RECONCILIATION_PAGE_SIZE = 100;
const SINGTEL_BILL_PREFIX = '<Singtel>Dear customer, your latest bill for Singtel a/c ';

async function eligibleReceivingSim(db, message) {
  return db.prepare(`
    SELECT iccid, sim_index
    FROM device_view
    WHERE iccid = ?
      AND country = 'SG'
      AND carrier = 'Singtel'
      AND service_type = 'postpaid'
  `).bind(message.phone_iccid).first();
}

async function activeStream(db, simIccid) {
  return db.prepare(`
    SELECT id, currency, account_ref_digest
    FROM carrier_billing_accounts
    WHERE notification_sim_iccid = ?
      AND status = 'active'
      AND country_code = 'SG'
      AND carrier = 'Singtel'
    LIMIT 1
  `).bind(simIccid).first();
}

async function ensureBillingStream(db, sim, parsed) {
  const existing = await activeStream(db, sim.iccid);
  if (existing) {
    if (existing.account_ref_digest !== parsed.account_ref_digest) return null;
    await db.prepare(`
      INSERT OR IGNORE INTO carrier_billing_account_sims (
        billing_account_id, sim_iccid, verification_source, verified_at, verified_by
      ) VALUES (?, ?, 'contract_or_bill', CURRENT_TIMESTAMP, 'system:sms')
    `).bind(existing.id, sim.iccid).run();
    return existing;
  }

  const accountId = crypto.randomUUID();
  const displayIndex = String(sim.sim_index ?? '').padStart(2, '0');
  await db.prepare(`
    INSERT OR IGNORE INTO carrier_billing_accounts (
      id, country_code, carrier, currency, display_name,
      notification_sim_iccid, account_ref_digest, account_ref_last4,
      status, created_by
    ) VALUES (?, 'SG', 'Singtel', 'SGD', ?, ?, ?, ?, 'active', 'system:sms')
  `).bind(
    accountId,
    `S${displayIndex} Singtel postpaid`,
    sim.iccid,
    parsed.account_ref_digest,
    parsed.account_ref_last4,
  ).run();

  const created = await activeStream(db, sim.iccid);
  if (created?.account_ref_digest !== parsed.account_ref_digest) return null;
  await db.prepare(`
    INSERT OR IGNORE INTO carrier_billing_account_sims (
      billing_account_id, sim_iccid, verification_source, verified_at, verified_by
    ) VALUES (?, ?, 'contract_or_bill', CURRENT_TIMESTAMP, 'system:sms')
  `).bind(created.id, sim.iccid).run();
  return created;
}

async function alreadyProcessed(db, sourceMessageId) {
  return db.prepare(`
    SELECT id AS bill_id
    FROM carrier_bills
    WHERE source_message_id = ?
    UNION ALL
    SELECT bill_id
    FROM carrier_bill_events
    WHERE source_message_id = ?
    LIMIT 1
  `).bind(sourceMessageId, sourceMessageId).first();
}

async function addSystemEvent(db, {
  billId,
  eventType,
  sourceMessageId,
  metadata,
}) {
  return db.prepare(`
    INSERT OR IGNORE INTO carrier_bill_events (
      id, bill_id, event_type, actor_type, source_message_id, metadata_json
    ) VALUES (?, ?, ?, 'system', ?, ?)
  `).bind(
    crypto.randomUUID(),
    billId,
    eventType,
    sourceMessageId,
    JSON.stringify(metadata),
  ).run();
}

async function storeParsedBill(db, account, message, parsed) {
  const prior = await alreadyProcessed(db, message.id);
  if (prior) {
    return { outcome: 'already_processed', bill_id: prior.bill_id };
  }

  const billId = crypto.randomUUID();
  const insert = await db.prepare(`
    INSERT OR IGNORE INTO carrier_bills (
      id, billing_account_id, source_message_id, amount_minor, currency,
      due_date, received_at, parser_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    billId,
    account.id,
    message.id,
    parsed.amount_minor,
    parsed.currency,
    parsed.due_date,
    message.timestamp,
    parsed.parser_version,
  ).run();

  if (Number(insert.meta?.changes ?? 0) === 1) {
    await addSystemEvent(db, {
      billId,
      eventType: 'detected',
      sourceMessageId: message.id,
      metadata: { source: 'sms' },
    });
    return { outcome: 'detected', bill_id: billId };
  }

  const existing = await db.prepare(`
    SELECT id, amount_minor, currency
    FROM carrier_bills
    WHERE billing_account_id = ? AND due_date = ?
  `).bind(account.id, parsed.due_date).first();
  if (!existing) {
    const raced = await alreadyProcessed(db, message.id);
    if (raced) return { outcome: 'already_processed', bill_id: raced.bill_id };
    throw new Error('Carrier bill insert was ignored without an existing bill');
  }

  const duplicate = existing.amount_minor === parsed.amount_minor
    && existing.currency === parsed.currency;
  const eventType = duplicate ? 'duplicate_detected' : 'parse_conflict';
  const event = await addSystemEvent(db, {
    billId: existing.id,
    eventType,
    sourceMessageId: message.id,
    metadata: duplicate
      ? { source: 'sms' }
      : {
          source: 'sms',
          observed_amount_minor: parsed.amount_minor,
          observed_currency: parsed.currency,
          retained_amount_minor: existing.amount_minor,
          retained_currency: existing.currency,
        },
  });

  if (!duplicate && Number(event.meta?.changes ?? 0) === 1) {
    await db.prepare(`
      UPDATE carrier_bills
      SET action_status = 'needs_review',
          version = version + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(existing.id).run();
  }

  return {
    outcome: duplicate ? 'duplicate_detected' : 'parse_conflict',
    bill_id: existing.id,
  };
}

export async function processCarrierBillMessage(db, message) {
  if (!message
    || message.type !== 'received'
    || message.phone_number !== 'Singtel'
    || typeof message.id !== 'string'
    || typeof message.phone_iccid !== 'string'
    || typeof message.content !== 'string'
    || typeof message.timestamp !== 'string') {
    return { outcome: 'ignored' };
  }

  const parsed = await parseSingtelPostpaidBillSms({
    sender: message.phone_number,
    content: message.content,
  });
  if (!parsed) return { outcome: 'ignored' };

  const sim = await eligibleReceivingSim(db, message);
  if (!sim) return { outcome: 'ignored' };

  const stream = await ensureBillingStream(db, sim, parsed);
  if (!stream || parsed.currency !== stream.currency) return { outcome: 'ignored' };
  return storeParsedBill(db, stream, message, parsed);
}

export async function processCarrierBillMessages(db, messages, {
  processMessage = processCarrierBillMessage,
  logError = console.error,
} = {}) {
  return Promise.all(messages.map(async (message) => {
    try {
      return await processMessage(db, message);
    } catch (error) {
      logError(`Carrier bill processing failed for message ${message?.id ?? 'unknown'}:`, error);
      return { outcome: 'failed' };
    }
  }));
}

export async function reconcileCarrierBillMessages(db, {
  pageSize = RECONCILIATION_PAGE_SIZE,
} = {}) {
  const limit = Math.max(1, Math.min(Number(pageSize) || RECONCILIATION_PAGE_SIZE, 500));
  const query = await db.prepare(`
    SELECT DISTINCT
      m.id,
      m.phone_iccid,
      m.phone_number,
      m.content,
      m.timestamp,
      m.type
    FROM messages m
    INNER JOIN device_view d
      ON d.iccid = m.phone_iccid
      AND d.country = 'SG'
      AND d.carrier = 'Singtel'
      AND d.service_type = 'postpaid'
    WHERE m.type = 'received'
      AND m.phone_number = 'Singtel'
      AND m.content LIKE ?
      AND NOT EXISTS (
        SELECT 1 FROM carrier_bills b WHERE b.source_message_id = m.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM carrier_bill_events e WHERE e.source_message_id = m.id
      )
    ORDER BY m.timestamp DESC, m.id DESC
    LIMIT ?
  `).bind(`${SINGTEL_BILL_PREFIX}%`, limit + 1).all();
  const candidates = query.results ?? [];
  const page = candidates.slice(0, limit);
  let detected = 0;

  for (const message of page) {
    const result = await processCarrierBillMessage(db, message);
    if (result.outcome === 'detected') detected += 1;
  }

  return {
    scanned: page.length,
    detected,
    remaining: candidates.length > limit ? 1 : 0,
  };
}
