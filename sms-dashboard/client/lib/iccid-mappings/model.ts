import type { IccidMapping } from '../../../shared/api/iccid-mappings.js';
import { textOr } from '../../../shared/text.js';

export type StatusFilter = 'all' | 'active' | 'error' | 'inactive';

export type SortKey =
  | 'sim_index'
  | 'phone_number'
  | 'iccid'
  | 'carrier'
  | 'service_type'
  | 'sim_role'
  | 'position'
  | 'signal_quality'
  | 'is_active'
  | 'balance_threshold'
  | 'notes';

export interface MappingForm {
  iccid: string;
  phone_number: string;
  carrier: string;
  country: string;
  description: string;
  sim_index: number | '' | null;
  imei: string;
  service_type: string;
  service_type_source: string;
  sim_role: string;
  primary_iccid: string;
  balance_threshold: number | null;
}

export type Panel =
  | { mode: 'add'; formData: MappingForm }
  | { mode: 'edit'; mapping: IccidMapping; formData: MappingForm };

export function emptyForm(): MappingForm {
  return {
    iccid: '',
    phone_number: '',
    carrier: '',
    country: '',
    description: '',
    sim_index: '',
    imei: '',
    service_type: 'unknown',
    service_type_source: '',
    sim_role: 'standalone',
    primary_iccid: '',
    balance_threshold: null,
  };
}

export function editForm(mapping: IccidMapping): MappingForm {
  return {
    iccid: mapping.iccid,
    phone_number: mapping.phone_number,
    carrier: textOr(mapping.carrier, ''),
    country: textOr(mapping.country, ''),
    description: textOr(mapping.notes, ''),
    sim_index: mapping.sim_index === 0 ? '' : mapping.sim_index,
    imei: textOr(mapping.equipment_id, ''),
    service_type: textOr(mapping.service_type, 'unknown'),
    service_type_source: textOr(mapping.service_type_source, ''),
    sim_role: textOr(mapping.sim_role, 'standalone'),
    primary_iccid: textOr(mapping.primary_iccid, ''),
    balance_threshold: mapping.balance_threshold,
  };
}

export function isInactive(mapping: IccidMapping): boolean {
  return ['no_modem', 'unassigned'].includes(mapping.is_active) || mapping.is_active === '';
}
