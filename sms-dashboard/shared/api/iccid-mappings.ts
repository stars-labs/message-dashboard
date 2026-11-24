import * as v from 'valibot';
import { bodyObject } from './body.js';

/** A device_view row under the mapping names. */
export const IccidMapping = v.object({
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

export type IccidMapping = v.InferOutput<typeof IccidMapping>;

export const IccidMappingDetail = v.omit(IccidMapping, ['balance_threshold']);

/** Under the write names. */
export const SavedIccidMapping = v.object({
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

export const IccidMappingsResponse = v.object({
  success: v.literal(true),
  data: v.array(IccidMapping),
  pagination: v.object({
    page: v.number(),
    limit: v.number(),
    total: v.number(),
    totalPages: v.number(),
  }),
});

export type IccidMappingsResponse = v.InferOutput<typeof IccidMappingsResponse>;

export const CreateIccidMappingResponse = v.object({
  success: v.literal(true),
  data: SavedIccidMapping,
});

export type CreateIccidMappingResponse = v.InferOutput<typeof CreateIccidMappingResponse>;

export const UpdateIccidMappingResponse = v.object({
  success: v.literal(true),
  data: IccidMappingDetail,
});

export type UpdateIccidMappingResponse = v.InferOutput<typeof UpdateIccidMappingResponse>;

export const DeleteIccidMappingResponse = v.object({
  success: v.literal(true),
  message: v.string(),
});

export type DeleteIccidMappingResponse = v.InferOutput<typeof DeleteIccidMappingResponse>;

export const IccidMappingDetailResponse = v.object({
  success: v.literal(true),
  data: IccidMappingDetail,
});

export type IccidMappingDetailResponse = v.InferOutput<typeof IccidMappingDetailResponse>;

/** Text: the route checks page and limit. */
export const IccidMappingsQuery = v.object({
  page: v.optional(v.string()),
  limit: v.optional(v.string()),
  search: v.optional(v.string()),
});

const CREATE_REQUIRED_MESSAGE = 'ICCID, phone number, and sim_index are required';
const UPDATE_REQUIRED_MESSAGE = 'phone_number and sim_index are required';

const NonEmptyString = (message: string) => v.pipe(v.string(message), v.nonEmpty(message));
const SimIndex = (message: string) =>
  v.pipe(v.number(message), v.integer(message), v.minValue(1, message));
const OptionalText = v.optional(v.nullable(v.string()));

/** Absent and present-but-empty differ for service type and role (see resolveServiceType), so none has a default. */
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

/** The threshold is not imported. */
export const SimMapping = v.object({
  iccid: NonEmptyString(CREATE_REQUIRED_MESSAGE),
  phone_number: NonEmptyString(CREATE_REQUIRED_MESSAGE),
  sim_index: SimIndex(CREATE_REQUIRED_MESSAGE),
  ...SimWriteFields,
});

/** A null threshold uses the currency default in the client. */
export const CreateIccidMappingBody = bodyObject(
  { ...SimMapping.entries, balance_threshold: v.optional(v.nullable(v.number())) },
  {
    iccid: CREATE_REQUIRED_MESSAGE,
    phone_number: CREATE_REQUIRED_MESSAGE,
    sim_index: CREATE_REQUIRED_MESSAGE,
  },
  CREATE_REQUIRED_MESSAGE,
);

/** The ICCID comes from the path. */
export const UpdateIccidMappingBody = bodyObject(
  {
    phone_number: NonEmptyString(UPDATE_REQUIRED_MESSAGE),
    sim_index: SimIndex(UPDATE_REQUIRED_MESSAGE),
    ...SimWriteFields,
    balance_threshold: v.optional(v.nullable(v.number())),
  },
  { phone_number: UPDATE_REQUIRED_MESSAGE, sim_index: UPDATE_REQUIRED_MESSAGE },
  UPDATE_REQUIRED_MESSAGE,
);

const MAPPINGS_MESSAGE = 'Mappings must be an array';

/** Each mapping is checked on its own, so one bad row fails alone. */
export const BulkIccidMappingsBody = bodyObject(
  { mappings: v.array(v.unknown(), MAPPINGS_MESSAGE) },
  { mappings: MAPPINGS_MESSAGE },
  MAPPINGS_MESSAGE,
);

export const BulkIccidMappingsResponse = v.object({
  success: v.literal(true),
  summary: v.object({
    total: v.number(),
    created: v.number(),
    updated: v.number(),
    failed: v.number(),
  }),
  errors: v.optional(v.array(v.string())),
});

export type BulkIccidMappingsResponse = v.InferOutput<typeof BulkIccidMappingsResponse>;
