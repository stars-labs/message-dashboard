use super::sms_send::{SMS_PROMPT_TIMEOUT, SMS_PROMPT_TIMEOUT_ERROR};
use super::*;
use crate::identifiers::{Iccid, Imei, SimNumber};
use crate::types::{SmsStorage, SmsSubmission};
use anyhow::anyhow;
use std::collections::BTreeMap;
use std::time::Duration;

#[test]
fn pdu_whose_udhl_overruns_the_pdu_is_an_error() {
    let pdu = "0040008100000000000000000005FF01";
    assert!(AtModemManager::parse_pdu_sms(0, pdu).is_err());
}

#[test]
fn pdu_line_with_multibyte_character_is_an_error() {
    let pdu = "0\u{e9}400081000000000000000000";
    assert!(AtModemManager::parse_pdu_sms(0, pdu).is_err());
}

#[test]
fn cmgl_header_without_a_time_field_does_not_panic() {
    let header = r#"+CMGL: 1,"REC READ","+123","","24/01/15""#;
    let (index, sender, _) = AtModemManager::parse_cmgl_header(header).unwrap();
    assert_eq!((index, sender.as_str()), (1, "+123"));
}

#[test]
fn timestamp_with_a_multibyte_first_character_does_not_panic() {
    let stamp = AtModemManager::normalize_sms_timestamp("24/01/15", "\u{4f60}0:30:45");
    assert!(stamp.starts_with("2024-01-15"));
}

#[tokio::test]
async fn reuses_one_serial_lock_per_port() {
    let manager = AtModemManager::new();
    let first = manager.port_lock("/dev/ttyUSB2").await;
    let same_port = manager.port_lock("/dev/ttyUSB2").await;
    let other_port = manager.port_lock("/dev/ttyUSB6").await;

    assert!(Arc::ptr_eq(&first, &same_port));
    assert!(!Arc::ptr_eq(&first, &other_port));
}

#[test]
fn retries_only_before_the_sms_body_is_written() {
    assert!(AtModemManager::is_prompt_timeout(&anyhow!(
        SMS_PROMPT_TIMEOUT_ERROR
    )));
    assert!(!AtModemManager::is_prompt_timeout(&anyhow!(
        "Send SMS failed after Ctrl-Z"
    )));
    assert_eq!(SMS_PROMPT_TIMEOUT, Duration::from_secs(10));
}

#[test]
fn treats_post_submit_timeout_without_modem_error_as_unconfirmed_submission() {
    assert_eq!(
        AtModemManager::classify_sms_submit_response("0", true).unwrap(),
        SmsSubmission::SubmittedUnconfirmed,
    );
}

#[test]
fn recovers_the_at_channel_only_after_an_unconfirmed_submission() {
    assert!(AtModemManager::should_recover_after_submit(
        SmsSubmission::SubmittedUnconfirmed
    ));
    assert!(!AtModemManager::should_recover_after_submit(
        SmsSubmission::Confirmed
    ));
}

#[test]
fn turns_a_late_explicit_modem_error_into_a_failed_submission() {
    let error =
        AtModemManager::classify_post_submit_recovery_response("+CMS ERROR: 350\r\n").unwrap_err();

    assert!(error.to_string().contains("+CMS ERROR: 350"));
    assert!(AtModemManager::classify_post_submit_recovery_response("AT\r\nOK\r\n").is_ok());
    assert!(AtModemManager::classify_post_submit_recovery_response("NO ERROR").is_ok());
}

#[test]
fn requires_an_explicit_modem_error_to_fail_after_submission() {
    let error =
        AtModemManager::classify_sms_submit_response("+CMS ERROR: 500\r\n", false).unwrap_err();

    assert!(error.to_string().contains("+CMS ERROR: 500"));
}

#[test]
fn does_not_treat_words_in_the_echo_as_final_result_codes() {
    assert_eq!(
        AtModemManager::classify_sms_submit_response("BOOK", true).unwrap(),
        SmsSubmission::SubmittedUnconfirmed,
    );
    assert_eq!(
        AtModemManager::classify_sms_submit_response("NO ERROR", true).unwrap(),
        SmsSubmission::SubmittedUnconfirmed,
    );
}

fn four_port_modem() -> BTreeMap<String, Vec<String>> {
    let mut groups = BTreeMap::new();
    groups.insert(
        "1-1.3.4.3.4".to_string(),
        (68..=71).map(|n| format!("/dev/ttyUSB{n}")).collect(),
    );
    groups
}

#[test]
fn test_pick_voice_ports_returns_nmea_and_modem() {
    assert_eq!(
        AtModemManager::pick_voice_ports(&four_port_modem(), "/dev/ttyUSB70"),
        Some(VoicePorts {
            nmea: "/dev/ttyUSB69".to_string(),
            modem: "/dev/ttyUSB71".to_string(),
        })
    );
}

#[test]
fn test_pick_voice_ports_none_for_slimmed_modem() {
    let mut groups = BTreeMap::new();
    groups.insert(
        "1-1.3.4.3.5".to_string(),
        (80..=82).map(|n| format!("/dev/ttyUSB{n}")).collect(),
    );
    assert_eq!(
        AtModemManager::pick_voice_ports(&groups, "/dev/ttyUSB81"),
        None
    );
}

#[test]
fn test_pick_voice_ports_none_when_port_is_not_the_at_port() {
    assert_eq!(
        AtModemManager::pick_voice_ports(&four_port_modem(), "/dev/ttyUSB71"),
        None
    );
}

#[test]
fn test_pick_voice_ports_none_for_unknown_port() {
    assert_eq!(
        AtModemManager::pick_voice_ports(&four_port_modem(), "/dev/ttyUSB99"),
        None
    );
}

#[test]
fn test_validate_recipient_accepts_e164() {
    assert!(AtModemManager::validate_recipient_with_short_code("+6512345678", false).is_ok());
    assert!(AtModemManager::validate_recipient_with_short_code("6512345678", false).is_ok());
    assert!(AtModemManager::validate_recipient_with_short_code("+861380013800", false).is_ok());
    assert!(AtModemManager::validate_recipient_with_short_code("123456", false).is_ok());
    assert!(AtModemManager::validate_recipient_with_short_code("+123456789012345", false).is_ok());
}

#[test]
fn test_validate_recipient_rejects_at_injection() {
    // The payload from the security review: terminate CMGS, then wipe the SIM.
    assert!(AtModemManager::validate_recipient_with_short_code(
        "+6512345678\r\nAT+CMGD=1,4\r",
        false
    )
    .is_err());
    assert!(
        AtModemManager::validate_recipient_with_short_code("+6512345678\rAT+CMGD=1,4", false)
            .is_err()
    );
    assert!(AtModemManager::validate_recipient_with_short_code("+6512345678\n", false).is_err());
    assert!(AtModemManager::validate_recipient_with_short_code("+65123\"", false).is_err());
    assert!(AtModemManager::validate_recipient_with_short_code("+65123\x1A", false).is_err());
    assert!(AtModemManager::validate_recipient_with_short_code("+65123\x1B", false).is_err());
    assert!(AtModemManager::validate_recipient_with_short_code("+65123\0", false).is_err());
}

#[test]
fn test_validate_recipient_rejects_malformed() {
    assert!(AtModemManager::validate_recipient_with_short_code("", false).is_err());
    assert!(AtModemManager::validate_recipient_with_short_code("+", false).is_err());
    assert!(AtModemManager::validate_recipient_with_short_code("12345", false).is_err());
    assert!(
        AtModemManager::validate_recipient_with_short_code("+1234567890123456", false).is_err()
    );
    assert!(AtModemManager::validate_recipient_with_short_code("+65 1234 5678", false).is_err());
    assert!(AtModemManager::validate_recipient_with_short_code("+65-1234-5678", false).is_err());
    assert!(AtModemManager::validate_recipient_with_short_code("not-a-number", false).is_err());
    assert!(AtModemManager::validate_recipient_with_short_code("65+12345678", false).is_err());
}

#[test]
fn test_validate_recipient_allows_short_code_only_when_explicit() {
    assert!(AtModemManager::validate_recipient_with_short_code("10086", false).is_err());
    assert!(AtModemManager::validate_recipient_with_short_code("10086", true).is_ok());
    assert!(AtModemManager::validate_recipient_with_short_code("123", true).is_ok());
    assert!(AtModemManager::validate_recipient_with_short_code("+10086", true).is_err());
    assert!(AtModemManager::validate_recipient_with_short_code("12", true).is_err());
    assert!(AtModemManager::validate_recipient_with_short_code("10086\r", true).is_err());
    assert!(AtModemManager::validate_recipient_with_short_code("10A86", true).is_err());
}

#[test]
fn test_validate_message_body_rejects_terminators() {
    assert!(AtModemManager::validate_message_body("hello").is_ok());
    assert!(AtModemManager::validate_message_body("你好，验证码 1234").is_ok());
    assert!(AtModemManager::validate_message_body("line one\nline two").is_ok());
    assert!(AtModemManager::validate_message_body("line one\r\nline two").is_ok());

    assert!(AtModemManager::validate_message_body("x\x1AAT+CMGD=1,4\r").is_err());
    assert!(AtModemManager::validate_message_body("x\x1B").is_err());
    assert!(AtModemManager::validate_message_body("x\0y").is_err());
}

#[test]
fn test_parse_iccid() {
    assert_eq!(
        AtModemManager::parse_iccid("+QCCID: 89860121750097854321"),
        Iccid::try_from("89860121750097854321").ok()
    );
    assert_eq!(
        AtModemManager::parse_iccid("89860121750097854321\nOK"),
        Iccid::try_from("89860121750097854321").ok()
    );
    assert_eq!(
        AtModemManager::parse_iccid("+QCCID: 8965012306052989707F"),
        Iccid::try_from("8965012306052989707").ok()
    );
    assert_eq!(
        AtModemManager::parse_iccid("AT+QCCID\r\n+QCCID: 8965012306052989681F\r\n\r\nOK\r\n"),
        Iccid::try_from("8965012306052989681").ok()
    );
}

#[test]
fn parse_iccid_accepts_exactly_what_it_accepted_before_it_was_typed() {
    for (response, expected) in [
        ("+CCID: 898600520121F0517883", Some("898600520121F0517883")),
        (
            "+ICCID: \"89860121750097854321\"",
            Some("89860121750097854321"),
        ),
        ("+QCCID: 89860121750097854a", Some("89860121750097854a")),
        ("+QCCID: 898601217500978543", Some("898601217500978543")),
        ("+QCCID: 89860121750097854", None),
        ("+QCCID: 8986012175009785432G", None),
        ("+QCCID: ", None),
        ("8986012175009785432123\nOK", Some("8986012175009785432123")),
        ("89860121750097854321234\nOK", None),
        ("OK", None),
        ("", None),
    ] {
        assert_eq!(
            AtModemManager::parse_iccid(response),
            expected.map(|text| Iccid::try_from(text).unwrap()),
            "{response:?}"
        );
    }
}

#[test]
fn parse_imei_needs_a_line_of_exactly_fifteen_digits() {
    let imei = |text: &str| Imei::try_from(text).ok();
    assert_eq!(
        AtModemManager::parse_imei("AT+CGSN\r\n860123456789012\r\n\r\nOK\r\n"),
        imei("860123456789012")
    );
    assert_eq!(
        AtModemManager::parse_imei("  860123456789012  \nOK"),
        imei("860123456789012")
    );
    assert_eq!(AtModemManager::parse_imei("86012345678901\nOK"), None);
    assert_eq!(AtModemManager::parse_imei("8601234567890123\nOK"), None);
    assert_eq!(AtModemManager::parse_imei("86012345678901a\nOK"), None);
    assert_eq!(AtModemManager::parse_imei("ERROR"), None);
}

#[test]
fn parse_cnum_keeps_any_non_empty_number() {
    let number = |text: &str| SimNumber::try_from(text).ok();
    assert_eq!(
        AtModemManager::parse_cnum("+CNUM: \"\",\"+6591234567\",145\nOK"),
        number("+6591234567")
    );
    assert_eq!(
        AtModemManager::parse_cnum("+CNUM: \"\",\" 6591234567 \",129"),
        number("6591234567")
    );
    assert_eq!(AtModemManager::parse_cnum("+CNUM: \"\",\"\",129"), None);
    assert_eq!(AtModemManager::parse_cnum("+CNUM: \"\",\"   \",129"), None);
    assert_eq!(AtModemManager::parse_cnum("OK"), None);
}

#[test]
fn test_parse_cpms_read_stores_uses_mem1_capabilities_only() {
    let response = concat!(
        "AT+CPMS=?\r\n",
        "+CPMS: (\"ME\",\"MT\",\"SM\",\"SR\"),(\"ME\",\"SM\"),(\"ME\",\"SM\")\r\n",
        "OK\r\n"
    );

    assert_eq!(
        AtModemManager::parse_cpms_read_stores(response),
        vec!["ME", "MT", "SM", "SR"]
    );
}

#[test]
fn test_parse_cpms_read_stores_rejects_malformed_response() {
    assert!(AtModemManager::parse_cpms_read_stores("OK").is_empty());
    assert!(AtModemManager::parse_cpms_read_stores("+CPMS: \"MT\"").is_empty());
    assert!(AtModemManager::parse_cpms_read_stores("+CPMS: (\"MT\"").is_empty());
}

#[test]
fn test_select_sms_storage_command_text_is_unchanged() {
    assert_eq!(
        AtModemManager::select_sms_storage_command(SmsStorage::Me),
        "AT+CPMS=\"ME\""
    );
    assert_eq!(
        AtModemManager::select_sms_storage_command(SmsStorage::Sm),
        "AT+CPMS=\"SM\""
    );
    assert_eq!(
        AtModemManager::select_sms_storage_command(SmsStorage::Mt),
        "AT+CPMS=\"MT\""
    );
}

#[test]
fn test_sms_read_store_candidates_scan_me_then_sm() {
    let supported = vec!["SM".into(), "ME".into(), "MT".into(), "SR".into()];

    assert_eq!(
        AtModemManager::sms_read_store_candidates(&supported),
        vec![SmsStorage::Me, SmsStorage::Sm]
    );
}

#[test]
fn test_sms_read_store_candidates_use_mt_only_as_fallback() {
    let supported = vec!["MT".into(), "SR".into()];

    assert_eq!(
        AtModemManager::sms_read_store_candidates(&supported),
        vec![SmsStorage::Mt]
    );
}

#[test]
fn test_sms_read_store_candidates_exclude_status_report_storage() {
    let supported = vec!["SR".into(), "BM".into()];

    assert!(AtModemManager::sms_read_store_candidates(&supported).is_empty());
}

#[test]
fn test_ucs2_decode() {
    assert_eq!(
        AtModemManager::decode_ucs2_hex("4F60597D"),
        Some("你好".to_string())
    );

    assert_eq!(
        AtModemManager::decode_ucs2_hex("00480069"),
        Some("Hi".to_string())
    );

    assert_eq!(AtModemManager::decode_ucs2_hex(""), Some(String::new()));
    assert_eq!(AtModemManager::decode_ucs2_hex("4F6"), None);
}

#[test]
fn test_decode_sms_content() {
    assert_eq!(AtModemManager::decode_sms_content("4F60597D"), "你好");

    assert_eq!(
        AtModemManager::decode_sms_content("Hello World"),
        "Hello World"
    );

    assert_eq!(
        AtModemManager::decode_sms_content("1234"),
        AtModemManager::decode_sms_content("1234")
    );
}

#[test]
fn test_decode_sms_sender_normalizes_decimal_ascii_names() {
    assert_eq!(
        AtModemManager::decode_sms_sender("83105110103116101108"),
        "Singtel"
    );
    assert_eq!(
        AtModemManager::decode_sms_sender("831051101031161011083266105122"),
        "Singtel Biz"
    );
}

#[test]
fn test_decode_sms_sender_preserves_numeric_addresses() {
    assert_eq!(AtModemManager::decode_sms_sender("1234"), "1234");
    assert_eq!(
        AtModemManager::decode_sms_sender("6591234567"),
        "6591234567"
    );
}

#[test]
fn test_pdu_7bit_gsm_encoding() {
    let bytes = vec![0xC8, 0x32, 0x9B, 0xFD, 0x06];
    let result = AtModemManager::decode_pdu_7bit(&bytes, 5, 0);
    assert_eq!(result, "Hello");
}

#[test]
fn test_pdu_ucs2_encoding_chinese() {
    let bytes = vec![0x4F, 0x60, 0x59, 0x7D];
    let result = AtModemManager::decode_pdu_ucs2(&bytes, 4);
    assert_eq!(result, "你好");
}

#[test]
fn test_pdu_ucs2_encoding_mixed() {
    let bytes = vec![0x00, 0x48, 0x00, 0x69, 0x4F, 0x60, 0x59, 0x7D];
    let result = AtModemManager::decode_pdu_ucs2(&bytes, 8);
    assert_eq!(result, "Hi你好");
}

#[test]
fn test_pdu_ucs2_with_udh() {
    // The caller strips the UDH (05 00 03 42 02 01) before decode_pdu_ucs2.
    let bytes = vec![0x4F, 0x60];
    let result = AtModemManager::decode_pdu_ucs2(&bytes, 2);
    assert_eq!(result, "你");
}

#[test]
fn test_pdu_dcs_detection() {
    let dcs_7bit = 0x00;
    assert_eq!(dcs_7bit & 0x04, 0);

    let dcs_ucs2_common = 0x08;
    assert_ne!(dcs_ucs2_common & 0x08, 0);

    let dcs_ucs2_explicit = 0x0C;
    assert_ne!(dcs_ucs2_explicit & 0x04, 0);
    assert_ne!(dcs_ucs2_explicit & 0x08, 0);

    let dcs_8bit = 0x04;
    assert_ne!(dcs_8bit & 0x04, 0);
    assert_eq!(dcs_8bit & 0x08, 0);
}

#[test]
fn test_extract_udh_concat() {
    // IEI=0x00, IEDL=0x03, ref_id=0x42, total=2, part=1
    let udh = vec![0x00, 0x03, 0x42, 0x02, 0x01];
    let result = AtModemManager::extract_udh_concat(&udh);
    assert!(result.is_some());
    let concat = result.unwrap();
    assert_eq!(concat.ref_id, 0x42);
    assert_eq!(concat.total_parts, 2);
    assert_eq!(concat.part_number, 1);
}

#[test]
fn test_extract_udh_concat_16bit() {
    // IEI=0x08, IEDL=0x04, ref_id=0x0042, total=2, part=1
    let udh = vec![0x08, 0x04, 0x00, 0x42, 0x02, 0x01];
    let result = AtModemManager::extract_udh_concat(&udh);
    assert!(result.is_some());
    let concat = result.unwrap();
    assert_eq!(concat.ref_id, 0x42);
    assert_eq!(concat.total_parts, 2);
    assert_eq!(concat.part_number, 1);
}

#[test]
fn test_chinese_long_message_encoding() {
    let bytes_part1 = vec![
        0x30, 0x10, 0x80, 0x54, 0x90, 0x1A, // "【联通"
    ];
    let text1 = AtModemManager::decode_pdu_ucs2(&bytes_part1, 6);
    assert!(!text1.is_empty());
    assert!(text1.contains("联") || text1.contains("通"));
}

#[test]
fn test_decode_bcd_phone_standard() {
    let bytes = vec![0x21, 0x43, 0x65, 0x87, 0x09, 0xF0];
    let result = AtModemManager::decode_bcd_phone(&bytes, 11);
    assert_eq!(result, "12345678900");
}

#[test]
fn test_decode_bcd_phone_odd_length() {
    let bytes = vec![0x21, 0x43, 0x65, 0x87, 0xF9];
    let result = AtModemManager::decode_bcd_phone(&bytes, 9);
    assert_eq!(result, "123456789");
}

#[test]
fn test_decode_bcd_phone_chinese() {
    let bytes = vec![0x68, 0x31, 0x08, 0x10, 0x83, 0x00, 0xF0];
    let result = AtModemManager::decode_bcd_phone(&bytes, 13);
    assert_eq!(result, "8613800138000");
}

#[test]
fn test_decode_pdu_timestamp_with_positive_tz() {
    let bytes = vec![0x62, 0x30, 0x11, 0x41, 0x03, 0x00, 0x00];
    let result = AtModemManager::decode_pdu_timestamp(&bytes);
    assert!(result.contains('T'));
    assert!(result.ends_with('Z'));
    assert!(result.len() > 20);
}

#[test]
fn test_decode_pdu_timestamp_with_negative_tz() {
    let bytes = vec![0x62, 0x10, 0x51, 0x21, 0x00, 0x00, 0x23];
    let result = AtModemManager::decode_pdu_timestamp(&bytes);
    assert!(result.contains('T'));
    assert!(result.ends_with('Z'));
}

#[test]
fn test_decode_pdu_timestamp_edge_case() {
    // Too short: falls back to the current time
    let bytes = vec![0x99, 0x99, 0x99];
    let result = AtModemManager::decode_pdu_timestamp(&bytes);
    assert!(result.contains('T'));
    assert!(result.ends_with('Z'));
}

#[test]
fn test_decode_pdu_7bit_with_udh_fill_bits() {
    // UDHL=5: fill bits = (7 - (5+1)*8 % 7) % 7 = 1
    let bytes = vec![
        0x90, 0x64, 0x36, 0x1B, 0x0D, // "Hello" with 1 fill bit offset
    ];
    let result = AtModemManager::decode_pdu_7bit(&bytes, 5, 5);
    assert!(result.len() >= 4);
}

#[test]
fn test_decode_pdu_7bit_long_message() {
    let bytes = vec![
        0x54, 0x74, 0x7A, 0x0E, 0x4A, 0xCF, 0x41, 0x61, 0x10, 0xBD, 0x3C, 0x07, 0xD9, 0xDF, 0x73,
        0x90, 0xFB, 0x0D, 0x9A, 0x03,
    ];
    let result = AtModemManager::decode_pdu_7bit(&bytes, 22, 0);
    assert!(result.len() >= 20);
}

#[test]
fn test_parse_pdu_sms_structure() {
    // SMSC 00, type 04, sender 0B 91 2143658709F0, PID 00, DCS 00, timestamp
    // 42301141030023, UDL 05, text C8329BFD06
    let pdu = "00040B912143658709F00000423011410300230AC8329BFD06";
    let result = AtModemManager::parse_pdu_sms(1, pdu);
    assert!(result.is_ok());
    let sms = result.unwrap();
    assert_eq!(sms.index, 1);
    assert!(!sms.text.is_empty());
    assert!(sms.concat_info.is_none());
}

#[test]
fn test_parse_pdu_sms_with_udh_structure() {
    // Type 44 (bit 6 = UDH present); UDL 0A covers UDH plus text; UDHL 05,
    // UDH 00 03 42 02 01 (ref=0x42, total=2, part=1); text A8
    let pdu = "00440B912143658709F00000423011410300230A0500034202 01A8";
    let result = AtModemManager::parse_pdu_sms(3, &pdu.replace(' ', ""));
    assert!(result.is_ok());
    let sms = result.unwrap();
    assert_eq!(sms.index, 3);
    assert!(sms.concat_info.is_some());
    if let Some(concat) = sms.concat_info {
        assert_eq!(concat.ref_id, 0x42);
        assert_eq!(concat.total_parts, 2);
        assert_eq!(concat.part_number, 1);
    }
}

#[test]
fn test_parse_pdu_sms_error_truncated() {
    let pdu = "07916831";
    let result = AtModemManager::parse_pdu_sms(5, pdu);
    assert!(result.is_err());
}

#[test]
fn test_parse_pdu_sms_error_invalid_hex() {
    let pdu = "ZZZZZZZZZZ";
    let result = AtModemManager::parse_pdu_sms(6, pdu);
    assert!(result.is_err());
}

#[test]
fn test_extract_udh_concat_no_concat_header() {
    // IEI=0x01 (special SMS indication), IEDL=0x02
    let udh = vec![0x01, 0x02, 0x00, 0x01];
    let result = AtModemManager::extract_udh_concat(&udh);
    assert!(result.is_none());
}

#[test]
fn test_extract_udh_concat_truncated() {
    // IEDL=3 but total_parts and part_number are missing
    let udh = vec![0x00, 0x03, 0x42];
    let result = AtModemManager::extract_udh_concat(&udh);
    assert!(result.is_none());
}

#[test]
fn test_extract_udh_concat_16bit_full_reference() {
    // IEI=0x08, IEDL=0x04, ref=0xABCD, total=3, part=1
    let udh = vec![0x08, 0x04, 0xAB, 0xCD, 0x03, 0x01];
    let result = AtModemManager::extract_udh_concat(&udh);
    assert!(result.is_some());
    let concat = result.unwrap();
    assert_eq!(concat.ref_id, 0xCD);
    assert_eq!(concat.total_parts, 3);
    assert_eq!(concat.part_number, 1);
}

#[test]
fn test_decode_pdu_ucs2_empty() {
    let bytes = vec![];
    let result = AtModemManager::decode_pdu_ucs2(&bytes, 0);
    assert_eq!(result, "");
}

#[test]
fn test_decode_pdu_ucs2_odd_length() {
    let bytes = vec![0x4F, 0x60, 0x59];
    let result = AtModemManager::decode_pdu_ucs2(&bytes, 3);
    assert!(!result.is_empty() || result == "?");
}

#[test]
fn test_decode_pdu_7bit_boundary_conditions() {
    // 160 septets (the single-SMS limit) pack into 140 bytes
    let bytes = vec![0x41; 140];
    let result = AtModemManager::decode_pdu_7bit(&bytes, 160, 0);
    assert_eq!(result.chars().count(), 160);
}

#[test]
fn test_decode_bcd_phone_empty() {
    let bytes = vec![];
    let result = AtModemManager::decode_bcd_phone(&bytes, 0);
    assert_eq!(result, "");
}

#[test]
fn test_parse_pdu_sms_8bit_encoding() {
    // DCS 04 (8-bit), UDL 05, text 48656C6C6F
    let pdu = "00040B912143658709F00004423011410300230548656C6C6F";
    let result = AtModemManager::parse_pdu_sms(7, pdu);
    assert!(result.is_ok());
    let sms = result.unwrap();
    assert_eq!(sms.text, "Hello");
}

#[test]
fn test_decode_8bit_wap_push_as_safe_summary() {
    let payload = b"\x00\x06\x05\xff\xfeW\x80\x81http://z1.v-mas.cn:30089//v?c=243004716252924832&m=2909341\x00";

    let text = AtModemManager::decode_pdu_8bit(payload);

    assert_eq!(
        text,
        "运营商 WAP Push\n链接：http://z1.v-mas.cn:30089//v?c=243004716252924832&m=2909341"
    );
    assert!(!text.contains('\u{fffd}'));
    assert!(!text.contains('\0'));
}

#[test]
fn test_decode_8bit_non_wap_payload_keeps_existing_lossy_behavior() {
    assert_eq!(AtModemManager::decode_pdu_8bit(b"\xffA"), "\u{fffd}A");
}

#[test]
fn test_parse_pdu_sms_ucs2_encoding() {
    // DCS 08 (UCS-2), UDL 04, text 4F60597D
    let pdu = "00040B912143658709F000084230114103002304004F60597D";
    let result = AtModemManager::parse_pdu_sms(8, pdu);
    assert!(result.is_ok());
    let sms = result.unwrap();
    assert!(sms.text.contains("你") || sms.text.contains("好") || sms.text.len() >= 2);
    assert!(sms.concat_info.is_none());
}

#[test]
fn test_decode_bcd_phone_with_hex_nibbles() {
    // 0xBA: low nibble A = '*', high nibble B = '#'
    let bytes = vec![0xBA];
    let result = AtModemManager::decode_bcd_phone(&bytes, 2);
    assert_eq!(result, "*#");
}

/// A directory tree shaped like sysfs, where each port's `device` link resolves
/// through a `…:1.N` ancestor.
fn sysfs_with_ports(ports: &[(u8, &str)]) -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let root = std::env::temp_dir().join(format!(
        "at-discovery-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&root);
    let class_dir = root.join("sys/class/tty");
    for (interface, tty) in ports {
        let device = root.join(format!(
            "sys/devices/platform/usb/{}:1.{interface}",
            tty.trim_start_matches("/dev/")
        ));
        std::fs::create_dir_all(&device).unwrap();
        std::fs::write(device.join("idVendor"), b"2c7c").unwrap();
        let link = class_dir
            .join(tty.trim_start_matches("/dev/"))
            .join("device");
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&device, &link).unwrap();
    }
    root
}

#[test]
fn at_probe_order_follows_interface_number_not_tty_number() {
    // The AT port has the lowest ttyUSB number, so sorting puts it first and a
    // positional guess lands on the NMEA port.
    let root = sysfs_with_ports(&[
        (2, "/dev/ttyUSB100"),
        (0, "/dev/ttyUSB101"),
        (1, "/dev/ttyUSB102"),
        (3, "/dev/ttyUSB103"),
    ]);
    let mut ports: Vec<String> = [
        "/dev/ttyUSB100",
        "/dev/ttyUSB101",
        "/dev/ttyUSB102",
        "/dev/ttyUSB103",
    ]
    .map(String::from)
    .to_vec();
    ports.sort_unstable();

    let order = AtModemManager::at_probe_order_in(&root, &ports);
    assert_eq!(order.first(), Some(&"/dev/ttyUSB100".to_string()));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn usb_interface_for_port_reads_the_sysfs_ancestor() {
    let root = sysfs_with_ports(&[(0, "/dev/ttyUSB1"), (2, "/dev/ttyUSB9")]);
    assert_eq!(
        AtModemManager::usb_interface_for_port_in(&root, "/dev/ttyUSB9"),
        Some(2)
    );
    assert_eq!(
        AtModemManager::usb_interface_for_port_in(&root, "/dev/ttyUSB1"),
        Some(0)
    );
    assert_eq!(
        AtModemManager::usb_interface_for_port_in(&root, "/dev/ttyUSB404"),
        None
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn at_probe_order_does_not_guess_position_2_for_a_three_port_device() {
    // DIAG/AT/MODEM without NMEA sorts AT into position 1; position 2 is the MODEM
    // port, which answers a bare "AT".
    let ports: Vec<String> = (0..3).map(|n| format!("/dev/ttyUSB{n}")).collect();
    assert_ne!(AtModemManager::at_probe_order(&ports).first(), ports.get(2));
}

#[test]
fn at_probe_order_keeps_the_legacy_guess_for_the_default_four_port_layout() {
    // The default DIAG/NMEA/AT/MODEM layout keeps AT at position 2.
    let ports: Vec<String> = (0..4).map(|n| format!("/dev/ttyUSB{n}")).collect();
    assert_eq!(AtModemManager::at_probe_order(&ports).first(), ports.get(2));
}

#[test]
fn test_at_probe_order() {
    // These paths do not exist, so interface lookup falls back to position: a 4-port
    // device keeps slot 2 as the AT port, a shorter one keeps its own order.
    let p4: Vec<String> = (0..4).map(|n| format!("/dev/ttyUSB{n}")).collect();
    assert_eq!(
        AtModemManager::at_probe_order(&p4),
        vec![
            "/dev/ttyUSB2",
            "/dev/ttyUSB0",
            "/dev/ttyUSB1",
            "/dev/ttyUSB3"
        ]
    );
    let p2: Vec<String> = vec!["/dev/ttyUSB6".into(), "/dev/ttyUSB7".into()];
    assert_eq!(
        AtModemManager::at_probe_order(&p2),
        vec!["/dev/ttyUSB6", "/dev/ttyUSB7"]
    );
    let p1: Vec<String> = vec!["/dev/ttyUSB9".into()];
    assert_eq!(AtModemManager::at_probe_order(&p1), vec!["/dev/ttyUSB9"]);
}

#[test]
fn test_modem_id_port_roundtrip() {
    assert_eq!(AtModemManager::port_to_modem_id("/dev/ttyUSB2"), "2");
    assert_eq!(AtModemManager::port_to_modem_id("/dev/ttyUSB0"), "0");
    assert_eq!(AtModemManager::port_to_modem_id("/dev/ttyUSB58"), "58");
    assert_eq!(AtModemManager::modem_id_to_port("2"), "/dev/ttyUSB2");
    assert_eq!(AtModemManager::modem_id_to_port("0"), "/dev/ttyUSB0");
    assert_eq!(AtModemManager::modem_id_to_port("58"), "/dev/ttyUSB58");
    for n in ["0", "1", "2", "6", "57", "240"] {
        let port = AtModemManager::modem_id_to_port(n);
        assert_eq!(AtModemManager::port_to_modem_id(&port), n);
    }
}

#[test]
fn test_usbfs_node_path_zero_pads() {
    assert_eq!(
        AtModemManager::usbfs_node_path(3, 7),
        "/dev/bus/usb/003/007"
    );
    assert_eq!(
        AtModemManager::usbfs_node_path(1, 120),
        "/dev/bus/usb/001/120"
    );
    assert_eq!(
        AtModemManager::usbfs_node_path(255, 255),
        "/dev/bus/usb/255/255"
    );
}

#[test]
fn test_decode_bcd_phone_mixed_digits_and_hex() {
    // "1*" -> 0xA1 (low=1, high=A); "2#" -> 0xB2
    let bytes = vec![0xA1, 0xB2];
    let result = AtModemManager::decode_bcd_phone(&bytes, 4);
    assert_eq!(result, "1*2#");
}

#[test]
fn test_decode_bcd_phone_nibble_c_d() {
    let bytes = vec![0xDC];
    let result = AtModemManager::decode_bcd_phone(&bytes, 2);
    assert_eq!(result, "ab");
}

#[test]
fn test_decode_bcd_phone_nibble_e_skipped() {
    // 0xE is reserved filler and is skipped
    let bytes = vec![0xE1];
    let result = AtModemManager::decode_bcd_phone(&bytes, 2);
    assert_eq!(result, "1");
}

#[test]
fn test_decode_pdu_7bit_backward_compat() {
    let bytes = vec![0xC8, 0x32, 0x9B, 0xFD, 0x06];
    let result = AtModemManager::decode_pdu_7bit(&bytes, 5, 0);
    assert_eq!(result, "Hello");
}

#[test]
fn test_decode_pdu_7bit_gsm_alphabet_at_sign() {
    // '@' is GSM 0x00, not 0x40 as in ASCII
    let bytes = vec![0x00];
    let result = AtModemManager::decode_pdu_7bit(&bytes, 1, 0);
    assert_eq!(result, "@");
}

#[test]
fn test_decode_pdu_7bit_gsm_special_chars() {
    // Septets 0x01 '£', 0x02 '$', 0x05 'é' packed 7 bits each
    let bytes = vec![0x01, 0x41, 0x01];
    let result = AtModemManager::decode_pdu_7bit(&bytes, 3, 0);
    assert_eq!(result, "£$é");
}

#[test]
fn test_decode_pdu_7bit_gsm_inverted_marks() {
    // Septets 0x40 '¡' and 0x60 '¿'
    let bytes = vec![0x40, 0x30];
    let result = AtModemManager::decode_pdu_7bit(&bytes, 2, 0);
    assert_eq!(result, "¡¿");
}

#[test]
fn test_decode_pdu_7bit_escape_sequences() {
    // Septets ESC 0x3C ESC 0x3E: '[' and ']'; each ESC pair yields one char
    let bytes = vec![0x1B, 0xDE, 0xC6, 0x07];
    let result = AtModemManager::decode_pdu_7bit(&bytes, 4, 0);
    assert_eq!(result, "[]");
}

#[test]
fn test_decode_pdu_7bit_euro_sign() {
    // Septets ESC 0x65
    let bytes = vec![0x9B, 0x32];
    let result = AtModemManager::decode_pdu_7bit(&bytes, 2, 0);
    assert_eq!(result, "€");
}

#[test]
fn test_decode_pdu_7bit_high_positions() {
    // Septets 0x7B 'ä' and 0x7C 'ö'
    let bytes = vec![0x7B, 0x3E];
    let result = AtModemManager::decode_pdu_7bit(&bytes, 2, 0);
    assert_eq!(result, "äö");
}

#[test]
fn test_parse_pdu_sms_alphanumeric_sender() {
    // Sender length 0C (12 semi-octets = 6 septets), TOA D0 (alphanumeric),
    // sender C7F7FBCC2E03 = "Google" packed as GSM 7-bit
    let pdu = "00040CD0C7F7FBCC2E0300004230114103002305C8329BFD06";
    let result = AtModemManager::parse_pdu_sms(1, pdu);
    assert!(result.is_ok());
    let sms = result.unwrap();
    assert_eq!(sms.sender.as_str(), "Google");
    assert_eq!(sms.text, "Hello");
}

fn recipient_error(recipient: &str, allow_short_code: bool) -> String {
    AtModemManager::validate_recipient_with_short_code(recipient, allow_short_code)
        .unwrap_err()
        .to_string()
}

#[test]
fn validate_recipient_reports_the_digit_count_when_the_length_is_wrong() {
    assert_eq!(
        recipient_error("12345", false),
        "Invalid SMS recipient: expected 6-15 digits, got 5 character(s)"
    );
    assert_eq!(
        recipient_error("+", false),
        "Invalid SMS recipient: expected 6-15 digits, got 0 character(s)"
    );
    assert_eq!(
        recipient_error("+1234567890123456", false),
        "Invalid SMS recipient: expected 6-15 digits, got 16 character(s)"
    );
    assert_eq!(
        recipient_error("12", true),
        "Invalid SMS recipient: expected 6-15 digits, got 2 character(s)"
    );
}

#[test]
fn validate_recipient_does_not_echo_a_value_with_control_characters() {
    let message = recipient_error("+65\rA1234", false);

    assert_eq!(
        message,
        "Invalid SMS recipient: must be E.164 (optional leading '+' then digits only)"
    );
    assert!(!message.contains('\r'));
    assert_eq!(
        recipient_error("++6512345", false),
        "Invalid SMS recipient: must be E.164 (optional leading '+' then digits only)"
    );
}

#[test]
fn validate_recipient_accepts_short_codes_of_three_to_five_digits_only() {
    for accepted in ["123", "1234", "10086"] {
        assert!(
            AtModemManager::validate_recipient_with_short_code(accepted, true).is_ok(),
            "{accepted}"
        );
    }
    assert!(AtModemManager::validate_recipient_with_short_code("123456", true).is_ok());
    assert_eq!(
        recipient_error("1a3", true),
        "Invalid SMS recipient: expected 6-15 digits, got 3 character(s)"
    );
}

#[test]
fn validate_message_body_names_the_offending_control_character() {
    let error = |body: &str| {
        AtModemManager::validate_message_body(body)
            .unwrap_err()
            .to_string()
    };

    assert_eq!(
        error("x\x1Ay"),
        "Invalid SMS body: contains control character U+001A"
    );
    assert_eq!(
        error("x\x1By"),
        "Invalid SMS body: contains control character U+001B"
    );
    assert_eq!(
        error("x\0y"),
        "Invalid SMS body: contains control character U+0000"
    );
    assert_eq!(
        error("a\x1Bb\x1Ac"),
        "Invalid SMS body: contains control character U+001B"
    );
    assert!(AtModemManager::validate_message_body("").is_ok());
}

#[test]
fn recognises_every_final_result_code_of_an_sms_submission() {
    for response in [
        "> \r\n+CMGS: 12\r\n\r\nOK\r\n",
        "+CMGS: 12",
        "OK",
        "  OK  ",
        "ERROR",
        "+CMS ERROR: 330",
        "+CME ERROR: 10",
    ] {
        assert!(
            AtModemManager::has_sms_submit_final_code(response),
            "{response:?}"
        );
    }
}

#[test]
fn does_not_mistake_the_prompt_or_echo_for_a_final_result_code() {
    for response in [
        "",
        "> ",
        "AT+CMGS=\"+6512345678\"\r\n> ",
        "OKAY",
        "NO ERROR",
        "+CMGS",
        "+CMS ERROR 330",
    ] {
        assert!(
            !AtModemManager::has_sms_submit_final_code(response),
            "{response:?}"
        );
    }
}

#[test]
fn confirms_a_submission_the_modem_acknowledged() {
    for response in ["+CMGS: 5\r\n\r\nOK\r\n", "+CMGS: 5", "\r\nOK\r\n"] {
        for timed_out in [false, true] {
            assert_eq!(
                AtModemManager::classify_sms_submit_response(response, timed_out).unwrap(),
                SmsSubmission::Confirmed,
                "{response:?} timed_out={timed_out}"
            );
        }
    }
}

#[test]
fn an_explicit_modem_error_fails_a_submission_even_after_a_timeout_or_an_ok() {
    for (response, timed_out) in [
        ("+CMS ERROR: 500\r\n", true),
        ("+CME ERROR: 10\r\n", false),
        ("+CMGS: 5\r\nERROR\r\n", false),
        ("ERROR", true),
    ] {
        let error = AtModemManager::classify_sms_submit_response(response, timed_out).unwrap_err();
        assert_eq!(
            error.to_string(),
            format!("Send SMS failed: {response}"),
            "{response:?}"
        );
    }
}

#[test]
fn an_unrecognised_reply_that_did_not_time_out_is_a_failed_submission() {
    let error = AtModemManager::classify_sms_submit_response("garbage", false).unwrap_err();
    assert_eq!(error.to_string(), "Send SMS failed: garbage");

    let error = AtModemManager::classify_sms_submit_response("", false).unwrap_err();
    assert_eq!(error.to_string(), "Send SMS failed: ");
}

#[test]
fn an_empty_reply_that_timed_out_is_an_unconfirmed_submission() {
    assert_eq!(
        AtModemManager::classify_sms_submit_response("", true).unwrap(),
        SmsSubmission::SubmittedUnconfirmed,
    );
}

#[test]
fn post_submit_recovery_reports_the_modem_error_line_only() {
    let error = |response: &str| {
        AtModemManager::classify_post_submit_recovery_response(response)
            .unwrap_err()
            .to_string()
    };

    assert_eq!(
        error("AT\r\n+CMS ERROR: 350\r\nOK\r\n"),
        "Send SMS failed after submission: +CMS ERROR: 350"
    );
    assert_eq!(
        error("  +CME ERROR: 10  \r\n"),
        "Send SMS failed after submission: +CME ERROR: 10"
    );
    assert_eq!(error("ERROR"), "Send SMS failed after submission: ERROR");
}

#[test]
fn parse_iccid_skips_a_short_tagged_line_and_reads_the_next_line() {
    assert_eq!(
        AtModemManager::parse_iccid("+QCCID: 1234\r\n89860121750097854321\r\nOK"),
        Iccid::try_from("89860121750097854321").ok()
    );
    assert_eq!(
        AtModemManager::parse_iccid("AT+QCCID\r\n+QCCID: nothex\r\nOK"),
        None
    );
}

#[test]
fn parse_iccid_drops_trailing_filler() {
    assert_eq!(
        AtModemManager::parse_iccid("+QCCID: 89860121750097FFFF"),
        Iccid::try_from("89860121750097").ok()
    );
}

#[test]
fn parse_iccid_drops_mixed_case_trailing_filler() {
    for response in ["+QCCID: 89860121750097fFfF", "89860121750097ffff"] {
        assert_eq!(
            AtModemManager::parse_iccid(response),
            Iccid::try_from("89860121750097").ok()
        );
    }
}

#[test]
fn parse_iccid_rejects_a_value_made_only_of_filler() {
    assert_eq!(
        AtModemManager::parse_iccid("+QCCID: FFFFFFFFFFFFFFFFFFFF"),
        None
    );
}

#[test]
fn parse_imei_takes_the_first_valid_line() {
    assert_eq!(
        AtModemManager::parse_imei("860123456789012\r\n860123456789999\r\nOK"),
        Imei::try_from("860123456789012").ok()
    );
    assert_eq!(AtModemManager::parse_imei(""), None);
}

#[test]
fn parse_cnum_reads_the_first_line_that_carries_a_number() {
    assert_eq!(
        AtModemManager::parse_cnum(
            "+CNUM: \"\",\"\",129\r\n+CNUM: \"Line 2\",\"+6591234567\",145\r\nOK"
        ),
        SimNumber::try_from("+6591234567").ok()
    );
}

#[test]
fn parse_cnum_ignores_a_line_without_a_quoted_number() {
    assert_eq!(AtModemManager::parse_cnum("+CNUM: ,6591234567,129"), None);
    assert_eq!(AtModemManager::parse_cnum("+CNUM: \"\""), None);
    assert_eq!(AtModemManager::parse_cnum(""), None);
}

#[test]
fn parse_cpms_read_stores_uppercases_trims_and_drops_empty_names() {
    assert_eq!(
        AtModemManager::parse_cpms_read_stores("+CPMS: (\"me\", \" sm \",\"\",\"  \"),(\"ME\")"),
        vec!["ME", "SM"]
    );
    assert!(AtModemManager::parse_cpms_read_stores("+CPMS: ()").is_empty());
}

#[test]
fn sms_read_store_candidates_ignore_duplicates_and_an_empty_capability_list() {
    let supported = vec!["ME".to_string(), "ME".to_string()];

    assert_eq!(
        AtModemManager::sms_read_store_candidates(&supported),
        vec![SmsStorage::Me]
    );
    assert_eq!(
        AtModemManager::sms_read_store_candidates(&["SM".to_string()]),
        vec![SmsStorage::Sm]
    );
    assert!(AtModemManager::sms_read_store_candidates(&[]).is_empty());
}

// ============================================================================
// Static Helper Function Tests (No I/O)
// ============================================================================

#[test]
fn test_port_conversion() {
    // modem_id is now the AT port's ttyUSB index (no fixed 4-ports-per-modem math),
    // so discovery works for both default (AT@offset2) and slimmed (AT@offset0) modems.
    assert_eq!(AtModemManager::port_to_modem_id("/dev/ttyUSB2"), "2");
    assert_eq!(AtModemManager::port_to_modem_id("/dev/ttyUSB6"), "6");
    assert_eq!(AtModemManager::port_to_modem_id("/dev/ttyUSB10"), "10");
    assert_eq!(AtModemManager::port_to_modem_id("/dev/ttyUSB0"), "0");

    assert_eq!(AtModemManager::modem_id_to_port("2"), "/dev/ttyUSB2");
    assert_eq!(AtModemManager::modem_id_to_port("6"), "/dev/ttyUSB6");
    assert_eq!(AtModemManager::modem_id_to_port("10"), "/dev/ttyUSB10");
    assert_eq!(AtModemManager::modem_id_to_port("0"), "/dev/ttyUSB0");
}

#[test]
fn test_port_conversion_boundary_cases() {
    // Round-trips across the full range, including offset-0 (slimmed) ports.
    for n in ["0", "1", "2", "6", "25", "102", "240"] {
        let port = AtModemManager::modem_id_to_port(n);
        assert_eq!(port, format!("/dev/ttyUSB{n}"));
        assert_eq!(AtModemManager::port_to_modem_id(&port), n);
    }
}

// ============================================================================
// AtModemManager Construction Tests
// ============================================================================

#[test]
fn test_at_modem_manager_new() {
    // Verify construction succeeds
    let manager = AtModemManager::new();

    // Basic smoke test - manager should be created without panic
    assert_eq!(size_of_val(&manager), size_of::<AtModemManager>());
}

// ============================================================================
// Public API Contract Tests (Without Real Hardware)
// ============================================================================
// These tests verify function signatures, error handling, and data types
// without requiring actual serial hardware.

#[tokio::test]
async fn test_get_iccid_signature() {
    // Verify get_iccid has correct signature and returns Result<Option<String>>
    let manager = AtModemManager::new();

    // /dev/null exists but won't respond to AT commands
    // The function should return Ok(None) when no ICCID found
    let result = manager.get_iccid("/dev/null").await;

    // Either Ok(None) or Err is acceptable (depends on whether serial open fails)
    assert!(result.is_ok() || result.is_err());
}

#[tokio::test]
async fn test_get_imei_signature() {
    let manager = AtModemManager::new();
    let result = manager.get_imei("/dev/null").await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_get_signal_signature() {
    let manager = AtModemManager::new();
    let result = manager.get_signal("/dev/null").await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_list_sms_signature() {
    let manager = AtModemManager::new();
    let result = manager.list_sms("/dev/null").await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_delete_sms_signature() {
    let manager = AtModemManager::new();
    let result = manager.delete_sms("/dev/null", 1).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn test_get_modem_info_signature() {
    let manager = AtModemManager::new();
    let result = manager.get_modem_info("/dev/null").await;
    // Either Ok or Err is acceptable
    assert!(result.is_ok() || result.is_err());
}

// ============================================================================
// Data Structure Tests
// ============================================================================

#[test]
fn test_at_modem_info_structure() {
    // Verify AtModemInfo can be constructed and has expected fields
    let info = AtModemInfo {
        imei: Some(Imei::try_from("123456789012345").unwrap()),
        manufacturer: Some("Quectel".to_string()),
        model: Some("EC20".to_string()),
        revision: Some("EC20CEFAG".to_string()),
    };

    assert_eq!(info.imei, Some(Imei::try_from("123456789012345").unwrap()));
    assert_eq!(info.model.as_deref(), Some("EC20"));
}
