import { ORPCError } from '@orpc/server';
import { Phone, type PhonesResponse } from '../../shared/api/phones.js';
import { queryAll, type D1 } from '../lib/d1.js';

interface ListCall {
  env: { DB: D1<'all'> };
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

export const phonesHandler = {
  // List all phones
  async list({ env }: ListCall): Promise<PhonesResponse> {
    try {
      const results = await queryAll(
        env.DB.prepare(
          `
        SELECT ${DEVICE_COLUMNS}
        FROM device_view dv
        ORDER BY dv.primary_port, dv.iccid
      `,
        ),
        Phone,
      );

      return { success: true, data: results };
    } catch (error) {
      // Log error details server-side for debugging
      console.error(
        '[Phones] List error:',
        error instanceof Error ? (error.stack ?? error) : error,
      );

      // Return generic error to client without exposing stack trace
      throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'Failed to fetch phones' });
    }
  },
};
