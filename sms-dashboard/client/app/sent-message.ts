import type { ApiMessage } from '../../shared/api/messages.js';
import type { Phone } from '../../shared/api/phones.js';
import { textOr } from '../../shared/text.js';

interface OutgoingMessage {
  phone_iccid: string;
  recipient: string;
  content: string;
}

export function buildSentMessage(
  id: string,
  outgoing: OutgoingMessage,
  sender: Pick<Phone, 'number' | 'sim_index' | 'country'> | undefined,
): ApiMessage {
  const senderNumber = textOr(sender?.number, null);
  return {
    id,
    phone_iccid: outgoing.phone_iccid,
    phone_number: senderNumber ?? outgoing.phone_iccid,
    recipient: outgoing.recipient,
    content: outgoing.content,
    timestamp: new Date().toISOString(),
    type: 'sent',
    status: 'sending',
    verification_code: null,
    created_at: null,
    updated_at: null,
    error_message: null,
    sms_id: null,
    filter_status: 'clean',
    filter_rule_id: null,
    purpose: 'user',
    balance_check_id: null,
    processing_session_id: null,
    display_phone_number: senderNumber,
    phone_carrier: null,
    phone_status: null,
    phone_sim_index: sender?.sim_index ?? null,
    phone_country: sender?.country ?? null,
    mapped_number: null,
  };
}
