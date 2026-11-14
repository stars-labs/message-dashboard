use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, ValueRef};
use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("invalid {kind}: {value:?}")]
pub struct InvalidIdentifier {
    pub kind: &'static str,
    pub value: String,
}

macro_rules! identifier {
    ($(#[$meta:meta])* $name:ident, $kind:literal, $is_valid:path) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);

        impl $name {
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl TryFrom<String> for $name {
            type Error = InvalidIdentifier;

            fn try_from(value: String) -> Result<Self, Self::Error> {
                if $is_valid(&value) {
                    Ok(Self(value))
                } else {
                    Err(InvalidIdentifier { kind: $kind, value })
                }
            }
        }

        impl TryFrom<&str> for $name {
            type Error = InvalidIdentifier;

            fn try_from(value: &str) -> Result<Self, Self::Error> {
                Self::try_from(value.to_owned())
            }
        }

        impl std::str::FromStr for $name {
            type Err = InvalidIdentifier;

            fn from_str(text: &str) -> Result<Self, Self::Err> {
                Self::try_from(text)
            }
        }

        impl From<$name> for String {
            fn from(value: $name) -> Self {
                value.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl ToSql for $name {
            fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
                Ok(self.as_str().into())
            }
        }

        impl FromSql for $name {
            fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
                Self::try_from(value.as_str()?)
                    .map_err(|error| FromSqlError::Other(error.into()))
            }
        }
    };
}

fn is_iccid(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_imei(text: &str) -> bool {
    text.len() == 15 && text.bytes().all(|byte| byte.is_ascii_digit())
}

fn is_e164(text: &str) -> bool {
    let Some(digits) = text.strip_prefix('+') else {
        return false;
    };
    (7..=15).contains(&digits.len())
        && !digits.starts_with('0')
        && digits.bytes().all(|byte| byte.is_ascii_digit())
}

fn is_non_empty(text: &str) -> bool {
    !text.is_empty()
}

identifier! {
    /// A SIM's ICCID: one or more hex digits. Real ICCIDs carry hex letters
    /// (`898600520121F0517883`); the modem's trailing `F` padding is stripped
    /// before one is built. Length is checked where an ICCID is read (the AT
    /// reply needs 18 or more, the voice path allows at most 22), not here.
    Iccid, "ICCID", is_iccid
}

identifier! {
    /// A modem's IMEI: exactly 15 ASCII digits, as `AT+CGSN` returns it. No
    /// Luhn check.
    Imei, "IMEI", is_imei
}

identifier! {
    /// A number the daemon dials: `+`, then 7 to 15 digits, the first not `0`.
    PhoneNumber, "E.164 phone number", is_e164
}

identifier! {
    /// The SIM's own number as `AT+CNUM` or `ModemManager` reports it: any
    /// non-empty text. It is not necessarily E.164 (`6591234567` occurs).
    SimNumber, "SIM number", is_non_empty
}

/// The address of an SMS: a sender or a recipient. Any text, including an
/// empty one: a short code (`10086`), an E.164 number, or an alphanumeric
/// sender ID (`Singtel`, `DBS`), possibly decoded from UCS2. It is a type of
/// its own so an address cannot be passed where an ICCID or a SIM number is
/// expected; it validates nothing.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(from = "String", into = "String")]
pub struct SmsAddress(String);

impl SmsAddress {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<String> for SmsAddress {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for SmsAddress {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

impl From<SmsAddress> for String {
    fn from(value: SmsAddress) -> Self {
        value.0
    }
}

impl fmt::Display for SmsAddress {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl ToSql for SmsAddress {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(self.as_str().into())
    }
}

impl FromSql for SmsAddress {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        value.as_str().map(Self::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use serde_json::json;

    fn accepts<T>(inputs: &[&str])
    where
        T: for<'a> TryFrom<&'a str, Error = InvalidIdentifier> + Into<String>,
    {
        for input in inputs {
            let value = T::try_from(*input).unwrap();
            assert_eq!(value.into(), *input);
        }
    }

    fn rejects<T>(inputs: &[&str])
    where
        T: for<'a> TryFrom<&'a str, Error = InvalidIdentifier> + std::fmt::Debug,
    {
        for input in inputs {
            assert!(T::try_from(*input).is_err(), "{input:?} must be rejected");
        }
    }

    #[test]
    fn iccid_accepts_real_forms() {
        accepts::<Iccid>(&[
            "89860121750097854321",
            "898600520121F0517883",
            "896501230605CF73985",
            "8986012175009785432",
            "89860121750097854a",
            "A",
        ]);
    }

    #[test]
    fn iccid_rejects_what_is_not_hex() {
        rejects::<Iccid>(&[
            "",
            " ",
            "8986 0121",
            "89860121750097854321\n",
            "iccid_001",
            "iccid-1",
            "test",
            "8986012175009785432G",
            "８９８６",
        ]);
    }

    #[test]
    fn imei_is_fifteen_digits_without_a_luhn_check() {
        accepts::<Imei>(&["123456789012345", "000000000000000", "860123456789012"]);
        rejects::<Imei>(&[
            "",
            "12345678901234",
            "1234567890123456",
            "12345678901234a",
            "IMEI123456789",
            " 123456789012345",
            "１２３４５６７８９０１２３４５",
        ]);
    }

    #[test]
    fn phone_number_is_e164() {
        accepts::<PhoneNumber>(&["+6591234567", "+1234567", "+123456789012345"]);
        rejects::<PhoneNumber>(&[
            "",
            "+",
            "6591234567",
            "+0591234567",
            "+123456",
            "+1234567890123456",
            "+65 91234567",
            "+65abc4567",
            "10086",
            "Singtel",
        ]);
    }

    #[test]
    fn sim_number_is_any_non_empty_text() {
        accepts::<SimNumber>(&["+6591234567", "6591234567", "+1234567890", "x"]);
        rejects::<SimNumber>(&[""]);
    }

    #[test]
    fn sms_address_accepts_every_sender_and_recipient() {
        for input in [
            "10086",
            "+6591234567",
            "Singtel",
            "DBS",
            "你好",
            "10010",
            "+1234567890",
            "test",
            "",
        ] {
            assert_eq!(SmsAddress::from(input).as_str(), input);
            assert_eq!(String::from(SmsAddress::from(input.to_owned())), input);
        }
    }

    #[test]
    fn rejection_names_the_kind_and_keeps_the_input() {
        let error = Iccid::try_from("nope").unwrap_err();
        assert_eq!(error.kind, "ICCID");
        assert_eq!(error.value, "nope");
        assert_eq!(error.to_string(), "invalid ICCID: \"nope\"");
    }

    #[test]
    fn wire_form_is_the_plain_string() {
        let iccid = Iccid::try_from("898600520121F0517883").unwrap();
        assert_eq!(
            serde_json::to_value(&iccid).unwrap(),
            json!("898600520121F0517883")
        );
        assert_eq!(
            serde_json::from_value::<Iccid>(json!("898600520121F0517883")).unwrap(),
            iccid
        );
        assert!(serde_json::from_value::<Iccid>(json!("iccid_001")).is_err());
        assert!(serde_json::from_value::<Iccid>(json!(12345)).is_err());
        assert!(serde_json::from_value::<Iccid>(json!(null)).is_err());

        let address = SmsAddress::from("Singtel");
        assert_eq!(serde_json::to_value(&address).unwrap(), json!("Singtel"));
        assert_eq!(
            serde_json::from_value::<SmsAddress>(json!(""))
                .unwrap()
                .as_str(),
            ""
        );
        assert_eq!(
            serde_json::to_string(&Imei::try_from("123456789012345").unwrap()).unwrap(),
            "\"123456789012345\""
        );
    }

    #[test]
    fn sqlite_form_is_the_plain_text() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute("CREATE TABLE t (v TEXT NOT NULL)", [])
            .unwrap();
        let iccid = Iccid::try_from("898600520121F0517883").unwrap();
        conn.execute("INSERT INTO t VALUES (?1)", [&iccid]).unwrap();
        let text: String = conn
            .query_row("SELECT v FROM t", [], |row| row.get(0))
            .unwrap();
        assert_eq!(text, "898600520121F0517883");
        let read: Iccid = conn
            .query_row("SELECT v FROM t", [], |row| row.get(0))
            .unwrap();
        assert_eq!(read, iccid);

        conn.execute("DELETE FROM t", []).unwrap();
        conn.execute("INSERT INTO t VALUES ('iccid_001')", [])
            .unwrap();
        assert!(conn
            .query_row("SELECT v FROM t", [], |row| row.get::<_, Iccid>(0))
            .is_err());
        let address: SmsAddress = conn
            .query_row("SELECT v FROM t", [], |row| row.get(0))
            .unwrap();
        assert_eq!(address.as_str(), "iccid_001");
    }

    #[test]
    fn display_and_parse_round_trip() {
        let imei: Imei = "123456789012345".parse().unwrap();
        assert_eq!(imei.to_string(), "123456789012345");
        assert_eq!(String::from(imei), "123456789012345");
        assert!("abc".parse::<Imei>().is_err());
    }
}
