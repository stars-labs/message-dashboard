import * as v from 'valibot';

/** A message as GET /api/messages returns it: the row plus its SIM's device fields. */
export const ApiMessage = v.object({
  id: v.string(),
  phone_iccid: v.nullable(v.string()),
  phone_number: v.nullable(v.string()),
  content: v.string(),
  timestamp: v.nullable(v.string()),
  type: v.nullable(v.string()),
  status: v.nullable(v.string()),
  recipient: v.nullable(v.string()),
  verification_code: v.nullable(v.string()),
  created_at: v.nullable(v.string()),
  updated_at: v.nullable(v.string()),
  error_message: v.nullable(v.string()),
  sms_id: v.nullable(v.string()),
  filter_status: v.string(),
  filter_rule_id: v.nullable(v.number()),
  purpose: v.string(),
  balance_check_id: v.nullable(v.string()),
  processing_session_id: v.nullable(v.string()),
  display_phone_number: v.nullable(v.string()),
  phone_carrier: v.nullable(v.string()),
  phone_status: v.nullable(v.string()),
  phone_sim_index: v.nullable(v.number()),
  phone_country: v.nullable(v.string()),
  mapped_number: v.null(),
});

export type ApiMessage = v.InferOutput<typeof ApiMessage>;

/** GET /api/messages. An incremental page (`since` given) pages by cursor, a full one by offset. */
export const MessagePage = v.object({
  success: v.literal(true),
  data: v.array(ApiMessage),
  pagination: v.object({
    include_filtered: v.boolean(),
    limit: v.number(),
    offset: v.number(),
    has_more: v.boolean(),
    next_offset: v.nullable(v.number()),
    next_cursor: v.nullable(v.object({ created_at: v.nullable(v.string()), id: v.string() })),
  }),
  sync: v.object({
    server_time: v.string(),
    is_incremental: v.boolean(),
    status_refreshed: v.number(),
  }),
});

export type MessagePage = v.InferOutput<typeof MessagePage>;

/** POST /api/messages/send: the queued outbound message. */
export const SendMessageResponse = v.object({
  success: v.literal(true),
  messageId: v.string(),
  data: v.object({
    id: v.string(),
    phone_iccid: v.string(),
    recipient: v.string(),
    content: v.string(),
    timestamp: v.string(),
    type: v.literal('sent'),
    status: v.literal('pending'),
  }),
});

export type SendMessageResponse = v.InferOutput<typeof SendMessageResponse>;
