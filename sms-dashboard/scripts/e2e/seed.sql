-- Fixture data for the e2e suite; every value is invented. Times are relative to
-- now so the dashboard's recent-message windows include them.

INSERT INTO modems (equipment_id, manufacturer, model, usb_port, usb_path, status, detected_iccid, detected_operator, signal_percent, verification_status)
VALUES
  ('860000000000001', 'Quectel', 'EC20F', 1, '1-1.1', 'connected', '8965000000000000001', 'SingTel', 78, 'verified'),
  ('860000000000002', 'Quectel', 'EC20F', 2, '1-1.2', 'connected', '8965000000000000002', 'M1', 54, 'verified'),
  ('860000000000003', 'Quectel', 'EC20F', 3, '1-1.3', 'disconnected', NULL, NULL, NULL, 'unverified');

INSERT INTO sims (iccid, sim_index, phone_number, country_code, carrier, imei, notes, service_type, service_type_source, service_type_verified_at, sim_role, primary_iccid, balance_threshold)
VALUES
  ('8965000000000000001', 1, '+6580000001', 'SG', 'Singtel', '860000000000001', 'Team line', 'postpaid', 'contract_or_bill', '2026-11-01T00:00:00Z', 'primary', NULL, NULL),
  ('8965000000000000002', 2, '+6580000002', 'SG', 'M1', '860000000000002', NULL, 'prepaid', 'carrier_account', '2026-11-01T00:00:00Z', 'standalone', NULL, 10),
  ('8986000000000000003', 3, '+8613800000003', 'CN', 'China Mobile', '860000000000003', NULL, 'unknown', NULL, NULL, 'secondary', '8965000000000000001', NULL);

INSERT INTO daemon_health (daemon_id, last_heartbeat, status, last_ip, version, modem_count, metadata, current_session_id)
VALUES ('orange-pi-main', CURRENT_TIMESTAMP, 'online', '192.0.2.10', '8.0.1', 3,
  '{"schema_version":3,"session_id":"e2e-session","version":"8.0.1","uptime_seconds":3600,"last_message_read_success_age_seconds":5,"last_upload_success_age_seconds":7,"queue":{"pending":0,"in_flight":0,"dead_letter":0,"oldest_unacknowledged_age_seconds":null}}',
  'e2e-session');

INSERT INTO filter_rules (rule_type, pattern, note, created_by)
VALUES ('sender', 'PROMO', 'Marketing sender', 'auth0|e2e-admin');

INSERT INTO keyword_tags (keyword, tag, color, priority, created_by)
VALUES ('verification', 'OTP', '#3B82F6', 10, 'auth0|e2e-admin');

INSERT INTO messages (id, phone_iccid, phone_number, content, timestamp, type, status, verification_code, created_at, updated_at, filter_status)
VALUES
  ('e2e-msg-1', '8965000000000000001', 'BANK', 'Your verification code is 482913. It expires in 5 minutes.',
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-5 minutes'), 'received', 'received', '482913',
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-5 minutes'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-5 minutes'), 'clean'),
  ('e2e-msg-2', '8965000000000000002', 'SHOP', 'Use code 7731 to sign in.',
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-40 minutes'), 'received', 'received', '7731',
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-40 minutes'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-40 minutes'), 'clean'),
  ('e2e-msg-3', '8965000000000000001', 'PROMO', 'Weekend sale: 20% off everything.',
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-2 hours'), 'received', 'received', NULL,
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-2 hours'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-2 hours'), 'filtered');

UPDATE messages SET filter_rule_id = (SELECT id FROM filter_rules WHERE pattern = 'PROMO') WHERE id = 'e2e-msg-3';

INSERT INTO messages (id, phone_iccid, phone_number, content, timestamp, type, status, recipient, created_at, updated_at, filter_status)
VALUES ('e2e-msg-4', '8965000000000000002', '+6580000002', 'Running late, there in 10.',
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hours'), 'sent', 'sent', '+6591234567',
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hours'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 hours'), 'clean');

INSERT INTO message_tags (message_id, keyword_tag_id, matched_text, position)
VALUES ('e2e-msg-1', (SELECT id FROM keyword_tags WHERE keyword = 'verification'), 'verification', 5);

INSERT INTO sim_balance_checks (id, sim_iccid, profile_id, requested_at, sent_at, completed_at, status, response_sender, raw_response, parser_version, requested_by_subject)
VALUES ('e2e-check-1', '8986000000000000003', 'cn-mobile-sms-menu-v1',
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 days'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 days'),
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 days', '+2 minutes'), 'parsed', '10086',
   'Your balance is 25.30 yuan.', 'cn-mobile-menu-v1', 'auth0|e2e-admin');

INSERT INTO sim_balance_metrics (check_id, metric_type, value, unit, currency)
VALUES ('e2e-check-1', 'cash_balance', 25.3, NULL, 'CNY');

INSERT INTO carrier_billing_accounts (id, country_code, carrier, currency, display_name, notification_sim_iccid, account_ref_digest, account_ref_last4, status, created_by)
VALUES ('e2e-account-1', 'SG', 'Singtel', 'SGD', 'Singtel team plan', '8965000000000000001',
   '0000000000000000000000000000000000000000000000000000000000000001', '4821', 'active', 'auth0|e2e-admin');

INSERT INTO carrier_billing_account_sims (billing_account_id, sim_iccid, verification_source, verified_at, verified_by)
VALUES ('e2e-account-1', '8965000000000000001', 'contract_or_bill', '2026-11-01T00:00:00Z', 'auth0|e2e-admin');

INSERT INTO carrier_bills (id, billing_account_id, amount_minor, currency, due_date, received_at, parser_version)
VALUES ('e2e-bill-1', 'e2e-account-1', 8650, 'SGD', date('now', '+10 days'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-3 days'), 'singtel-postpaid-v1');

INSERT INTO calls (id, direction, iccid, remote_number, outcome, started_at, answered_at, ended_at, duration_seconds, answered_by)
VALUES ('e2e-call-1', 'inbound', '8965000000000000001', '+6591234567', 'answered',
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-3 hours'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-3 hours', '+5 seconds'),
   strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-3 hours', '+65 seconds'), 60, 'auth0|e2e-admin');
