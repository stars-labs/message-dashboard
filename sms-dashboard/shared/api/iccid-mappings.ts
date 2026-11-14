import * as v from 'valibot';

/** A SIM as GET /api/iccid-mappings lists it: a device_view row under the mapping names. */
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

/** One SIM as GET /api/iccid-mappings/:id and PUT return it. */
export const IccidMappingDetail = v.omit(IccidMapping, ['balance_threshold']);

/** The SIM POST /api/iccid-mappings wrote, under the write names. */
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
