import type { AppRequest } from '../../shared/worker-context.js';

/** One row of device_view, aliased to the names the client consumes. */
interface DeviceRow {
  id: string;
  imei: string | null;
  iccid: string | null;
  number: string | null;
  country: string | null;
  carrier: string | null;
  service_type: string | null;
  service_type_source: string | null;
  service_type_verified_at: string | null;
  sim_role: string | null;
  primary_iccid: string | null;
  balance_threshold: number | null;
  status: string | null;
  signal: number | null;
  operator: string | null;
  manufacturer: string | null;
  model: string | null;
  usb_port: number | null;
  usb_path: string | null;
  last_usb_path: string | null;
  modem_status: string | null;
  sim_index: number | null;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
}

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
  async list(request: AppRequest): Promise<Response> {
    const { env } = request;

    try {
      if (!env.DB) {
        throw new Error('Database binding not found');
      }

      const { results } = await env.DB.prepare(`
        SELECT ${DEVICE_COLUMNS}
        FROM device_view dv
        ORDER BY dv.primary_port, dv.iccid
      `).all<DeviceRow>();

      return json({ success: true, data: results });
    } catch (error) {
      // Log error details server-side for debugging
      console.error('[Phones] List error:', (error as Error)?.stack || error);

      // Return generic error to client without exposing stack trace
      return json({ success: false, error: 'Failed to fetch phones' }, 500);
    }
  },

  // Get specific phone
  async get(request: AppRequest): Promise<Response> {
    const { env } = request;
    // The router only dispatches here for /api/phones/:id, so params is set.
    const phoneId = request.params?.id;

    try {
      const phone = await env.DB.prepare(`
        SELECT ${DEVICE_COLUMNS}
        FROM device_view dv
        WHERE dv.iccid = ? OR dv.id = ?
      `).bind(phoneId, phoneId).first<DeviceRow>();

      if (!phone) {
        return json({ success: false, error: 'Phone not found' }, 404);
      }

      return json({ success: true, data: phone });
    } catch {
      // Error handling - get phone
      return json({ success: false, error: 'Failed to fetch phone' }, 500);
    }
  },
};