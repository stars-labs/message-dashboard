-- Migration 017: Import phone numbers from phone_number_list.csv into sims user override fields
-- Source: phone_number_list.csv (95 SIMs with known phone numbers)
--
-- This sets user_phone_number, user_carrier, user_country_code, and enables user_override
-- so that device_view displays these values instead of the (often NULL) daemon-reported ones.
--
-- Test locally first:
--   npx wrangler d1 execute sms-dashboard --local --file=sms-dashboard/migrations/017_import_phone_numbers.sql
--
-- Apply to production:
--   npx wrangler d1 execute sms-dashboard --remote --file=sms-dashboard/migrations/017_import_phone_numbers.sql

-- China (+86) — 联通/移动/电信
UPDATE sims SET user_phone_number = '+8617600419127', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860117811049221139';
UPDATE sims SET user_phone_number = '+8613520607015', user_carrier = '移动', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '898600520121F0517883';
UPDATE sims SET user_phone_number = '+8617600645518', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860117811049221097';
UPDATE sims SET user_phone_number = '+8617600642068', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860124801233878738';
UPDATE sims SET user_phone_number = '+8617600604190', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860117801159733478';
UPDATE sims SET user_phone_number = '+8618614225110', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860117811039434858';
UPDATE sims SET user_phone_number = '+8617611541697', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860124801222265285';
UPDATE sims SET user_phone_number = '+8618612727588', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860118803066661072';
UPDATE sims SET user_phone_number = '+8618610290441', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860116811004358216';
UPDATE sims SET user_phone_number = '+8617600604197', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860117811049171870';
UPDATE sims SET user_phone_number = '+8618613803341', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860117811048355094';
UPDATE sims SET user_phone_number = '+8613005733632', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860117801716597135';
UPDATE sims SET user_phone_number = '+8613288140961', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860118803322023836';
UPDATE sims SET user_phone_number = '+8616698203377', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860118803426385081';
UPDATE sims SET user_phone_number = '+8615089255335', user_carrier = '移动', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860040191833946266';
UPDATE sims SET user_phone_number = '+8615089255778', user_carrier = '移动', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860040191833946279';
UPDATE sims SET user_phone_number = '+8618500339209', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860122802142937419';
UPDATE sims SET user_phone_number = '+8617611601788', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860122802142937476';
UPDATE sims SET user_phone_number = '+8613192820313', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860117801718603428';
UPDATE sims SET user_phone_number = '+8613265143993', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860118803452905448';
UPDATE sims SET user_phone_number = '+8615627135533', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860118803426394158';
UPDATE sims SET user_phone_number = '+8613928328112', user_carrier = '移动', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860000191897457594';
UPDATE sims SET user_phone_number = '+8613927301363', user_carrier = '移动', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860000191897457588';
UPDATE sims SET user_phone_number = '+8613126368136', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860117965700066942';
UPDATE sims SET user_phone_number = '+8613414798409', user_carrier = '移动', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '898600811922C5125654';
UPDATE sims SET user_phone_number = '+8613433506146', user_carrier = '移动', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '898600811922C5125657';
-- SKIPPED: ICCID 89860117801282765439 has two phone numbers in CSV (rows 27 & 37: +8613075286865 and +8613146926709) — needs manual confirmation
UPDATE sims SET user_phone_number = '+8618518367009', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860122801362457439';
UPDATE sims SET user_phone_number = '+8618518363708', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860122801362457363';
UPDATE sims SET user_phone_number = '+8618518362691', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860122801362457389';
UPDATE sims SET user_phone_number = '+8618518363691', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860122801362457371';
UPDATE sims SET user_phone_number = '+8618518365815', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860122801362457355';
UPDATE sims SET user_phone_number = '+8618518366975', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860122801362457447';
UPDATE sims SET user_phone_number = '+8618518360987', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860122801362457413';
UPDATE sims SET user_phone_number = '+8618518363309', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860122801362457397';
UPDATE sims SET user_phone_number = '+8618518365613', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860122801362457405';
-- SKIPPED: same ICCID 89860117801282765439 conflict (see row 27 above)
UPDATE sims SET user_phone_number = '+8618601982453', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860122801620066246';
UPDATE sims SET user_phone_number = '+8618573562112', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860122801373816441';
UPDATE sims SET user_phone_number = '+8617670817007', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860122801373816458';
UPDATE sims SET user_phone_number = '+8615573563178', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860122801373816482';
UPDATE sims SET user_phone_number = '+8616670528580', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860122801373817407';
UPDATE sims SET user_phone_number = '+8615810920390', user_carrier = '移动', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '898600110122F0009637';
UPDATE sims SET user_phone_number = '+8615810920961', user_carrier = '移动', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '898600110122F0009638';
UPDATE sims SET user_phone_number = '+8615811250585', user_carrier = '移动', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '898600110122F0070826';
UPDATE sims SET user_phone_number = '+8615810313390', user_carrier = '移动', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '898600110125F0005745';
UPDATE sims SET user_phone_number = '+8615810653831', user_carrier = '移动', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '898600110122F0072004';
UPDATE sims SET user_phone_number = '+8613162215697', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860123801033340435';
UPDATE sims SET user_phone_number = '+8613121558009', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860123801377761568';
UPDATE sims SET user_phone_number = '+8618612466155', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860118803628668805';
UPDATE sims SET user_phone_number = '+8618519033452', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860118803628668789';
UPDATE sims SET user_phone_number = '+8613810113243', user_carrier = '移动', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '898600810118F0075995';
UPDATE sims SET user_phone_number = '+8613810113124', user_carrier = '移动', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '898600810118F0075991';
UPDATE sims SET user_phone_number = '+8613810113104', user_carrier = '移动', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '898600810118F0075985';
UPDATE sims SET user_phone_number = '+8615311930395', user_carrier = '电信', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860322640106475671';
UPDATE sims SET user_phone_number = '+8615300087125', user_carrier = '电信', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860322640106475689';
UPDATE sims SET user_phone_number = '+8615330221658', user_carrier = '电信', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860322640105012814';
UPDATE sims SET user_phone_number = '+8613552293194', user_carrier = '移动', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '898600550122F0077148';
UPDATE sims SET user_phone_number = '+8613520853194', user_carrier = '移动', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '898600520123F0019962';
UPDATE sims SET user_phone_number = '+8615010735791', user_carrier = '移动', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '898600210123F0018624';
UPDATE sims SET user_phone_number = '+8615010747746', user_carrier = '移动', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '898600210123F0018622';
UPDATE sims SET user_phone_number = '+8615110221418', user_carrier = '移动', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '898600310123F0100634';
UPDATE sims SET user_phone_number = '+8618573573516', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860121507480069235';
UPDATE sims SET user_phone_number = '+8618573573517', user_carrier = '联通', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860121507480069243';
UPDATE sims SET user_phone_number = '+8613692844044', user_carrier = '移动', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860080192245965420';
UPDATE sims SET user_phone_number = '+8618026633061', user_carrier = '电信', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860324247522003125';
UPDATE sims SET user_phone_number = '+8618026603550', user_carrier = '电信', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860324247522003133';
UPDATE sims SET user_phone_number = '+8618026655502', user_carrier = '电信', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89860324247522003117';
UPDATE sims SET user_phone_number = '+8613810113094', user_carrier = '移动', user_country_code = 'CN', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '898600810118F0075976';

-- Hong Kong (+852) — 移动
UPDATE sims SET user_phone_number = '+85246820057', user_carrier = '移动', user_country_code = 'HK', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89852122109190418053';
UPDATE sims SET user_phone_number = '+85246708256', user_carrier = '移动', user_country_code = 'HK', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89852122111066626330';
UPDATE sims SET user_phone_number = '+85246851509', user_carrier = '移动', user_country_code = 'HK', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '89852122109190451633';

-- Singapore (+65) — Singtel
UPDATE sims SET user_phone_number = '+6590950236', user_carrier = 'Singtel', user_country_code = 'SG', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '8965030124051507851';
UPDATE sims SET user_phone_number = '+6591936675', user_carrier = 'Singtel', user_country_code = 'SG', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '8965030124051507927';
UPDATE sims SET user_phone_number = '+6590429789', user_carrier = 'Singtel', user_country_code = 'SG', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '8965030124051507893';
UPDATE sims SET user_phone_number = '+6591974586', user_carrier = 'Singtel', user_country_code = 'SG', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '8965030124051507901';
UPDATE sims SET user_phone_number = '+6590421798', user_carrier = 'Singtel', user_country_code = 'SG', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '8965030124051507919';

-- Singapore (+65) — M1
UPDATE sims SET user_phone_number = '+6592953543', user_carrier = 'M1', user_country_code = 'SG', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '8965012211290057038';
UPDATE sims SET user_phone_number = '+6596414890', user_carrier = 'M1', user_country_code = 'SG', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '8965012211290057004';
UPDATE sims SET user_phone_number = '+6591143685', user_carrier = 'M1', user_country_code = 'SG', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '8965012211290056949';
UPDATE sims SET user_phone_number = '+6591252034', user_carrier = 'M1', user_country_code = 'SG', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '8965012211290057046';

-- Singapore (+65) — Starhub
UPDATE sims SET user_phone_number = '+6598630587', user_carrier = 'Starhub', user_country_code = 'SG', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '8965012306052579276';
UPDATE sims SET user_phone_number = '+6598625361', user_carrier = 'Starhub', user_country_code = 'SG', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '8965012306052580191';
UPDATE sims SET user_phone_number = '+6598361684', user_carrier = 'Starhub', user_country_code = 'SG', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '8965012306052576256';
UPDATE sims SET user_phone_number = '+6598346215', user_carrier = 'Starhub', user_country_code = 'SG', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '8965012306052577791';
UPDATE sims SET user_phone_number = '+6597817169', user_carrier = 'Starhub', user_country_code = 'SG', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '8965012306052373985';
UPDATE sims SET user_phone_number = '+6580282279', user_carrier = 'Starhub', user_country_code = 'SG', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '8965012306052989673';
UPDATE sims SET user_phone_number = '+6580289164', user_carrier = 'Starhub', user_country_code = 'SG', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '8965012306052989681';
UPDATE sims SET user_phone_number = '+6580286158', user_carrier = 'Starhub', user_country_code = 'SG', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '8965012306052989715';
UPDATE sims SET user_phone_number = '+6580309673', user_carrier = 'Starhub', user_country_code = 'SG', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '8965012306052989731';
UPDATE sims SET user_phone_number = '+6580541107', user_carrier = 'Starhub', user_country_code = 'SG', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '8965012306052989657';
UPDATE sims SET user_phone_number = '+6580299172', user_carrier = 'Starhub', user_country_code = 'SG', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '8965012306052989665';
UPDATE sims SET user_phone_number = '+6580283723', user_carrier = 'Starhub', user_country_code = 'SG', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '8965012306052989640';
UPDATE sims SET user_phone_number = '+6580284821', user_carrier = 'Starhub', user_country_code = 'SG', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '8965012306052989707';
UPDATE sims SET user_phone_number = '+6580291718', user_carrier = 'Starhub', user_country_code = 'SG', user_override_enabled = TRUE, user_updated_at = CURRENT_TIMESTAMP WHERE iccid = '8965012306052989699';

-- Record migration
INSERT INTO schema_version (version, description, applied_at)
VALUES (18, 'Import phone numbers from CSV into sims user override fields (93 SIMs)', CURRENT_TIMESTAMP);
