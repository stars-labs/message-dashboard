import * as v from 'valibot';
import { queryAll, type D1 } from '../lib/d1.js';

interface ListRequest {
  env: { DB: D1<'all'> };
}

/** One row of device_view, aliased to the names the client consumes. */
const DeviceRow = v.object({
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

const DEVICE_COLUMNS = `
          dv.id,
          dv.equipment_id as imei,
          dv.iccid,
          dv.number,
          dv.country,
          dv.carrier,
          dv.service_type,
          dv.service_type_source,
          dv.service_type_verified_at,
          dv.sim_role,
          dv.primary_iccid,
          dv.balance_threshold,
          dv.sim_status as status,
          dv.signal_quality as signal,
          dv.operator,
          dv.manufacturer,
          dv.model,
          dv.primary_port as usb_port,
          dv.usb_path,
          dv.last_usb_path,
          dv.modem_status,
          dv.sim_index,
          dv.notes,
          dv.created_at,
          dv.updated_at`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const phonesHandler = {
  // List all phones
  async list(request: ListRequest): Promise<Response> {
    const { env } = request;

    try {
      const results = await queryAll(
        env.DB.prepare(
          `
        SELECT ${DEVICE_COLUMNS}
        FROM device_view dv
        ORDER BY dv.primary_port, dv.iccid
      `,
        ),
        DeviceRow,
      );

      return json({ success: true, data: results });
    } catch (error) {
      // Log error details server-side for debugging
      console.error('[Phones] List error:', (error instanceof Error && error.stack) || error);

      // Return generic error to client without exposing stack trace
      return json({ success: false, error: 'Failed to fetch phones' }, 500);
    }
  },
};
