import { ORPCError } from '@orpc/server';
import * as v from 'valibot';
import { queryAll, queryFirst, queryOne, type D1 } from '../lib/d1.js';
import { errorText } from '../../shared/error-text.js';
import {
  IccidMapping,
  IccidMappingDetail,
  SavedIccidMapping,
  SimMapping,
  type BulkIccidMappingsBody,
  type BulkIccidMappingsResponse,
  type CreateIccidMappingBody,
  type CreateIccidMappingResponse,
  type DeleteIccidMappingResponse,
  type IccidMappingDetailResponse,
  type IccidMappingsQuery,
  type IccidMappingsResponse,
  type UpdateIccidMappingBody,
  type UpdateIccidMappingResponse,
} from '../../shared/api/iccid-mappings.js';

const SIM_SERVICE_TYPES = ['unknown', 'prepaid', 'postpaid', 'balance_managed'] as const;
const SIM_SERVICE_TYPE_SOURCES = [
  'carrier_account',
  'carrier_support',
  'contract_or_bill',
  'carrier_message',
] as const;
const SIM_ROLES = ['standalone', 'primary', 'secondary'] as const;

const ServiceType = v.picklist(SIM_SERVICE_TYPES);
const ServiceTypeSource = v.picklist(SIM_SERVICE_TYPE_SOURCES);
const SimRole = v.picklist(SIM_ROLES);

type SimServiceType = v.InferOutput<typeof ServiceType>;
type SimServiceTypeSource = v.InferOutput<typeof ServiceTypeSource>;
type SimRole = v.InferOutput<typeof SimRole>;

const ExistingSimRow = v.object({
  iccid: v.string(),
  service_type: v.string(),
  service_type_source: v.nullable(v.string()),
  sim_role: v.string(),
  primary_iccid: v.nullable(v.string()),
});

type ExistingSim = v.InferOutput<typeof ExistingSimRow>;

const PrimaryTargetRow = v.object({ sim_role: v.string() });

const TotalRow = v.object({ total: v.number() });

const PositiveIntegerText = v.pipe(v.string(), v.regex(/^[1-9]\d*$/), v.transform(Number));

type ServiceTypeResolution =
  | {
      serviceType: SimServiceType;
      serviceTypeSource: SimServiceTypeSource | null;
      serviceTypeProvided: boolean;
    }
  | { error: string };

type SimRoleResolution =
  { role: SimRole; primaryIccid: string | null; roleProvided: boolean } | { error: string };

interface ServiceTypeInput {
  service_type?: string | null | undefined;
  service_type_source?: string | null | undefined;
}

interface SimRoleInput {
  sim_role?: string | null | undefined;
  primary_iccid?: string | null | undefined;
}

interface Operator {
  email?: string | undefined;
}

interface ReadCall {
  env: { DB: D1<'all' | 'first'> };
}

interface WriteCall {
  env: { DB: D1<'first' | 'run'> };
  user?: Operator | undefined;
}

function badRequest(message: string): ORPCError<'BAD_REQUEST', unknown> {
  return new ORPCError('BAD_REQUEST', { message });
}

/** Answers `error`: a refusal the handler chose stands; anything else is logged and is `message`. */
function fail(error: unknown, label: string, message: string): never {
  if (error instanceof ORPCError) throw error;
  console.error(`[iccid-mappings] ${label}:`, error);
  throw new ORPCError('INTERNAL_SERVER_ERROR', { message });
}

function positiveInteger(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw === '') return fallback;
  const parsed = v.safeParse(PositiveIntegerText, raw);
  return parsed.success ? parsed.output : null;
}

function emptyToNull(value: string | null | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}

function updatedBy(user: Operator | undefined): string {
  const email = user?.email;
  return email === undefined || email === '' ? 'system' : email;
}

export function resolveServiceType(
  data: ServiceTypeInput,
  existing: Pick<ExistingSim, 'service_type' | 'service_type_source'> | null = null,
): ServiceTypeResolution {
  const serviceTypeProvided = 'service_type' in data || 'service_type_source' in data;
  const requested =
    'service_type' in data ? emptyToNull(data.service_type) : emptyToNull(existing?.service_type);
  const serviceType = v.safeParse(ServiceType, requested ?? 'unknown');

  if (!serviceType.success) {
    return { error: 'service_type must be unknown, prepaid, postpaid, or balance_managed' };
  }

  if (serviceType.output === 'unknown' || serviceType.output === 'balance_managed') {
    return { serviceType: serviceType.output, serviceTypeSource: null, serviceTypeProvided };
  }

  const requestedSource =
    'service_type_source' in data
      ? emptyToNull(data.service_type_source)
      : emptyToNull(existing?.service_type_source);
  const serviceTypeSource = v.safeParse(ServiceTypeSource, requestedSource);

  if (!serviceTypeSource.success) {
    return {
      error: 'A valid service_type_source is required for prepaid or postpaid SIMs',
    };
  }

  return {
    serviceType: serviceType.output,
    serviceTypeSource: serviceTypeSource.output,
    serviceTypeProvided,
  };
}

/** Async because a secondary must point at a real primary SIM, a cross-row lookup the SQL triggers cannot do safely. */
export async function resolveSimRole(
  data: SimRoleInput,
  existing: Pick<ExistingSim, 'sim_role' | 'primary_iccid'> | null,
  env: { DB: D1<'first'> },
): Promise<SimRoleResolution> {
  const roleProvided = 'sim_role' in data || 'primary_iccid' in data;
  const requested =
    'sim_role' in data ? emptyToNull(data.sim_role) : emptyToNull(existing?.sim_role);
  const role = v.safeParse(SimRole, requested ?? 'standalone');

  if (!role.success) {
    return { error: 'sim_role must be standalone, primary, or secondary' };
  }

  let primaryIccid: string | null = null;
  if (role.output === 'secondary') {
    primaryIccid =
      'primary_iccid' in data
        ? emptyToNull(data.primary_iccid)
        : emptyToNull(existing?.primary_iccid);
    if (primaryIccid === null) {
      return { error: 'primary_iccid is required for a secondary SIM' };
    }
    const target = await queryFirst(
      env.DB.prepare('SELECT sim_role FROM sims WHERE iccid = ?').bind(primaryIccid),
      PrimaryTargetRow,
    );
    if (!target) return { error: 'primary_iccid does not match any SIM' };
    if (target.sim_role !== 'primary') {
      return { error: `primary_iccid points to a ${target.sim_role} SIM, not a primary` };
    }
  }

  return { role: role.output, primaryIccid, roleProvided };
}

const EXISTING_SIM_SELECT = `
  SELECT iccid, service_type, service_type_source, sim_role, primary_iccid
  FROM sims WHERE iccid = ?
`;

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

export const iccidMappingsHandler = {
  async list(
    { env }: ReadCall,
    query: v.InferOutput<typeof IccidMappingsQuery>,
  ): Promise<IccidMappingsResponse> {
    const page = positiveInteger(query.page, 1);
    const limit = positiveInteger(query.limit, 20);
    if (page === null || limit === null) {
      throw badRequest('page and limit must be positive integers');
    }
    const search = query.search ?? '';
    const offset = (page - 1) * limit;

    try {
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

      const mappings = await queryAll(env.DB.prepare(sql).bind(...params), IccidMapping);

      let countQuery = `SELECT COUNT(*) as total FROM device_view WHERE 1=1`;
      const countParams: unknown[] = [];

      if (search) {
        countQuery += ` AND (iccid LIKE ? OR number LIKE ? OR carrier LIKE ? OR notes LIKE ?)`;
        const searchPattern = `%${search}%`;
        countParams.push(searchPattern, searchPattern, searchPattern, searchPattern);
      }

      const totalResult = await queryFirst(
        env.DB.prepare(countQuery).bind(...countParams),
        TotalRow,
      );
      const total = totalResult?.total ?? 0;

      return {
        success: true,
        data: mappings,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      fail(
        error,
        'Error listing ICCID mappings',
        `Failed to fetch ICCID mappings: ${errorText(error)}`,
      );
    }
  },

  async get({ env }: ReadCall, id: string): Promise<IccidMappingDetailResponse> {
    try {
      const mapping = await queryFirst(env.DB.prepare(DETAIL_SELECT).bind(id), IccidMappingDetail);
      if (!mapping) throw new ORPCError('NOT_FOUND', { message: 'ICCID mapping not found' });
      return { success: true, data: mapping };
    } catch (error) {
      fail(error, 'Error fetching ICCID mapping', 'Failed to fetch ICCID mapping');
    }
  },

  async getByIccid({ env }: ReadCall, iccid: string): Promise<IccidMappingDetailResponse> {
    try {
      const mapping = await queryFirst(
        env.DB.prepare(DETAIL_SELECT).bind(iccid),
        IccidMappingDetail,
      );
      if (!mapping) throw new ORPCError('NOT_FOUND', { message: 'ICCID not found' });
      return { success: true, data: mapping };
    } catch (error) {
      fail(error, 'Error fetching ICCID by ID', 'Failed to fetch ICCID mapping');
    }
  },

  async create(
    { env, user }: WriteCall,
    data: v.InferOutput<typeof CreateIccidMappingBody>,
  ): Promise<{ status: 200 | 201; body: CreateIccidMappingResponse }> {
    try {
      const { iccid, phone_number, sim_index, country_code, carrier, imei, notes } = data;
      const balanceThreshold = data.balance_threshold ?? null;

      const simExists = await queryFirst(
        env.DB.prepare(EXISTING_SIM_SELECT).bind(iccid),
        ExistingSimRow,
      );
      const service = resolveServiceType(data, simExists);
      if ('error' in service) throw badRequest(service.error);
      const role = await resolveSimRole(data, simExists, env);
      if ('error' in role) throw badRequest(role.error);

      if (!simExists) {
        await env.DB.prepare(
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
            sim_index,
            phone_number,
            emptyToNull(country_code),
            emptyToNull(carrier),
            emptyToNull(imei),
            emptyToNull(notes),
            service.serviceType,
            service.serviceTypeSource,
            service.serviceType,
            service.serviceType,
            role.role,
            role.primaryIccid,
            balanceThreshold,
            updatedBy(user),
          )
          .run();
      } else {
        await env.DB.prepare(
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
            sim_index,
            phone_number,
            emptyToNull(country_code),
            emptyToNull(carrier),
            emptyToNull(imei),
            emptyToNull(notes),
            service.serviceType,
            service.serviceTypeSource,
            service.serviceTypeProvided ? 1 : 0,
            service.serviceType,
            service.serviceType,
            role.role,
            role.primaryIccid,
            balanceThreshold,
            updatedBy(user),
            iccid,
          )
          .run();
      }

      const mapping = await queryOne(
        env.DB.prepare(
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
        ).bind(iccid),
        SavedIccidMapping,
      );

      return { status: simExists ? 200 : 201, body: { success: true, data: mapping } };
    } catch (error) {
      fail(
        error,
        'Error creating ICCID mapping',
        `Failed to create ICCID mapping: ${errorText(error)}`,
      );
    }
  },

  async update(
    { env, user }: WriteCall,
    id: string,
    data: v.InferOutput<typeof UpdateIccidMappingBody>,
  ): Promise<UpdateIccidMappingResponse> {
    try {
      const { phone_number, sim_index, country_code, carrier, imei, notes } = data;
      const balanceThreshold = data.balance_threshold ?? null;

      const existing = await queryFirst(
        env.DB.prepare(EXISTING_SIM_SELECT).bind(id),
        ExistingSimRow,
      );
      if (!existing) throw new ORPCError('NOT_FOUND', { message: 'ICCID mapping not found' });
      const service = resolveServiceType(data, existing);
      if ('error' in service) throw badRequest(service.error);
      const role = await resolveSimRole(data, existing, env);
      if ('error' in role) throw badRequest(role.error);

      await env.DB.prepare(
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
          phone_number,
          sim_index,
          emptyToNull(country_code),
          emptyToNull(carrier),
          emptyToNull(imei),
          emptyToNull(notes),
          service.serviceType,
          service.serviceTypeSource,
          service.serviceTypeProvided ? 1 : 0,
          service.serviceType,
          service.serviceType,
          role.role,
          role.primaryIccid,
          balanceThreshold,
          updatedBy(user),
          id,
        )
        .run();

      const mapping = await queryFirst(env.DB.prepare(DETAIL_SELECT).bind(id), IccidMappingDetail);

      if (!mapping) throw new ORPCError('NOT_FOUND', { message: 'ICCID mapping not found' });
      return { success: true, data: mapping };
    } catch (error) {
      fail(error, 'Error updating ICCID mapping', 'Failed to update ICCID mapping');
    }
  },

  async delete({ env }: WriteCall, id: string): Promise<DeleteIccidMappingResponse> {
    try {
      // If this SIM is a primary with secondaries still attached, the ON DELETE RESTRICT FK aborts.
      await env.DB.prepare(
        `
        DELETE FROM sims WHERE iccid = ?
      `,
      )
        .bind(id)
        .run();

      return { success: true, message: 'ICCID mapping deleted successfully' };
    } catch (error) {
      if (/FOREIGN KEY constraint failed/i.test(errorText(error))) {
        throw new ORPCError('CONFLICT', {
          message:
            'This is a primary SIM with secondary SIMs still attached. Set them back to standalone first.',
        });
      }
      fail(error, 'Error deleting ICCID mapping', 'Failed to delete ICCID mapping');
    }
  },

  async bulkImport(
    { env, user }: WriteCall,
    { mappings }: v.InferOutput<typeof BulkIccidMappingsBody>,
  ): Promise<BulkIccidMappingsResponse> {
    try {
      let created = 0;
      let updated = 0;
      let failed = 0;
      const errors: string[] = [];

      for (const candidate of mappings) {
        const parsed = v.safeParse(SimMapping, candidate);
        if (!parsed.success) {
          failed++;
          errors.push(`Missing required fields for mapping: ${JSON.stringify(candidate)}`);
          continue;
        }
        const mapping = parsed.output;
        try {
          const { iccid, phone_number, sim_index, country_code, carrier, imei, notes } = mapping;

          const existing = await queryFirst(
            env.DB.prepare(EXISTING_SIM_SELECT).bind(iccid),
            ExistingSimRow,
          );
          const service = resolveServiceType(mapping, existing);
          if ('error' in service) {
            failed++;
            errors.push(`Invalid service type for ICCID ${iccid}: ${service.error}`);
            continue;
          }
          const role = await resolveSimRole(mapping, existing, env);
          if ('error' in role) {
            failed++;
            errors.push(`Invalid SIM role for ICCID ${iccid}: ${role.error}`);
            continue;
          }

          if (existing) {
            await env.DB.prepare(
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
                sim_index,
                phone_number,
                emptyToNull(country_code),
                emptyToNull(carrier),
                emptyToNull(imei),
                emptyToNull(notes),
                service.serviceType,
                service.serviceTypeSource,
                service.serviceTypeProvided ? 1 : 0,
                service.serviceType,
                service.serviceType,
                role.role,
                role.primaryIccid,
                updatedBy(user),
                iccid,
              )
              .run();
            updated++;
          } else {
            await env.DB.prepare(
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
                sim_index,
                phone_number,
                emptyToNull(country_code),
                emptyToNull(carrier),
                emptyToNull(imei),
                emptyToNull(notes),
                service.serviceType,
                service.serviceTypeSource,
                service.serviceType,
                service.serviceType,
                role.role,
                role.primaryIccid,
                updatedBy(user),
              )
              .run();
            created++;
          }
        } catch (error) {
          failed++;
          errors.push(`Failed to import mapping for ICCID ${mapping.iccid}: ${errorText(error)}`);
        }
      }

      return {
        success: true,
        summary: { total: mappings.length, created, updated, failed },
        ...(errors.length > 0 ? { errors } : {}),
      };
    } catch (error) {
      fail(error, 'Error in bulk import', `Failed to import ICCID mappings: ${errorText(error)}`);
    }
  },
};
