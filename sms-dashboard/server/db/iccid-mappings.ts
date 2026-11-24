import * as v from 'valibot';
import { queryAll, queryFirst, queryOne, type D1 } from '../lib/d1.js';
import {
  IccidMapping,
  IccidMappingDetail,
  SavedIccidMapping,
} from '../../shared/api/iccid-mappings.js';

const TotalRow = v.object({ total: v.number() });

const DETAIL_SELECT = `
  SELECT
    iccid as id, iccid, sim_index, number as phone_number,
    country, carrier, service_type, service_type_source,
    service_type_verified_at, equipment_id, notes,
    sim_status as is_active, signal_quality, modem_status, detected_iccid,
    operator, usb_path, last_usb_path, sim_role, primary_iccid,
    created_at, updated_at
  FROM device_view
  WHERE iccid = ?
`;

export function listIccidMappings(
  db: D1<'all'>,
  search: string,
  limit: number,
  offset: number,
): Promise<v.InferOutput<typeof IccidMapping>[]> {
  let sql = `
        SELECT
          iccid as id,
          iccid,
          sim_index,
          number as phone_number,
          country,
          carrier,
          service_type,
          service_type_source,
          service_type_verified_at,
          sim_role,
          primary_iccid,
          balance_threshold,
          equipment_id,
          notes,
          sim_status as is_active,
          signal_quality,
          modem_status,
          detected_iccid,
          operator,
          usb_path,
          last_usb_path,
          created_at,
          updated_at
        FROM device_view
        WHERE 1=1
      `;
  const params: unknown[] = [];

  if (search) {
    sql += ` AND (iccid LIKE ? OR number LIKE ? OR carrier LIKE ? OR notes LIKE ?)`;
    const searchPattern = `%${search}%`;
    params.push(searchPattern, searchPattern, searchPattern, searchPattern);
  }

  sql += ` ORDER BY sim_index ASC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  return queryAll(db.prepare(sql).bind(...params), IccidMapping);
}

export async function countIccidMappings(db: D1<'first'>, search: string): Promise<number> {
  let countQuery = `SELECT COUNT(*) as total FROM device_view WHERE 1=1`;
  const countParams: unknown[] = [];

  if (search) {
    countQuery += ` AND (iccid LIKE ? OR number LIKE ? OR carrier LIKE ? OR notes LIKE ?)`;
    const searchPattern = `%${search}%`;
    countParams.push(searchPattern, searchPattern, searchPattern, searchPattern);
  }

  const totalResult = await queryFirst(db.prepare(countQuery).bind(...countParams), TotalRow);
  return totalResult?.total ?? 0;
}

export function getIccidMappingDetail(
  db: D1<'first'>,
  iccid: string,
): Promise<v.InferOutput<typeof IccidMappingDetail> | null> {
  return queryFirst(db.prepare(DETAIL_SELECT).bind(iccid), IccidMappingDetail);
}

export function getSavedIccidMapping(
  db: D1<'first'>,
  iccid: string,
): Promise<v.InferOutput<typeof SavedIccidMapping>> {
  return queryOne(
    db
      .prepare(
        `
        SELECT
          iccid, sim_index, number as phone_number,
          country as country_code, carrier, equipment_id as imei,
          notes, service_type, service_type_source, service_type_verified_at,
          sim_role, primary_iccid, balance_threshold,
          sim_status as status, usb_path, last_usb_path,
          created_at, updated_at
        FROM device_view
        WHERE iccid = ?
      `,
      )
      .bind(iccid),
    SavedIccidMapping,
  );
}
