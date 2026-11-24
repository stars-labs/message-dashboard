use crate::identifiers::{Iccid, Imei, SimNumber, SmsAddress};
use crate::types::ModemState;
use anyhow::{anyhow, Context, Result};
use std::collections::HashMap;
use tracing::{debug, info, warn};
use zbus::{proxy, Connection};

pub struct NativeDBusClient {
    connection: Option<Connection>,
}

type ManagedObjects = HashMap<
    zbus::zvariant::OwnedObjectPath,
    HashMap<String, HashMap<String, zbus::zvariant::OwnedValue>>,
>;

#[proxy(
    interface = "org.freedesktop.ModemManager1",
    default_service = "org.freedesktop.ModemManager1",
    default_path = "/org/freedesktop/ModemManager1"
)]
trait ModemManager1 {
    #[zbus(property)]
    fn version(&self) -> zbus::Result<String>;
}

#[proxy(
    interface = "org.freedesktop.DBus.ObjectManager",
    default_service = "org.freedesktop.ModemManager1",
    default_path = "/org/freedesktop/ModemManager1"
)]
trait ObjectManager {
    fn get_managed_objects(&self) -> zbus::Result<ManagedObjects>;
}

#[proxy(
    interface = "org.freedesktop.ModemManager1.Modem",
    default_service = "org.freedesktop.ModemManager1"
)]
trait Modem {
    #[zbus(property)]
    fn state(&self) -> zbus::Result<i32>;

    #[zbus(property)]
    fn equipment_identifier(&self) -> zbus::Result<String>;

    #[zbus(property)]
    fn manufacturer(&self) -> zbus::Result<String>;

    #[zbus(property)]
    fn model(&self) -> zbus::Result<String>;

    #[zbus(property)]
    fn revision(&self) -> zbus::Result<String>;

    #[zbus(property)]
    fn hardware_revision(&self) -> zbus::Result<String>;

    #[zbus(property)]
    fn sim(&self) -> zbus::Result<zbus::zvariant::OwnedObjectPath>;

    fn get_signal_quality(&self) -> zbus::Result<(u32, bool)>;
}

#[proxy(
    interface = "org.freedesktop.ModemManager1.Modem.Simple",
    default_service = "org.freedesktop.ModemManager1"
)]
trait ModemSimple {
    fn get_status(&self) -> zbus::Result<HashMap<String, zbus::zvariant::OwnedValue>>;
}

#[proxy(
    interface = "org.freedesktop.ModemManager1.Sim",
    default_service = "org.freedesktop.ModemManager1"
)]
trait Sim {
    #[zbus(property)]
    fn sim_identifier(&self) -> zbus::Result<String>;

    #[zbus(property)]
    fn operator_identifier(&self) -> zbus::Result<String>;

    #[zbus(property)]
    fn operator_name(&self) -> zbus::Result<String>;
}

#[proxy(
    interface = "org.freedesktop.ModemManager1.Modem.Messaging",
    default_service = "org.freedesktop.ModemManager1"
)]
trait Messaging {
    fn list(&self) -> zbus::Result<Vec<zbus::zvariant::OwnedObjectPath>>;
    fn delete(&self, path: &zbus::zvariant::ObjectPath<'_>) -> zbus::Result<()>;
    fn create(
        &self,
        properties: HashMap<String, zbus::zvariant::Value<'_>>,
    ) -> zbus::Result<zbus::zvariant::OwnedObjectPath>;
}

#[proxy(
    interface = "org.freedesktop.ModemManager1.Sms",
    default_service = "org.freedesktop.ModemManager1"
)]
trait Sms {
    #[zbus(property)]
    fn text(&self) -> zbus::Result<String>;

    #[zbus(property)]
    fn number(&self) -> zbus::Result<String>;

    #[zbus(property)]
    fn timestamp(&self) -> zbus::Result<String>;

    #[zbus(property)]
    fn state(&self) -> zbus::Result<u32>;

    fn send(&self) -> zbus::Result<()>;
}

impl NativeDBusClient {
    pub async fn new() -> Self {
        const MAX_ATTEMPTS: u32 = 3;
        let mut attempts = 0;

        while attempts < MAX_ATTEMPTS {
            attempts += 1;

            match Connection::system().await {
                Ok(conn) => {
                    info!(
                        "🚀 Native D-Bus client initialized successfully (attempt {})",
                        attempts
                    );
                    info!("✨ Using native D-Bus for zero subprocess overhead");
                    return Self {
                        connection: Some(conn),
                    };
                }
                Err(e) => {
                    if attempts < MAX_ATTEMPTS {
                        warn!(
                            "⚠️  D-Bus connection attempt {} failed: {}, retrying...",
                            attempts, e
                        );
                        tokio::time::sleep(std::time::Duration::from_millis(
                            100 * u64::from(attempts),
                        ))
                        .await;
                    } else {
                        warn!(
                            "⚠️  Failed to connect to D-Bus after {} attempts: {}",
                            MAX_ATTEMPTS, e
                        );
                        warn!("   Performance will be degraded - falling back to busctl");
                    }
                }
            }
        }

        Self { connection: None }
    }

    pub fn is_available(&self) -> bool {
        self.connection.is_some()
    }

    pub async fn list_modems(&self) -> Result<Vec<String>> {
        let conn = self
            .connection
            .as_ref()
            .ok_or_else(|| anyhow!("D-Bus connection not available"))?;

        debug!("🔍 Listing modems via native D-Bus");

        let proxy = ObjectManagerProxy::new(conn)
            .await
            .context("Failed to create ObjectManager proxy")?;

        let objects = proxy
            .get_managed_objects()
            .await
            .context("Failed to get managed objects")?;

        let mut modem_ids = Vec::new();
        for (path, _interfaces) in objects {
            let path_str = path.as_str();
            if path_str.starts_with("/org/freedesktop/ModemManager1/Modem/") {
                if let Some(id) = path_str.strip_prefix("/org/freedesktop/ModemManager1/Modem/") {
                    modem_ids.push(id.to_string());
                }
            }
        }

        debug!("📱 Found {} modems via native D-Bus", modem_ids.len());
        Ok(modem_ids)
    }

    pub async fn get_modem_state(&self, modem_id: &str) -> Result<ModemState> {
        let conn = self
            .connection
            .as_ref()
            .ok_or_else(|| anyhow!("D-Bus connection not available"))?;

        let path = format!("/org/freedesktop/ModemManager1/Modem/{modem_id}");
        let proxy = ModemProxy::builder(conn)
            .path(zbus::zvariant::ObjectPath::try_from(path.as_str()).context("Invalid path")?)?
            .build()
            .await
            .context("Failed to create Modem proxy")?;

        let state_code = proxy.state().await.context("Failed to get modem state")?;

        Ok(ModemState::from_code(state_code))
    }

    pub async fn get_sim_iccid(&self, modem_id: &str) -> Result<Option<Iccid>> {
        let conn = self
            .connection
            .as_ref()
            .ok_or_else(|| anyhow!("D-Bus connection not available"))?;

        let modem_path = format!("/org/freedesktop/ModemManager1/Modem/{modem_id}");
        let modem_path = zbus::zvariant::ObjectPath::try_from(modem_path.as_str())
            .context("Invalid object path")?;
        let modem_proxy = ModemProxy::builder(conn)
            .path(modem_path)?
            .build()
            .await
            .context("Failed to create Modem proxy")?;

        let Ok(sim_path) = modem_proxy.sim().await else {
            return Ok(None);
        };

        if sim_path.as_str() == "/" || sim_path.as_str().is_empty() {
            return Ok(None);
        }

        let sim_proxy = SimProxy::builder(conn)
            .path(&sim_path)?
            .build()
            .await
            .context("Failed to create SIM proxy")?;

        match sim_proxy.sim_identifier().await {
            Ok(iccid) if !iccid.is_empty() => {
                // Strip trailing 'F' BCD padding (ITU-T E.118)
                Ok(Some(Iccid::try_from(iccid.trim_end_matches('F'))?))
            }
            _ => Ok(None),
        }
    }

    pub async fn get_signal_quality(&self, modem_id: &str) -> Result<(u32, bool)> {
        let conn = self
            .connection
            .as_ref()
            .ok_or_else(|| anyhow!("D-Bus connection not available"))?;

        let path = format!("/org/freedesktop/ModemManager1/Modem/{modem_id}");
        let proxy = ModemProxy::builder(conn)
            .path(zbus::zvariant::ObjectPath::try_from(path.as_str()).context("Invalid path")?)?
            .build()
            .await
            .context("Failed to create Modem proxy")?;

        proxy
            .get_signal_quality()
            .await
            .context("Failed to get signal quality")
    }

    pub async fn get_device_details(&self, modem_id: &str) -> Result<DeviceDetails> {
        let conn = self
            .connection
            .as_ref()
            .ok_or_else(|| anyhow!("D-Bus connection not available"))?;

        let path = format!("/org/freedesktop/ModemManager1/Modem/{modem_id}");
        let proxy = ModemProxy::builder(conn)
            .path(zbus::zvariant::ObjectPath::try_from(path.as_str()).context("Invalid path")?)?
            .build()
            .await
            .context("Failed to create Modem proxy")?;

        let imei = Imei::try_from(proxy.equipment_identifier().await.unwrap_or_default()).ok();
        let manufacturer = proxy.manufacturer().await.ok();
        let model = proxy.model().await.ok();
        let firmware = proxy.revision().await.ok();
        let hardware = proxy.hardware_revision().await.ok();

        Ok(DeviceDetails {
            imei,
            manufacturer,
            model,
            firmware_version: firmware,
            hardware_revision: hardware,
        })
    }

    pub async fn get_phone_number(&self, modem_id: &str) -> Result<Option<SimNumber>> {
        let conn = self
            .connection
            .as_ref()
            .ok_or_else(|| anyhow!("D-Bus connection not available"))?;

        let path = format!("/org/freedesktop/ModemManager1/Modem/{modem_id}");
        let proxy = ModemSimpleProxy::builder(conn)
            .path(zbus::zvariant::ObjectPath::try_from(path.as_str()).context("Invalid path")?)?
            .build()
            .await
            .context("Failed to create ModemSimple proxy")?;

        let status = proxy
            .get_status()
            .await
            .context("Failed to get modem status")?;

        for key in &["m3gpp-subscription-state", "cdma-mdn", "own-numbers"] {
            if let Some(value) = status.get(*key) {
                if let Ok(number) = value.downcast_ref::<String>() {
                    if let Ok(number) = SimNumber::try_from(number) {
                        return Ok(Some(number));
                    }
                }
            }
        }

        Ok(None)
    }

    pub async fn list_sms(&self, modem_id: &str) -> Result<Vec<SmsMessage>> {
        let conn = self
            .connection
            .as_ref()
            .ok_or_else(|| anyhow!("D-Bus connection not available"))?;

        let path = format!("/org/freedesktop/ModemManager1/Modem/{modem_id}");
        let proxy = MessagingProxy::builder(conn)
            .path(zbus::zvariant::ObjectPath::try_from(path.as_str()).context("Invalid path")?)?
            .build()
            .await
            .context("Failed to create Messaging proxy")?;

        let sms_paths = proxy.list().await.context("Failed to list SMS messages")?;

        let mut messages = Vec::new();
        for sms_path in sms_paths {
            let sms_proxy = SmsProxy::builder(conn).path(&sms_path)?.build().await?;

            let state = sms_proxy.state().await.unwrap_or(0);
            // MM_SMS_STATE_RECEIVED
            if state == 3 {
                messages.push(SmsMessage {
                    path: sms_path.to_string(),
                    text: sms_proxy.text().await.unwrap_or_default(),
                    number: SmsAddress::from(sms_proxy.number().await.unwrap_or_default()),
                    timestamp: sms_proxy.timestamp().await.unwrap_or_default(),
                });
            }
        }

        Ok(messages)
    }

    pub async fn delete_sms(&self, modem_id: &str, sms_path: &str) -> Result<()> {
        let conn = self
            .connection
            .as_ref()
            .ok_or_else(|| anyhow!("D-Bus connection not available"))?;

        let modem_path = format!("/org/freedesktop/ModemManager1/Modem/{modem_id}");
        let modem_path = zbus::zvariant::ObjectPath::try_from(modem_path.as_str())
            .context("Invalid object path")?;
        let proxy = MessagingProxy::builder(conn)
            .path(modem_path)?
            .build()
            .await
            .context("Failed to create Messaging proxy")?;

        let sms_obj_path =
            zbus::zvariant::ObjectPath::try_from(sms_path).context("Invalid SMS path")?;

        proxy
            .delete(&sms_obj_path)
            .await
            .context("Failed to delete SMS message")
    }

    pub async fn send_sms(&self, modem_id: &str, recipient: &SmsAddress, text: &str) -> Result<()> {
        let conn = self
            .connection
            .as_ref()
            .ok_or_else(|| anyhow!("D-Bus connection not available"))?;

        let modem_path = format!("/org/freedesktop/ModemManager1/Modem/{modem_id}");
        let modem_path = zbus::zvariant::ObjectPath::try_from(modem_path.as_str())
            .context("Invalid object path")?;
        let proxy = MessagingProxy::builder(conn)
            .path(modem_path)?
            .build()
            .await
            .context("Failed to create Messaging proxy")?;

        let mut props = std::collections::HashMap::new();
        props.insert("number".to_string(), recipient.as_str().into());
        props.insert("text".to_string(), text.to_string().into());

        let sms_path = proxy
            .create(props)
            .await
            .context("Failed to create SMS message")?;

        let sms_proxy = SmsProxy::builder(conn)
            .path(sms_path.clone())?
            .build()
            .await
            .context("Failed to create SMS proxy")?;

        sms_proxy.send().await.context("Failed to send SMS")?;

        debug!("✅ SMS sent successfully via D-Bus");
        Ok(())
    }
}

pub struct DeviceDetails {
    pub imei: Option<Imei>,
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    pub firmware_version: Option<String>,
    pub hardware_revision: Option<String>,
}

pub struct SmsMessage {
    pub path: String,
    pub text: String,
    pub number: SmsAddress,
    pub timestamp: String,
}
