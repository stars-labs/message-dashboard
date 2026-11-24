import { Phone } from '../../shared/api/phones.js';
import { queryAll, type D1 } from '../lib/d1.js';

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

export function listPhones(db: D1<'all'>): Promise<Phone[]> {
  return queryAll(
    db.prepare(
      `
        SELECT ${DEVICE_COLUMNS}
        FROM device_view dv
        ORDER BY dv.primary_port, dv.iccid
      `,
    ),
    Phone,
  );
}
