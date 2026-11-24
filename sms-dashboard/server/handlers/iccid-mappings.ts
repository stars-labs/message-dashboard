import { ORPCError } from '@orpc/server';
import * as v from 'valibot';
import type { D1 } from '../lib/d1.js';
import {
  countIccidMappings,
  getIccidMappingDetail,
  getSavedIccidMapping,
  listIccidMappings,
} from '../db/iccid-mappings.js';
import {
  deleteSim,
  getExistingSim,
  getSimRole,
  insertSim,
  insertSimFromImport,
  updateSim,
  updateSimByUpsert,
  updateSimFromImport,
  type ExistingSim,
} from '../db/sims.js';
import { errorText } from '../../shared/error-text.js';
import {
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
    const target = await getSimRole(env.DB, primaryIccid);
    if (!target) return { error: 'primary_iccid does not match any SIM' };
    if (target.sim_role !== 'primary') {
      return { error: `primary_iccid points to a ${target.sim_role} SIM, not a primary` };
    }
  }

  return { role: role.output, primaryIccid, roleProvided };
}

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
      const mappings = await listIccidMappings(env.DB, search, limit, offset);
      const total = await countIccidMappings(env.DB, search);

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
      const mapping = await getIccidMappingDetail(env.DB, id);
      if (!mapping) throw new ORPCError('NOT_FOUND', { message: 'ICCID mapping not found' });
      return { success: true, data: mapping };
    } catch (error) {
      fail(error, 'Error fetching ICCID mapping', 'Failed to fetch ICCID mapping');
    }
  },

  async getByIccid({ env }: ReadCall, iccid: string): Promise<IccidMappingDetailResponse> {
    try {
      const mapping = await getIccidMappingDetail(env.DB, iccid);
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

      const simExists = await getExistingSim(env.DB, iccid);
      const service = resolveServiceType(data, simExists);
      if ('error' in service) throw badRequest(service.error);
      const role = await resolveSimRole(data, simExists, env);
      if ('error' in role) throw badRequest(role.error);

      const sim = {
        sim_index,
        phone_number,
        country_code: emptyToNull(country_code),
        carrier: emptyToNull(carrier),
        imei: emptyToNull(imei),
        notes: emptyToNull(notes),
        serviceType: service.serviceType,
        serviceTypeSource: service.serviceTypeSource,
        serviceTypeProvided: service.serviceTypeProvided,
        role: role.role,
        primaryIccid: role.primaryIccid,
        balanceThreshold,
        updatedBy: updatedBy(user),
      };
      if (!simExists) {
        await insertSim(env.DB, iccid, sim);
      } else {
        await updateSimByUpsert(env.DB, iccid, sim);
      }

      const mapping = await getSavedIccidMapping(env.DB, iccid);

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

      const existing = await getExistingSim(env.DB, id);
      if (!existing) throw new ORPCError('NOT_FOUND', { message: 'ICCID mapping not found' });
      const service = resolveServiceType(data, existing);
      if ('error' in service) throw badRequest(service.error);
      const role = await resolveSimRole(data, existing, env);
      if ('error' in role) throw badRequest(role.error);

      await updateSim(env.DB, id, {
        sim_index,
        phone_number,
        country_code: emptyToNull(country_code),
        carrier: emptyToNull(carrier),
        imei: emptyToNull(imei),
        notes: emptyToNull(notes),
        serviceType: service.serviceType,
        serviceTypeSource: service.serviceTypeSource,
        serviceTypeProvided: service.serviceTypeProvided,
        role: role.role,
        primaryIccid: role.primaryIccid,
        balanceThreshold,
        updatedBy: updatedBy(user),
      });

      const mapping = await getIccidMappingDetail(env.DB, id);

      if (!mapping) throw new ORPCError('NOT_FOUND', { message: 'ICCID mapping not found' });
      return { success: true, data: mapping };
    } catch (error) {
      fail(error, 'Error updating ICCID mapping', 'Failed to update ICCID mapping');
    }
  },

  async delete({ env }: WriteCall, id: string): Promise<DeleteIccidMappingResponse> {
    try {
      // If this SIM is a primary with secondaries still attached, the ON DELETE RESTRICT FK aborts.
      await deleteSim(env.DB, id);

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

          const existing = await getExistingSim(env.DB, iccid);
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

          const sim = {
            sim_index,
            phone_number,
            country_code: emptyToNull(country_code),
            carrier: emptyToNull(carrier),
            imei: emptyToNull(imei),
            notes: emptyToNull(notes),
            serviceType: service.serviceType,
            serviceTypeSource: service.serviceTypeSource,
            serviceTypeProvided: service.serviceTypeProvided,
            role: role.role,
            primaryIccid: role.primaryIccid,
            updatedBy: updatedBy(user),
          };
          if (existing) {
            await updateSimFromImport(env.DB, iccid, sim);
            updated++;
          } else {
            await insertSimFromImport(env.DB, iccid, sim);
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
