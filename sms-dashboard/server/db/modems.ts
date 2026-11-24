import type * as v from 'valibot';
import type { DevicesBody } from '../../shared/api/daemon.js';
import { textOr } from '../../shared/text.js';
import type { D1, D1Batch } from '../lib/d1.js';

type ModemReport = v.InferOutput<typeof DevicesBody>['modem_reports'][number];

export async function upsertModemReports(
  db: D1<'run'> & D1Batch<'run'>,
  reports: ModemReport[],
  verificationStatus: string | null,
  lastVerifiedSession: string | null | undefined,
): Promise<void> {
  const statements = reports.map((report) =>
    db
      .prepare(
        `
        INSERT INTO modems (
          equipment_id, manufacturer, model, firmware_revision,
          hardware_revision, detected_iccid, detected_phone_number,
          detected_operator, signal_percent, rssi,
          modem_index, usb_port, usb_path, last_usb_path, status,
          verification_status, last_verified_session, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(equipment_id) DO UPDATE SET
          manufacturer = excluded.manufacturer,
          model = excluded.model,
          firmware_revision = excluded.firmware_revision,
          hardware_revision = excluded.hardware_revision,
          detected_iccid = excluded.detected_iccid,
          detected_phone_number = excluded.detected_phone_number,
          detected_operator = excluded.detected_operator,
          signal_percent = excluded.signal_percent,
          rssi = excluded.rssi,
          modem_index = excluded.modem_index,
          usb_port = excluded.usb_port,
          usb_path = excluded.usb_path,
          last_usb_path = COALESCE(excluded.last_usb_path, modems.last_usb_path),
          status = excluded.status,
          verification_status = COALESCE(excluded.verification_status, modems.verification_status),
          last_verified_session = COALESCE(excluded.last_verified_session, modems.last_verified_session),
          updated_at = CURRENT_TIMESTAMP
        WHERE modems.manufacturer IS NOT excluded.manufacturer
          OR modems.model IS NOT excluded.model
          OR modems.firmware_revision IS NOT excluded.firmware_revision
          OR modems.hardware_revision IS NOT excluded.hardware_revision
          OR modems.detected_iccid IS NOT excluded.detected_iccid
          OR modems.detected_phone_number IS NOT excluded.detected_phone_number
          OR modems.detected_operator IS NOT excluded.detected_operator
          OR modems.modem_index IS NOT excluded.modem_index
          OR modems.usb_port IS NOT excluded.usb_port
          OR modems.usb_path IS NOT excluded.usb_path
          OR modems.last_usb_path IS NOT COALESCE(excluded.last_usb_path, modems.last_usb_path)
          OR modems.status IS NOT excluded.status
          OR (excluded.verification_status IS NOT NULL
              AND modems.verification_status IS NOT excluded.verification_status)
          OR (excluded.last_verified_session IS NOT NULL
              AND modems.last_verified_session IS NOT excluded.last_verified_session)
          OR modems.signal_percent IS NOT excluded.signal_percent
          OR modems.rssi IS NOT excluded.rssi
      `,
      )
      .bind(
        report.equipment_id,
        textOr(report.manufacturer, null),
        textOr(report.model, null),
        textOr(report.firmware_revision, null),
        textOr(report.hardware_revision, null),
        textOr(report.detected_iccid, null),
        textOr(report.detected_phone_number, null),
        textOr(report.detected_operator, null),
        report.signal_percent ?? null,
        report.rssi ?? null,
        report.modem_index ?? null,
        report.usb_port ?? null,
        report.usb_path ?? null,
        report.usb_path ?? null,
        textOr(report.status, 'active'),
        verificationStatus,
        lastVerifiedSession,
      ),
  );

  if (statements.length > 0) await db.batch(statements);
}

export async function disconnectModems(db: D1<'run'>, equipmentIds: string[]): Promise<number> {
  const placeholders = equipmentIds.map(() => '?').join(',');
  const result = await db
    .prepare(
      `
          UPDATE modems
          SET status = 'disconnected',
              verification_status = 'absent',
              detected_iccid = NULL,
              detected_phone_number = NULL,
              detected_operator = NULL,
              signal_percent = NULL,
              rssi = NULL,
              usb_path = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE equipment_id IN (${placeholders})
            AND (
              status IS NOT 'disconnected'
              OR verification_status IS NOT 'absent'
              OR detected_iccid IS NOT NULL
              OR detected_phone_number IS NOT NULL
              OR detected_operator IS NOT NULL
              OR signal_percent IS NOT NULL
              OR rssi IS NOT NULL
              OR usb_path IS NOT NULL
            )
        `,
    )
    .bind(...equipmentIds)
    .run();
  return result.meta.changes;
}

export async function disconnectModemsAbsentFrom(
  db: D1<'run'>,
  presentEquipmentIds: string[],
): Promise<number> {
  const result = await db
    .prepare(
      `
          UPDATE modems
          SET status = 'disconnected',
              verification_status = 'absent',
              detected_iccid = NULL,
              detected_phone_number = NULL,
              detected_operator = NULL,
              signal_percent = NULL,
              rssi = NULL,
              usb_path = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE NOT EXISTS (
            SELECT 1 FROM json_each(?) AS present
            WHERE present.value = modems.equipment_id
          )
          AND (
            status IS NOT 'disconnected'
            OR verification_status IS NOT 'absent'
            OR detected_iccid IS NOT NULL
            OR detected_phone_number IS NOT NULL
            OR detected_operator IS NOT NULL
            OR signal_percent IS NOT NULL
            OR rssi IS NOT NULL
            OR usb_path IS NOT NULL
          )
        `,
    )
    .bind(JSON.stringify(presentEquipmentIds))
    .run();
  return result.meta.changes;
}
