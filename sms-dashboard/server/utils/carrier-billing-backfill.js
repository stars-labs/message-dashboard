import { parseSingtelPostpaidBillSms } from './singtel-postpaid-bill.js';

const BILL_PREFIX = '<Singtel>Dear customer, your latest bill for Singtel a/c ';
const BILL_FRAGMENT_SUFFIX = 'ill via My Singtel app at www.singtel.com/viewbill .@';
const MAX_FRAGMENT_GAP_MS = 5 * 60 * 1000;

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

async function dispositionFor(db, accountId, candidate) {
  const placeholders = candidate.source_message_ids.map(() => '?').join(', ');
  const processed = await db.prepare(`
    SELECT id AS bill_id
    FROM carrier_bills
    WHERE source_message_id IN (${placeholders})
    UNION ALL
    SELECT bill_id
    FROM carrier_bill_events
    WHERE source_message_id IN (${placeholders})
    LIMIT 1
  `).bind(
    ...candidate.source_message_ids,
    ...candidate.source_message_ids,
  ).first();
  if (processed) return 'already_processed';

  const cycle = await db.prepare(`
    SELECT amount_minor, currency
    FROM carrier_bills
    WHERE billing_account_id = ? AND due_date = ?
  `).bind(accountId, candidate.due_date).first();
  if (!cycle) return 'new';
  return cycle.amount_minor === candidate.amount_minor && cycle.currency === candidate.currency
    ? 'duplicate'
    : 'conflict';
}

export async function previewCarrierBillBackfill(db, accountId) {
  const account = await db.prepare(`
    SELECT
      a.id, a.display_name, a.account_ref_digest, a.account_ref_last4,
      a.notification_sim_iccid, a.status, a.version,
      d.sim_index AS notification_sim_index
    FROM carrier_billing_accounts a
    INNER JOIN device_view d
      ON d.iccid = a.notification_sim_iccid
      AND d.country = 'SG'
      AND d.carrier = 'Singtel'
      AND d.service_type = 'postpaid'
    WHERE a.id = ?
      AND a.status = 'active'
      AND a.country_code = 'SG'
      AND a.carrier = 'Singtel'
      AND EXISTS (
        SELECT 1 FROM carrier_billing_account_sims s
        WHERE s.billing_account_id = a.id
          AND s.sim_iccid = a.notification_sim_iccid
          AND s.removed_at IS NULL
      )
  `).bind(accountId).first();
  if (!account) {
    const error = new Error('Billing account must be active with a verified notification SIM');
    error.code = 'ACCOUNT_NOT_READY';
    throw error;
  }

  const query = await db.prepare(`
    SELECT id, phone_iccid, phone_number, content, timestamp, type
    FROM messages
    WHERE phone_iccid = ?
      AND phone_number = 'Singtel'
      AND type = 'received'
      AND (instr(content, ?) = 1 OR trim(content) = ?)
    ORDER BY timestamp, id
  `).bind(
    account.notification_sim_iccid,
    BILL_PREFIX,
    BILL_FRAGMENT_SUFFIX,
  ).all();
  const messages = query.results ?? [];
  const used = new Set();
  const candidates = [];

  for (let index = 0; index < messages.length; index += 1) {
    const first = messages[index];
    if (used.has(first.id) || !first.content.startsWith(BILL_PREFIX)) continue;

    let content = first.content;
    let sourceMessages = [first];
    let parsed = await parseSingtelPostpaidBillSms({
      sender: 'Singtel',
      content,
      expectedAccountRefDigest: account.account_ref_digest,
    });
    let reassembled = false;

    if (!parsed && content.endsWith('b')) {
      const firstTime = Date.parse(first.timestamp);
      const second = messages.slice(index + 1).find((message) => {
        if (used.has(message.id) || message.content.trim() !== BILL_FRAGMENT_SUFFIX) return false;
        const gap = Date.parse(message.timestamp) - firstTime;
        return Number.isFinite(gap) && gap >= 0 && gap <= MAX_FRAGMENT_GAP_MS;
      });
      if (second) {
        content = `${content}${second.content.trim()}`;
        parsed = await parseSingtelPostpaidBillSms({
          sender: 'Singtel',
          content,
          expectedAccountRefDigest: account.account_ref_digest,
        });
        if (parsed) {
          sourceMessages = [first, second];
          used.add(second.id);
          reassembled = true;
        }
      }
    }
    if (!parsed) continue;
    used.add(first.id);
    candidates.push({
      source_message_ids: sourceMessages.map((message) => message.id),
      source_kind: reassembled ? 'reassembled' : 'complete',
      amount_minor: parsed.amount_minor,
      currency: parsed.currency,
      due_date: parsed.due_date,
      received_at: first.timestamp,
      parser_version: parsed.parser_version,
      message: {
        id: first.id,
        phone_iccid: first.phone_iccid,
        phone_number: 'Singtel',
        content,
        timestamp: first.timestamp,
        type: 'received',
      },
    });
  }

  candidates.sort((left, right) => left.due_date.localeCompare(right.due_date));
  for (const candidate of candidates) {
    candidate.disposition = await dispositionFor(db, accountId, candidate);
  }
  const digestEvidence = candidates.map((candidate) => ({
    source_message_ids: candidate.source_message_ids,
    source_kind: candidate.source_kind,
    amount_minor: candidate.amount_minor,
    currency: candidate.currency,
    due_date: candidate.due_date,
    received_at: candidate.received_at,
    parser_version: candidate.parser_version,
  }));
  const summary = {
    candidates: candidates.length,
    complete_messages: candidates.filter((candidate) => candidate.source_kind === 'complete').length,
    reassembled_messages: candidates.filter((candidate) => candidate.source_kind === 'reassembled').length,
    new_bills: candidates.filter((candidate) => candidate.disposition === 'new').length,
    duplicates: candidates.filter((candidate) => candidate.disposition === 'duplicate').length,
    conflicts: candidates.filter((candidate) => candidate.disposition === 'conflict').length,
    already_processed: candidates.filter((candidate) => candidate.disposition === 'already_processed').length,
  };

  return {
    account: {
      id: account.id,
      display_name: account.display_name,
      account_ref_masked: `•••• ${account.account_ref_last4}`,
      version: account.version,
      notification_sim: {
        iccid: account.notification_sim_iccid,
        sim_index: account.notification_sim_index,
      },
    },
    summary,
    candidates,
    preview_digest: await sha256(JSON.stringify({
      account_id: accountId,
      account_version: account.version,
      candidates: digestEvidence,
    })),
  };
}
