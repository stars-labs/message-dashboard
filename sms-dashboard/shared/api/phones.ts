import * as v from 'valibot';

/** One SIM slot as GET /api/phones returns it: a device_view row under the client's names. */
export const Phone = v.object({
  id: v.string(),
  imei: v.nullable(v.string()),
  iccid: v.string(),
  number: v.string(),
  country: v.nullable(v.string()),
  carrier: v.nullable(v.string()),
  service_type: v.string(),
  service_type_source: v.nullable(v.string()),
  service_type_verified_at: v.nullable(v.string()),
  sim_role: v.string(),
  primary_iccid: v.nullable(v.string()),
  balance_threshold: v.nullable(v.number()),
  status: v.string(),
  signal: v.nullable(v.number()),
  operator: v.nullable(v.string()),
  manufacturer: v.nullable(v.string()),
  model: v.nullable(v.string()),
  usb_port: v.nullable(v.number()),
  usb_path: v.nullable(v.string()),
  last_usb_path: v.nullable(v.string()),
  modem_status: v.nullable(v.string()),
  sim_index: v.number(),
  notes: v.nullable(v.string()),
  created_at: v.nullable(v.string()),
  updated_at: v.nullable(v.string()),
});

export type Phone = v.InferOutput<typeof Phone>;

export const PhonesResponse = v.object({ success: v.literal(true), data: v.array(Phone) });

export type PhonesResponse = v.InferOutput<typeof PhonesResponse>;
