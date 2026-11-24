import type { ApiMessage } from '../../shared/api/messages.js';

interface OutgoingMessage {
  phone_iccid: string;
  recipient: string;
  content: string;
}

export function buildSentMessage(
  id: string,
  outgoing: OutgoingMessage,
  senderNumber: string,
): ApiMessage {
  return {
    id,
    phone_iccid: outgoing.phone_iccid,
    phone_number: senderNumber,
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
    display_phone_number: null,
    phone_carrier: null,
    phone_status: null,
    phone_sim_index: null,
    phone_country: null,
    mapped_number: null,
  };
}
