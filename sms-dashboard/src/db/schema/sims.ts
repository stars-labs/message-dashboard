import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { modems } from './modems';

export const sims = sqliteTable('sims', {
  iccid: text('iccid').primaryKey(),
  phone_number: text('phone_number'),
  carrier: text('carrier'),
  operator_name: text('operator_name'),
  operator_id: text('operator_id'),
  country_code: text('country_code'),
  status: text('status').default('inactive'),
  current_modem_id: text('current_modem_id').references(() => modems.equipment_id),
  activation_date: text('activation_date'),
  last_activity: text('last_activity'),
  sim_index: integer('sim_index'),
  created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updated_at: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
});

// Legacy phones table for backward compatibility
export const phones = sqliteTable('phones', {
  iccid: text('iccid').primaryKey(),
  number: text('number'),
  country: text('country'),
  flag: text('flag'),
  carrier: text('carrier'),
  status: text('status').default('offline'),
  signal: integer('signal').default(0),
  rssi: integer('rssi'),
  rsrq: integer('rsrq'),
  rsrp: integer('rsrp'),
  snr: integer('snr'),
  operator_name: text('operator_name'),
  operator_id: text('operator_id'),
  imei: text('imei'),
  access_tech: text('access_tech'),
  modem_index: integer('modem_index'),
  sim_index: integer('sim_index'),
  created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updated_at: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
});