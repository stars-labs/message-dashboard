import * as v from 'valibot';
import { queryFirst, type D1 } from '../lib/d1.js';

const ExistingSimRow = v.object({
  iccid: v.string(),
  service_type: v.string(),
  service_type_source: v.nullable(v.string()),
  sim_role: v.string(),
  primary_iccid: v.nullable(v.string()),
});

export type ExistingSim = v.InferOutput<typeof ExistingSimRow>;

const PrimaryTargetRow = v.object({ sim_role: v.string() });

interface SimWrite {
  sim_index: number;
  phone_number: string;
  country_code: string | null;
  carrier: string | null;
  imei: string | null;
  notes: string | null;
  serviceType: string;
  serviceTypeSource: string | null;
  serviceTypeProvided: boolean;
  role: string;
  primaryIccid: string | null;
  balanceThreshold: number | null;
  updatedBy: string;
}

type BulkSimWrite = Omit<SimWrite, 'balanceThreshold'>;

export function getExistingSim(db: D1<'first'>, iccid: string): Promise<ExistingSim | null> {
  return queryFirst(
    db
      .prepare(
        `
  SELECT iccid, service_type, service_type_source, sim_role, primary_iccid
  FROM sims WHERE iccid = ?
`,
      )
      .bind(iccid),
    ExistingSimRow,
  );
}

export function getSimRole(db: D1<'first'>, iccid: string): Promise<{ sim_role: string } | null> {
  return queryFirst(
    db.prepare('SELECT sim_role FROM sims WHERE iccid = ?').bind(iccid),
    PrimaryTargetRow,
  );
}

export async function insertSim(db: D1<'run'>, iccid: string, sim: SimWrite): Promise<void> {
  await db
    .prepare(
      `
          INSERT INTO sims (
            iccid, sim_index, phone_number, country_code, carrier, imei, notes,
            service_type, service_type_source, service_type_verified_at,
            sim_role, primary_iccid, balance_threshold,
            updated_at, updated_by
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
            CASE WHEN ? = 'unknown' OR ? = 'balance_managed' THEN NULL ELSE CURRENT_TIMESTAMP END,
            ?, ?, ?,
            CURRENT_TIMESTAMP, ?)
        `,
    )
    .bind(
      iccid,
      sim.sim_index,
      sim.phone_number,
      sim.country_code,
      sim.carrier,
      sim.imei,
      sim.notes,
      sim.serviceType,
      sim.serviceTypeSource,
      sim.serviceType,
      sim.serviceType,
      sim.role,
      sim.primaryIccid,
      sim.balanceThreshold,
      sim.updatedBy,
    )
    .run();
}

export async function updateSimByUpsert(
  db: D1<'run'>,
  iccid: string,
  sim: SimWrite,
): Promise<void> {
  await db
    .prepare(
      `
          UPDATE sims
          SET sim_index = ?, phone_number = ?, country_code = ?, carrier = ?, imei = ?, notes = ?,
              service_type = ?, service_type_source = ?,
              service_type_verified_at = CASE
                WHEN ? = 0 THEN service_type_verified_at
                WHEN ? = 'unknown' OR ? = 'balance_managed' THEN NULL
                ELSE CURRENT_TIMESTAMP
              END,
              sim_role = ?,
              primary_iccid = ?,
              balance_threshold = ?,
              updated_at = CURRENT_TIMESTAMP, updated_by = ?
          WHERE iccid = ?
        `,
    )
    .bind(
      sim.sim_index,
      sim.phone_number,
      sim.country_code,
      sim.carrier,
      sim.imei,
      sim.notes,
      sim.serviceType,
      sim.serviceTypeSource,
      sim.serviceTypeProvided ? 1 : 0,
      sim.serviceType,
      sim.serviceType,
      sim.role,
      sim.primaryIccid,
      sim.balanceThreshold,
      sim.updatedBy,
      iccid,
    )
    .run();
}

export async function updateSim(db: D1<'run'>, iccid: string, sim: SimWrite): Promise<void> {
  await db
    .prepare(
      `
        UPDATE sims
        SET
          phone_number = ?,
          sim_index = ?,
          country_code = ?,
          carrier = ?,
          imei = ?,
          notes = ?,
          service_type = ?,
          service_type_source = ?,
          service_type_verified_at = CASE
            WHEN ? = 0 THEN service_type_verified_at
            WHEN ? = 'unknown' OR ? = 'balance_managed' THEN NULL
            ELSE CURRENT_TIMESTAMP
          END,
          sim_role = ?,
          primary_iccid = ?,
          balance_threshold = ?,
          updated_at = CURRENT_TIMESTAMP,
          updated_by = ?
        WHERE iccid = ?
      `,
    )
    .bind(
      sim.phone_number,
      sim.sim_index,
      sim.country_code,
      sim.carrier,
      sim.imei,
      sim.notes,
      sim.serviceType,
      sim.serviceTypeSource,
      sim.serviceTypeProvided ? 1 : 0,
      sim.serviceType,
      sim.serviceType,
      sim.role,
      sim.primaryIccid,
      sim.balanceThreshold,
      sim.updatedBy,
      iccid,
    )
    .run();
}

export async function deleteSim(db: D1<'run'>, iccid: string): Promise<void> {
  await db
    .prepare(
      `
        DELETE FROM sims WHERE iccid = ?
      `,
    )
    .bind(iccid)
    .run();
}

export async function updateSimFromImport(
  db: D1<'run'>,
  iccid: string,
  sim: BulkSimWrite,
): Promise<void> {
  await db
    .prepare(
      `
              UPDATE sims
              SET
                sim_index = ?,
                phone_number = ?,
                country_code = ?,
                carrier = ?,
                imei = ?,
                notes = ?,
                service_type = ?,
                service_type_source = ?,
                service_type_verified_at = CASE
                  WHEN ? = 0 THEN service_type_verified_at
                  WHEN ? = 'unknown' OR ? = 'balance_managed' THEN NULL
                  ELSE CURRENT_TIMESTAMP
                END,
                sim_role = ?,
                primary_iccid = ?,
                updated_at = CURRENT_TIMESTAMP,
                updated_by = ?
              WHERE iccid = ?
            `,
    )
    .bind(
      sim.sim_index,
      sim.phone_number,
      sim.country_code,
      sim.carrier,
      sim.imei,
      sim.notes,
      sim.serviceType,
      sim.serviceTypeSource,
      sim.serviceTypeProvided ? 1 : 0,
      sim.serviceType,
      sim.serviceType,
      sim.role,
      sim.primaryIccid,
      sim.updatedBy,
      iccid,
    )
    .run();
}

export async function insertSimFromImport(
  db: D1<'run'>,
  iccid: string,
  sim: BulkSimWrite,
): Promise<void> {
  await db
    .prepare(
      `
              INSERT INTO sims (
                iccid, sim_index, phone_number, country_code, carrier, imei, notes,
                service_type, service_type_source, service_type_verified_at,
                sim_role, primary_iccid,
                updated_at, updated_by
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
                CASE WHEN ? = 'unknown' OR ? = 'balance_managed' THEN NULL ELSE CURRENT_TIMESTAMP END,
                ?, ?,
                CURRENT_TIMESTAMP, ?)
            `,
    )
    .bind(
      iccid,
      sim.sim_index,
      sim.phone_number,
      sim.country_code,
      sim.carrier,
      sim.imei,
      sim.notes,
      sim.serviceType,
      sim.serviceTypeSource,
      sim.serviceType,
      sim.serviceType,
      sim.role,
      sim.primaryIccid,
      sim.updatedBy,
    )
    .run();
}
