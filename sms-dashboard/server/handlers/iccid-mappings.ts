// ICCID Mappings handler - manages user-authoritative sims table
// New schema: sims table is purely user-managed, status computed dynamically

import type { AppRequest } from '../../shared/worker-context.js';
import type { D1Database } from '../../shared/cf-bindings.js';

export const SIM_SERVICE_TYPES = ['unknown', 'prepaid', 'postpaid', 'balance_managed'] as const;
export const SIM_SERVICE_TYPE_SOURCES = [
  'carrier_account',
  'carrier_support',
  'contract_or_bill',
  'carrier_message',
] as const;
export const SIM_ROLES = ['standalone', 'primary', 'secondary'] as const;

export type SimServiceType = (typeof SIM_SERVICE_TYPES)[number];
export type SimServiceTypeSource = (typeof SIM_SERVICE_TYPE_SOURCES)[number];
export type SimRole = (typeof SIM_ROLES)[number];

/** The columns the resolvers read off an existing sims row. */
export interface ExistingSim {
  iccid: string;
  service_type: string | null;
  service_type_source: string | null;
  sim_role: string | null;
  primary_iccid: string | null;
}

/** Request bodies are narrowed field by field, so every field arrives as unknown. */
type SimInput = Record<string, unknown>;

export type ServiceTypeResolution =
  | { serviceType: SimServiceType; serviceTypeSource: SimServiceTypeSource | null; serviceTypeProvided: boolean }
  | { error: string };

export type SimRoleResolution =
  | { role: SimRole; primaryIccid: string | null; roleProvided: boolean }
  | { error: string };

/** A device_view row as this handler returns it. */
interface SimMappingRow {
  iccid: string;
  sim_index: number | null;
  phone_number: string | null;
  [column: string]: unknown;
}

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Coerce the per-SIM balance threshold from the API payload into a nullable
 * number. Empty string / null / undefined → null (fall back to the currency
 * default in the client lib). Non-finite values are also rejected to null.
 */
function parseBalanceThreshold(value: unknown): number | null {
  if (value == null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function resolveServiceType(
  data: SimInput,
  existing: ExistingSim | null = null,
): ServiceTypeResolution {
  const serviceTypeProvided = hasOwn(data, 'service_type') || hasOwn(data, 'service_type_source');
  const serviceType = hasOwn(data, 'service_type')
    ? String(data.service_type || 'unknown')
    : existing?.service_type || 'unknown';

  if (!(SIM_SERVICE_TYPES as readonly string[]).includes(serviceType)) {
    return { error: 'service_type must be unknown, prepaid, postpaid, or balance_managed' };
  }

  if (serviceType === 'unknown' || serviceType === 'balance_managed') {
    return { serviceType, serviceTypeSource: null, serviceTypeProvided };
  }

  const serviceTypeSource = hasOwn(data, 'service_type_source')
    ? (data.service_type_source as string | null) || null
    : existing?.service_type_source || null;

  if (!serviceTypeSource || !(SIM_SERVICE_TYPE_SOURCES as readonly string[]).includes(serviceTypeSource)) {
    return {
      error: 'A valid service_type_source is required for prepaid or postpaid SIMs',
    };
  }

  return {
    // Narrowed by the allow-list check above.
    serviceType: serviceType as SimServiceType,
    serviceTypeSource: serviceTypeSource as SimServiceTypeSource,
    serviceTypeProvided,
  };
}

/**
 * Resolve the primary/secondary role for a SIM. Unlike resolveServiceType,
 * this is async: a secondary must point at a real primary SIM, which requires
 * a cross-row DB lookup the SQL triggers cannot do safely.
 */
export async function resolveSimRole(
  data: SimInput,
  existing: ExistingSim | null,
  env: { DB: D1Database },
): Promise<SimRoleResolution> {
  const roleProvided = hasOwn(data, 'sim_role') || hasOwn(data, 'primary_iccid');
  const role = hasOwn(data, 'sim_role')
    ? String(data.sim_role || 'standalone')
    : existing?.sim_role || 'standalone';

  if (!(SIM_ROLES as readonly string[]).includes(role)) {
    return { error: 'sim_role must be standalone, primary, or secondary' };
  }

  let primaryIccid: string | null = null;
  if (role === 'secondary') {
    primaryIccid = hasOwn(data, 'primary_iccid')
      ? ((data.primary_iccid as string | null) || null)
      : (existing?.primary_iccid || null);
    if (!primaryIccid) {
      return { error: 'primary_iccid is required for a secondary SIM' };
    }
    const target = await env.DB.prepare(
      'SELECT sim_role FROM sims WHERE iccid = ?',
    ).bind(primaryIccid).first<{ sim_role: string | null }>();
    if (!target) return { error: 'primary_iccid does not match any SIM' };
    if (target.sim_role !== 'primary') {
      return { error: `primary_iccid points to a ${target.sim_role} SIM, not a primary` };
    }
  }

  return { role: role as SimRole, primaryIccid, roleProvided };
}

function badRequest(error: string): Response {
  return json({ success: false, error }, 400);
}

/** The sims columns both the resolver and the writes care about. */
const EXISTING_SIM_SELECT = `
  SELECT iccid, service_type, service_type_source, sim_role, primary_iccid
  FROM sims WHERE iccid = ?
`;

/** The shape the detail endpoints read back. */
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
  // List all ICCID mappings with pagination
  async list(request: AppRequest): Promise<Response> {
    const { env } = request;
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const search = url.searchParams.get('search') || '';
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

      const result = await env.DB.prepare(query).bind(...params).all<SimMappingRow>();
      const mappings = result.results;

      // Get total count
      let countQuery = `SELECT COUNT(*) as total FROM device_view WHERE 1=1`;
      const countParams: unknown[] = [];

      if (search) {
        countQuery += ` AND (iccid LIKE ? OR number LIKE ? OR carrier LIKE ? OR notes LIKE ?)`;
        const searchPattern = `%${search}%`;
        countParams.push(searchPattern, searchPattern, searchPattern, searchPattern);
      }

      const totalResult = await env.DB.prepare(countQuery).bind(...countParams).first<{ total: number }>();
      const total = totalResult?.total || 0;

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
      return json({
        success: false,
        error: 'Failed to fetch ICCID mappings',
        details: (error as Error).message,
      }, 500);
    }
  },

  // Get a specific ICCID mapping
  async get(request: AppRequest): Promise<Response> {
    const { env } = request;
    const id = request.params?.id;

    try {
      const mapping = await env.DB.prepare(DETAIL_SELECT).bind(id).first<SimMappingRow>();

      if (!mapping) {
        return json({ success: false, error: 'ICCID mapping not found' }, 404);
      }

      return json({ success: true, data: mapping });
    } catch (error) {
      console.error('[iccid-mappings] Error fetching ICCID mapping:', error);
      return json({ success: false, error: 'Failed to fetch ICCID mapping' }, 500);
    }
  },

  // Get mapping by ICCID
  async getByIccid(request: AppRequest): Promise<Response> {
    const { env } = request;
    const iccid = request.params?.iccid;

    try {
      const mapping = await env.DB.prepare(DETAIL_SELECT).bind(iccid).first<SimMappingRow>();

      if (!mapping) {
        return json({ success: false, error: 'ICCID not found' }, 404);
      }

      return json({ success: true, data: mapping });
    } catch (error) {
      console.error('[iccid-mappings] Error fetching ICCID by ID:', error);
      return json({ success: false, error: 'Failed to fetch ICCID mapping' }, 500);
    }
  },

  // Create or update ICCID mapping
  async create(request: AppRequest): Promise<Response> {
    const { env, user } = request;
    const data = (await request.json()) as SimInput;

    try {
      const {
        iccid,
        phone_number,
        sim_index,
        country_code,
        carrier,
        imei,
        notes,
      } = data;
      const balanceThreshold = parseBalanceThreshold(data.balance_threshold);

      if (!iccid || !phone_number || !sim_index) {
        return json({
          success: false,
          error: 'ICCID, phone number, and sim_index are required',
        }, 400);
      }

      // Check if SIM exists
      const simExists = await env.DB.prepare(EXISTING_SIM_SELECT).bind(iccid).first<ExistingSim>();
      const service = resolveServiceType(data, simExists);
      if ('error' in service) return badRequest(service.error);
      const role = await resolveSimRole(data, simExists, env);
      if ('error' in role) return badRequest(role.error);

      if (!simExists) {
        // INSERT new SIM (NO status field - computed dynamically)
        await env.DB.prepare(`
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
        `).bind(
          iccid,
          sim_index,
          phone_number,
          country_code || null,
          carrier || null,
          imei || null,
          notes || null,
          service.serviceType,
          service.serviceTypeSource,
          service.serviceType,
          service.serviceType,
          role.role,
          role.primaryIccid,
          balanceThreshold,
          user?.email || 'system',
        ).run();
      } else {
        // UPDATE existing SIM (NO status field - computed dynamically)
        await env.DB.prepare(`
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
        `).bind(
          sim_index,
          phone_number,
          country_code || null,
          carrier || null,
          imei || null,
          notes || null,
          service.serviceType,
          service.serviceTypeSource,
          service.serviceTypeProvided ? 1 : 0,
          service.serviceType,
          service.serviceType,
          role.role,
          role.primaryIccid,
          balanceThreshold,
          user?.email || 'system',
          iccid,
        ).run();
      }

      // Return updated mapping with computed status from device_view
      const mapping = await env.DB.prepare(`
        SELECT
          iccid, sim_index, number as phone_number,
          country as country_code, carrier, equipment_id as imei,
          notes, service_type, service_type_source, service_type_verified_at,
          sim_role, primary_iccid, balance_threshold,
          sim_status as status, usb_path, last_usb_path,
          created_at, updated_at
        FROM device_view
        WHERE iccid = ?
      `).bind(iccid).first<SimMappingRow>();

      return json({ success: true, data: mapping }, simExists ? 200 : 201);
    } catch (error) {
      console.error('[iccid-mappings] Error creating ICCID mapping:', error);
      return json({
        success: false,
        error: 'Failed to create ICCID mapping',
        details: (error as Error).message,
      }, 500);
    }
  },

  // Update an ICCID mapping
  async update(request: AppRequest): Promise<Response> {
    const { env, user } = request;
    const id = request.params?.id;
    const data = (await request.json()) as SimInput;

    try {
      const {
        phone_number,
        sim_index,
        country_code,
        carrier,
        imei,
        notes,
      } = data;
      const balanceThreshold = parseBalanceThreshold(data.balance_threshold);

      const existing = await env.DB.prepare(EXISTING_SIM_SELECT).bind(id).first<ExistingSim>();
      if (!existing) {
        return json({ success: false, error: 'ICCID mapping not found' }, 404);
      }
      const service = resolveServiceType(data, existing);
      if ('error' in service) return badRequest(service.error);
      const role = await resolveSimRole(data, existing, env);
      if ('error' in role) return badRequest(role.error);

      // Update sims table (NO status field)
      await env.DB.prepare(`
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
      `).bind(
        phone_number || null,
        sim_index || null,
        country_code || null,
        carrier || null,
        imei || null,
        notes || null,
        service.serviceType,
        service.serviceTypeSource,
        service.serviceTypeProvided ? 1 : 0,
        service.serviceType,
        service.serviceType,
        role.role,
        role.primaryIccid,
        balanceThreshold,
        user?.email || 'system',
        id,
      ).run();

      // Return updated mapping with computed status from device_view
      const mapping = await env.DB.prepare(DETAIL_SELECT).bind(id).first<SimMappingRow>();

      if (!mapping) {
        return json({ success: false, error: 'ICCID mapping not found' }, 404);
      }

      return json({ success: true, data: mapping });
    } catch (error) {
      console.error('[iccid-mappings] Error updating ICCID mapping:', error);
      return json({ success: false, error: 'Failed to update ICCID mapping' }, 500);
    }
  },

  // Delete an ICCID mapping
  async delete(request: AppRequest): Promise<Response> {
    const { env } = request;
    const id = request.params?.id;

    try {
      // Actually delete the SIM from sims table. If this SIM is a primary with
      // secondaries still attached, the ON DELETE RESTRICT FK aborts.
      await env.DB.prepare(`
        DELETE FROM sims WHERE iccid = ?
      `).bind(id).run();

      return json({
        success: true,
        message: 'ICCID mapping deleted successfully',
      });
    } catch (error) {
      if (/FOREIGN KEY constraint failed/i.test((error as Error)?.message || '')) {
        return json({
          success: false,
          error: 'This is a primary SIM with secondary SIMs still attached. Set them back to standalone first.',
        }, 409);
      }
      console.error('[iccid-mappings] Error deleting ICCID mapping:', error);
      return json({ success: false, error: 'Failed to delete ICCID mapping' }, 500);
    }
  },

  // Bulk import ICCID mappings
  async bulkImport(request: AppRequest): Promise<Response> {
    const { env, user } = request;
    const { mappings } = (await request.json()) as { mappings?: unknown };

    if (!Array.isArray(mappings)) {
      return json({ success: false, error: 'Mappings must be an array' }, 400);
    }

    try {
      let created = 0;
      let updated = 0;
      let failed = 0;
      const errors: string[] = [];

      for (const mapping of mappings as SimInput[]) {
        try {
          const { iccid, phone_number, sim_index, country_code, carrier, imei, notes } = mapping;

          if (!iccid || !phone_number || !sim_index) {
            failed++;
            errors.push(`Missing required fields for mapping: ${JSON.stringify(mapping)}`);
            continue;
          }

          // Check if SIM exists
          const existing = await env.DB.prepare(EXISTING_SIM_SELECT).bind(iccid).first<ExistingSim>();
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
            // Update existing
            await env.DB.prepare(`
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
            `).bind(
              sim_index,
              phone_number,
              country_code || null,
              carrier || null,
              imei || null,
              notes || null,
              service.serviceType,
              service.serviceTypeSource,
              service.serviceTypeProvided ? 1 : 0,
              service.serviceType,
              service.serviceType,
              role.role,
              role.primaryIccid,
              user?.email || 'system',
              iccid,
            ).run();
            updated++;
          } else {
            // Create new
            await env.DB.prepare(`
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
            `).bind(
              iccid,
              sim_index,
              phone_number,
              country_code || null,
              carrier || null,
              imei || null,
              notes || null,
              service.serviceType,
              service.serviceTypeSource,
              service.serviceType,
              service.serviceType,
              role.role,
              role.primaryIccid,
              user?.email || 'system',
            ).run();
            created++;
          }
        } catch (error) {
          failed++;
          errors.push(`Failed to import mapping for ICCID ${mapping.iccid}: ${(error as Error).message}`);
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
      return json({
        success: false,
        error: 'Failed to import ICCID mappings',
        details: (error as Error).message,
      }, 500);
    }
  },
};