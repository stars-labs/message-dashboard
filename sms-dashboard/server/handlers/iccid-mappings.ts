import { json } from '../lib/response.js';
import * as v from 'valibot';
import { readJson } from '../../shared/parse-json.js';
import { queryAll, queryFirst, type D1 } from '../lib/d1.js';
import { errorText } from '../utils/d1-error.js';

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

const MappingListRow = v.object({
  id: v.string(),
  iccid: v.string(),
  sim_index: v.number(),
  phone_number: v.string(),
  country: v.nullable(v.string()),
  carrier: v.nullable(v.string()),
  service_type: v.string(),
  service_type_source: v.nullable(v.string()),
  service_type_verified_at: v.nullable(v.string()),
  sim_role: v.string(),
  primary_iccid: v.nullable(v.string()),
  balance_threshold: v.nullable(v.number()),
  equipment_id: v.nullable(v.string()),
  notes: v.nullable(v.string()),
  is_active: v.string(),
  signal_quality: v.nullable(v.number()),
  modem_status: v.nullable(v.string()),
  detected_iccid: v.nullable(v.string()),
  operator: v.nullable(v.string()),
  usb_path: v.nullable(v.string()),
  last_usb_path: v.nullable(v.string()),
  created_at: v.nullable(v.string()),
  updated_at: v.nullable(v.string()),
});

const MappingDetailRow = v.omit(MappingListRow, ['balance_threshold']);

const SavedMappingRow = v.object({
  iccid: v.string(),
  sim_index: v.number(),
  phone_number: v.string(),
  country_code: v.nullable(v.string()),
  carrier: v.nullable(v.string()),
  imei: v.nullable(v.string()),
  notes: v.nullable(v.string()),
  service_type: v.string(),
  service_type_source: v.nullable(v.string()),
  service_type_verified_at: v.nullable(v.string()),
  sim_role: v.string(),
  primary_iccid: v.nullable(v.string()),
  balance_threshold: v.nullable(v.number()),
  status: v.string(),
  usb_path: v.nullable(v.string()),
  last_usb_path: v.nullable(v.string()),
  created_at: v.nullable(v.string()),
  updated_at: v.nullable(v.string()),
});

const TotalRow = v.object({ total: v.number() });

const NonEmptyString = v.pipe(v.string(), v.nonEmpty());
const SimIndex = v.pipe(v.number(), v.integer(), v.minValue(1));
const OptionalText = v.optional(v.nullable(v.string()));

const SimWriteFields = {
  country_code: OptionalText,
  carrier: OptionalText,
  imei: OptionalText,
  notes: OptionalText,
  service_type: OptionalText,
  service_type_source: OptionalText,
  sim_role: OptionalText,
  primary_iccid: OptionalText,
};

/** One SIM as bulk import receives it; the threshold is not imported. */
const SimMapping = v.object({
  iccid: NonEmptyString,
  phone_number: NonEmptyString,
  sim_index: SimIndex,
  ...SimWriteFields,
});

/** Request body of POST /api/iccid-mappings. A null threshold uses the currency default in the client. */
const CreateBody = v.object({
  ...SimMapping.entries,
  balance_threshold: v.optional(v.nullable(v.number())),
});

/** Request body of PUT /api/iccid-mappings/:id; the ICCID comes from the path. */
const UpdateBody = v.object({
  phone_number: NonEmptyString,
  sim_index: SimIndex,
  ...SimWriteFields,
  balance_threshold: v.optional(v.nullable(v.number())),
});

const BulkBody = v.object({ mappings: v.array(v.unknown()) });

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

interface ListRequest {
  url: string;
  env: { DB: D1<'all' | 'first'> };
}

interface GetRequest {
  env: { DB: D1<'first'> };
  params?: Record<string, string>;
}

interface WriteRequest {
  env: { DB: D1<'first' | 'run'> };
  user?: Operator;
  text(): Promise<string>;
}

interface UpdateRequest extends WriteRequest {
  params?: Record<string, string>;
}

interface DeleteRequest {
  env: { DB: D1<'run'> };
  params?: Record<string, string>;
}

function badRequest(error: string): Response {
  return json({ success: false, error }, 400);
}

function positiveInteger(raw: string | null, fallback: number): number | null {
  if (raw === null || raw === '') return fallback;
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
  async list(request: ListRequest): Promise<Response> {
    const { env } = request;
    const url = new URL(request.url);
    const page = positiveInteger(url.searchParams.get('page'), 1);
    const limit = positiveInteger(url.searchParams.get('limit'), 20);
    if (page === null || limit === null) {
      return badRequest('page and limit must be positive integers');
    }
    const search = url.searchParams.get('search') ?? '';
    const offset = (page - 1) * limit;

    try {
      let query = `
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
        query += ` AND (iccid LIKE ? OR number LIKE ? OR carrier LIKE ? OR notes LIKE ?)`;
        const searchPattern = `%${search}%`;
        params.push(searchPattern, searchPattern, searchPattern, searchPattern);
      }

      query += ` ORDER BY sim_index ASC LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const mappings = await queryAll(env.DB.prepare(query).bind(...params), MappingListRow);

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

      return json({
        success: true,
        data: mappings,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      console.error('[iccid-mappings] Error listing ICCID mappings:', error);
      return json(
        {
          success: false,
          error: 'Failed to fetch ICCID mappings',
          details: errorText(error),
        },
        500,
      );
    }
  },

  async get(request: GetRequest): Promise<Response> {
    const { env } = request;
    const id = request.params?.['id'];

    try {
      const mapping = await queryFirst(env.DB.prepare(DETAIL_SELECT).bind(id), MappingDetailRow);

      if (!mapping) {
        return json({ success: false, error: 'ICCID mapping not found' }, 404);
      }

      return json({ success: true, data: mapping });
    } catch (error) {
      console.error('[iccid-mappings] Error fetching ICCID mapping:', error);
      return json({ success: false, error: 'Failed to fetch ICCID mapping' }, 500);
    }
  },

  async getByIccid(request: GetRequest): Promise<Response> {
    const { env } = request;
    const iccid = request.params?.['iccid'];

    try {
      const mapping = await queryFirst(env.DB.prepare(DETAIL_SELECT).bind(iccid), MappingDetailRow);

      if (!mapping) {
        return json({ success: false, error: 'ICCID not found' }, 404);
      }

      return json({ success: true, data: mapping });
    } catch (error) {
      console.error('[iccid-mappings] Error fetching ICCID by ID:', error);
      return json({ success: false, error: 'Failed to fetch ICCID mapping' }, 500);
    }
  },

  async create(request: WriteRequest): Promise<Response> {
    const { env, user } = request;
    const parsed = await readJson(request, CreateBody);
    if (!parsed.ok) {
      return json(
        {
          success: false,
          error: 'ICCID, phone number, and sim_index are required',
          details: parsed.error,
        },
        400,
      );
    }
    const data = parsed.value;

    try {
      const { iccid, phone_number, sim_index, country_code, carrier, imei, notes } = data;
      const balanceThreshold = data.balance_threshold ?? null;

      const simExists = await queryFirst(
        env.DB.prepare(EXISTING_SIM_SELECT).bind(iccid),
        ExistingSimRow,
      );
      const service = resolveServiceType(data, simExists);
      if ('error' in service) return badRequest(service.error);
      const role = await resolveSimRole(data, simExists, env);
      if ('error' in role) return badRequest(role.error);

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

      const mapping = await queryFirst(
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
        SavedMappingRow,
      );

      return json({ success: true, data: mapping }, simExists ? 200 : 201);
    } catch (error) {
      console.error('[iccid-mappings] Error creating ICCID mapping:', error);
      return json(
        {
          success: false,
          error: 'Failed to create ICCID mapping',
          details: errorText(error),
        },
        500,
      );
    }
  },

  async update(request: UpdateRequest): Promise<Response> {
    const { env, user } = request;
    const id = request.params?.['id'];
    const parsed = await readJson(request, UpdateBody);
    if (!parsed.ok) {
      return json(
        { success: false, error: 'phone_number and sim_index are required', details: parsed.error },
        400,
      );
    }
    const data = parsed.value;

    try {
      const { phone_number, sim_index, country_code, carrier, imei, notes } = data;
      const balanceThreshold = data.balance_threshold ?? null;

      const existing = await queryFirst(
        env.DB.prepare(EXISTING_SIM_SELECT).bind(id),
        ExistingSimRow,
      );
      if (!existing) {
        return json({ success: false, error: 'ICCID mapping not found' }, 404);
      }
      const service = resolveServiceType(data, existing);
      if ('error' in service) return badRequest(service.error);
      const role = await resolveSimRole(data, existing, env);
      if ('error' in role) return badRequest(role.error);

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

      const mapping = await queryFirst(env.DB.prepare(DETAIL_SELECT).bind(id), MappingDetailRow);

      if (!mapping) {
        return json({ success: false, error: 'ICCID mapping not found' }, 404);
      }

      return json({ success: true, data: mapping });
    } catch (error) {
      console.error('[iccid-mappings] Error updating ICCID mapping:', error);
      return json({ success: false, error: 'Failed to update ICCID mapping' }, 500);
    }
  },

  async delete(request: DeleteRequest): Promise<Response> {
    const { env } = request;
    const id = request.params?.['id'];

    try {
      // If this SIM is a primary with secondaries still attached, the ON DELETE RESTRICT FK aborts.
      await env.DB.prepare(
        `
        DELETE FROM sims WHERE iccid = ?
      `,
      )
        .bind(id)
        .run();

      return json({
        success: true,
        message: 'ICCID mapping deleted successfully',
      });
    } catch (error) {
      if (/FOREIGN KEY constraint failed/i.test(errorText(error))) {
        return json(
          {
            success: false,
            error:
              'This is a primary SIM with secondary SIMs still attached. Set them back to standalone first.',
          },
          409,
        );
      }
      console.error('[iccid-mappings] Error deleting ICCID mapping:', error);
      return json({ success: false, error: 'Failed to delete ICCID mapping' }, 500);
    }
  },

  async bulkImport(request: WriteRequest): Promise<Response> {
    const { env, user } = request;
    const body = await readJson(request, BulkBody);

    if (!body.ok) {
      return json({ success: false, error: 'Mappings must be an array' }, 400);
    }
    const { mappings } = body.value;

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

      return json({
        success: true,
        summary: {
          total: mappings.length,
          created,
          updated,
          failed,
        },
        errors: errors.length > 0 ? errors : undefined,
      });
    } catch (error) {
      console.error('[iccid-mappings] Error in bulk import:', error);
      return json(
        {
          success: false,
          error: 'Failed to import ICCID mappings',
          details: errorText(error),
        },
        500,
      );
    }
  },
};
