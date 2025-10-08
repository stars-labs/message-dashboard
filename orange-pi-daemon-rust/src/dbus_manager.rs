use anyhow::{Context, Result};
use dbus::blocking::Connection;
use std::collections::HashMap;
use std::time::Duration;
use crate::types::SignalData;

/// High-performance D-Bus interface to ModemManager
/// This is significantly faster than spawning mmcli processes
pub struct DBusManager {
    conn: Connection,
}

impl DBusManager {
    pub fn new() -> Result<Self> {
        let conn = Connection::new_system()
            .context("Failed to connect to system D-Bus")?;
        
        Ok(Self { conn })
    }
    
    /// List all modems using D-Bus (much faster than mmcli -L)
    pub fn list_modems(&self) -> Result<Vec<String>> {
        let proxy = self.conn.with_proxy(
            "org.freedesktop.ModemManager1",
            "/org/freedesktop/ModemManager1", 
            Duration::from_secs(5)
        );
        
        // Call GetManagedObjects to list all modems
        let (objects,): (HashMap<dbus::Path, HashMap<String, HashMap<String, dbus::arg::Variant<Box<dyn dbus::arg::RefArg>>>>>,) = 
            proxy.method_call("org.freedesktop.DBus.ObjectManager", "GetManagedObjects", ())?;
        
        let mut modems = Vec::new();
        
        for (path, _interfaces) in objects {
            let path_str = path.as_str();
            if path_str.contains("/org/freedesktop/ModemManager1/Modem/") {
                // Extract modem ID from path
                if let Some(modem_id) = path_str.split('/').last() {
                    modems.push(modem_id.to_string());
                }
            }
        }
        
        Ok(modems)
    }
    
    /// Get modem properties using D-Bus
    pub fn get_modem_properties(&self, modem_id: &str) -> Result<HashMap<String, dbus::arg::Variant<Box<dyn dbus::arg::RefArg>>>> {
        let path = format!("/org/freedesktop/ModemManager1/Modem/{}", modem_id);
        let proxy = self.conn.with_proxy(
            "org.freedesktop.ModemManager1",
            path,
            Duration::from_secs(5)
        );
        
        let (properties,): (HashMap<String, dbus::arg::Variant<Box<dyn dbus::arg::RefArg>>>,) = 
            proxy.method_call("org.freedesktop.DBus.Properties", "GetAll", ("org.freedesktop.ModemManager1.Modem",))?;
        
        Ok(properties)
    }
    
    /// Get SIM ICCID using D-Bus
    pub fn get_sim_iccid(&self, modem_id: &str) -> Result<Option<String>> {
        let properties = self.get_modem_properties(modem_id)?;
        
        // Get SIM path from modem properties
        let sim_path = match properties.get("Sim") {
            Some(variant) => {
                if let Some(path) = variant.as_str() {
                    path
                } else {
                    return Ok(None);
                }
            }
            None => return Ok(None),
        };
        
        // Query SIM properties
        let proxy = self.conn.with_proxy(
            "org.freedesktop.ModemManager1",
            sim_path,
            Duration::from_secs(5)
        );
        
        let (sim_properties,): (HashMap<String, dbus::arg::Variant<Box<dyn dbus::arg::RefArg>>>,) = 
            proxy.method_call("org.freedesktop.DBus.Properties", "GetAll", ("org.freedesktop.ModemManager1.Sim",))?;
        
        // Extract ICCID
        let iccid = sim_properties.get("SimIdentifier")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        
        Ok(iccid)
    }
    
    /// Get signal quality using D-Bus
    pub fn get_signal_quality(&self, modem_id: &str) -> Result<SignalData> {
        let properties = self.get_modem_properties(modem_id)?;
        
        // Get signal quality from properties
        let quality = properties.get("SignalQuality")
            .and_then(|v| {
                // Signal quality is typically a struct (uint32, bool)
                if let Some((quality, _recent)) = v.as_static_inner(dbus::arg::PropMap::new()).ok()
                    .and_then(|map: HashMap<String, dbus::arg::Variant<Box<dyn dbus::arg::RefArg>>>>| {
                        let q = map.get("quality")?.as_u64()? as i32;
                        let r = map.get("recent")?.as_u64()? != 0;
                        Some((q, r))
                    }) {
                    Some(quality)
                } else {
                    // Try as a simple tuple
                    None
                }
            })
            .unwrap_or(0);
        
        Ok(SignalData {
            percent: quality,
            rssi: (quality * 120 / 100) - 110,
        })
    }
    
    /// Get device details (IMEI, manufacturer, model) using D-Bus
    pub fn get_device_details(&self, modem_id: &str) -> Result<(String, Option<String>, Option<String>, Option<String>, Option<String>)> {
        let properties = self.get_modem_properties(modem_id)?;
        
        let imei = properties.get("EquipmentIdentifier")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("MODEM_{}", modem_id));
        
        let manufacturer = properties.get("Manufacturer")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        
        let model = properties.get("Model")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        
        let firmware = properties.get("Revision")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        
        let hardware = properties.get("HardwareRevision")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        
        Ok((imei, manufacturer, model, firmware, hardware))
    }
    
    /// Get operator name using D-Bus
    pub fn get_operator_name(&self, modem_id: &str) -> Result<Option<String>> {
        let path = format!("/org/freedesktop/ModemManager1/Modem/{}", modem_id);
        let proxy = self.conn.with_proxy(
            "org.freedesktop.ModemManager1",
            path,
            Duration::from_secs(5)
        );
        
        // Get 3GPP properties for operator name
        let result: Result<(HashMap<String, dbus::arg::Variant<Box<dyn dbus::arg::RefArg>>>,), dbus::Error> = 
            proxy.method_call("org.freedesktop.DBus.Properties", "GetAll", ("org.freedesktop.ModemManager1.Modem.Modem3gpp",));
        
        match result {
            Ok((properties,)) => {
                let operator = properties.get("OperatorName")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .filter(|s| !s.is_empty());
                
                Ok(operator)
            }
            Err(_) => Ok(None), // 3GPP interface might not be available
        }
    }
    
    /// Get phone number using D-Bus
    pub fn get_phone_number(&self, modem_id: &str) -> Result<Option<String>> {
        let properties = self.get_modem_properties(modem_id)?;
        
        // Try to get phone number from modem properties
        let number = properties.get("OwnNumbers")
            .and_then(|v| {
                // OwnNumbers is typically an array of strings
                if let Ok(numbers) = v.as_static_inner(dbus::arg::PropMap::new()) {
                    let numbers: Vec<String> = numbers;
                    numbers.first().cloned()
                } else {
                    None
                }
            })
            .filter(|s| !s.is_empty() && s != "unknown");
        
        Ok(number)
    }
}

impl Clone for DBusManager {
    fn clone(&self) -> Self {
        // D-Bus connections can't be cloned, so create a new one
        Self::new().expect("Failed to create new D-Bus connection")
    }
}