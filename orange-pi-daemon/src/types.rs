use crate::identifiers::{Iccid, SmsAddress};
use crate::wire::Direction;
use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, ValueRef};
use serde::{Deserialize, Serialize};
use std::fmt;

/// A submitted SMS; submission failures are returned through `Result::Err`, so
/// there is no failed variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SmsSubmission {
    Confirmed,
    SubmittedUnconfirmed,
}

/// The CPMS mem1 storage an SMS is read from or deleted in. Parsing ignores
/// ASCII case; the canonical text is upper case.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SmsStorage {
    Me,
    Sm,
    Mt,
}

impl SmsStorage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Me => "ME",
            Self::Sm => "SM",
            Self::Mt => "MT",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("unknown SMS storage: {0}")]
pub struct UnknownSmsStorage(pub String);

impl std::str::FromStr for SmsStorage {
    type Err = UnknownSmsStorage;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        match text.to_ascii_uppercase().as_str() {
            "ME" => Ok(Self::Me),
            "SM" => Ok(Self::Sm),
            "MT" => Ok(Self::Mt),
            _ => Err(UnknownSmsStorage(text.to_string())),
        }
    }
}

impl fmt::Display for SmsStorage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl ToSql for SmsStorage {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(self.as_str().into())
    }
}

impl FromSql for SmsStorage {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        value
            .as_str()?
            .parse()
            .map_err(|error: UnknownSmsStorage| FromSqlError::Other(error.into()))
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub api_url: String,
    pub api_key: ApiKey,
}

/// The daemon's credential for the Worker; `Debug` never shows it.
#[derive(Clone, PartialEq, Eq)]
pub struct ApiKey(String);

impl ApiKey {
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl From<String> for ApiKey {
    fn from(key: String) -> Self {
        Self(key)
    }
}

impl From<&str> for ApiKey {
    fn from(key: &str) -> Self {
        Self(key.to_string())
    }
}

impl fmt::Debug for ApiKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ApiKey(<redacted>)")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub phone_iccid: Iccid,
    pub phone_number: SmsAddress,
    pub content: String,
    pub timestamp: String,
    pub direction: Direction,
}

#[derive(Debug, Clone)]
pub struct MessageWithPath {
    pub message: Message,
    pub modem_id: String,
    pub sms_path: String,
}

#[derive(Debug, Clone)]
pub struct SignalData {
    pub percent: i32,
    pub rssi: i32,
}

impl Default for SignalData {
    fn default() -> Self {
        Self {
            percent: 0,
            rssi: -110,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::ModemStatus;
    use rusqlite::Connection;
    use serde_json::json;

    fn wire<T: Serialize>(value: &T) -> serde_json::Value {
        serde_json::to_value(value).unwrap()
    }

    #[test]
    fn sms_storage_text_is_unchanged() {
        for (storage, text) in [
            (SmsStorage::Me, "ME"),
            (SmsStorage::Sm, "SM"),
            (SmsStorage::Mt, "MT"),
        ] {
            assert_eq!(storage.as_str(), text);
            assert_eq!(storage.to_string(), text);
            assert_eq!(text.parse::<SmsStorage>().unwrap(), storage);
            assert_eq!(
                text.to_ascii_lowercase().parse::<SmsStorage>().unwrap(),
                storage
            );
        }
        for text in ["", "SR", "BM", "M E", "ME ", "MÉ"] {
            assert_eq!(
                text.parse::<SmsStorage>(),
                Err(UnknownSmsStorage(text.to_string()))
            );
        }
    }

    #[test]
    fn sms_storage_is_stored_as_the_same_text() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute("CREATE TABLE t (storage TEXT NOT NULL)", [])
            .unwrap();
        for storage in [SmsStorage::Me, SmsStorage::Sm, SmsStorage::Mt] {
            conn.execute("DELETE FROM t", []).unwrap();
            conn.execute("INSERT INTO t VALUES (?1)", [&storage])
                .unwrap();
            let text: String = conn
                .query_row("SELECT storage FROM t", [], |row| row.get(0))
                .unwrap();
            assert_eq!(text, storage.as_str());
            let read: SmsStorage = conn
                .query_row("SELECT storage FROM t", [], |row| row.get(0))
                .unwrap();
            assert_eq!(read, storage);
        }
        conn.execute("DELETE FROM t", []).unwrap();
        conn.execute("INSERT INTO t VALUES ('sm')", []).unwrap();
        let read: SmsStorage = conn
            .query_row("SELECT storage FROM t", [], |row| row.get(0))
            .unwrap();
        assert_eq!(read, SmsStorage::Sm);
        conn.execute("DELETE FROM t", []).unwrap();
        conn.execute("INSERT INTO t VALUES ('SR')", []).unwrap();
        assert!(conn
            .query_row("SELECT storage FROM t", [], |row| row
                .get::<_, SmsStorage>(0))
            .is_err());
    }

    #[test]
    fn closed_status_enums_keep_their_wire_strings() {
        for (status, text) in [
            (ModemStatus::Active, "active"),
            (ModemStatus::Connected, "connected"),
            (ModemStatus::Disconnected, "disconnected"),
        ] {
            assert_eq!(wire(&status), json!(text));
            assert_eq!(
                serde_json::from_value::<ModemStatus>(json!(text)).unwrap(),
                status
            );
        }
        assert!(serde_json::from_value::<ModemStatus>(json!("error")).is_err());
    }
}
