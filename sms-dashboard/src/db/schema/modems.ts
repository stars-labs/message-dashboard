import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const modems = sqliteTable('modems', {
  equipment_id: text('equipment_id').primaryKey(),
  manufacturer: text('manufacturer'),
  model: text('model'),
  firmware_revision: text('firmware_revision'),
  hardware_revision: text('hardware_revision'),
  device_path: text('device_path'),
  status: text('status').default('disconnected'),
  modem_index: integer('modem_index'),
  usb_port: integer('usb_port'),
  error_count: integer('error_count').default(0),
  last_error: text('last_error'),
  created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updated_at: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
});

export const modem_state = sqliteTable('modem_state', {
  modem_id: text('modem_id').primaryKey().references(() => modems.equipment_id),
  connection_status: text('connection_status'),
  signal_percent: integer('signal_percent'),
  rssi: integer('rssi'),
  rsrq: integer('rsrq'),
  rsrp: integer('rsrp'),
  snr: integer('snr'),
  access_tech: text('access_tech'),
  modem_index: integer('modem_index'),
  usb_port: integer('usb_port'),
  sim_index: integer('sim_index'),
  last_heartbeat: text('last_heartbeat').default(sql`CURRENT_TIMESTAMP`),
  created_at: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  updated_at: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
});