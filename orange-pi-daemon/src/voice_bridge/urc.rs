use super::serial::{async_file, read_some};
use super::VoiceBridge;
use crate::at_modem::AtModemManager;
use crate::identifiers::Iccid;
use crate::urc_reader::{parse_urc_line, UrcEvent};
use crate::voice_call::{RingReport, RingTracker};
use crate::wire::CallEndReason;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tracing::{debug, info, warn};

impl VoiceBridge {
    /// `+QPCMV: 0` / `+QPCMV: 1` from the modem carrying the active call.
    async fn on_pcm_ready(&self, modem_id: &str, ready: bool) {
        let state = self.state.lock().await;
        if let Some(active) = state.active.as_ref().filter(|a| a.modem_id == modem_id) {
            let _ = active.pcm_ready.send(ready);
        }
    }

    /// Fast path for a far-end hangup seen on the URC port.
    async fn on_no_carrier(&self, modem_id: &str) {
        let call_id = {
            let state = self.state.lock().await;
            state
                .active
                .as_ref()
                .filter(|a| a.modem_id == modem_id)
                .map(|a| a.handles.call_id.clone())
        };
        if let Some(call_id) = call_id {
            self.end_call(&call_id, CallEndReason::RemoteHangup).await;
        }
    }

    /// Keep one URC reader per voice-capable modem with a known SIM.
    pub async fn run_urc_readers(self: Arc<Self>) {
        let mut readers: HashMap<String, (Iccid, tokio::task::JoinHandle<()>)> = HashMap::new();
        info!("📞 URC reader supervisor started");
        loop {
            let snapshot: Vec<(String, Iccid)> = self
                .devices
                .read()
                .await
                .iter()
                .filter_map(|(id, r)| r.detected_iccid.clone().map(|iccid| (id.clone(), iccid)))
                .collect();

            match AtModemManager::ttyusb_by_usb_device() {
                Ok(groups) => {
                    let mut wanted = HashMap::new();
                    for (modem_id, iccid) in snapshot {
                        let at_port = self.modems.get_port(&modem_id).await;
                        if let Some(ports) = AtModemManager::pick_voice_ports(&groups, &at_port) {
                            wanted.insert(ports.modem, (modem_id, iccid));
                        }
                    }

                    readers.retain(|port, (iccid, handle)| {
                        let keep = !handle.is_finished()
                            && wanted.get(port).is_some_and(|(_, want)| want == iccid);
                        if !keep {
                            handle.abort();
                        }
                        keep
                    });
                    for (port, (modem_id, iccid)) in wanted {
                        if readers.contains_key(&port) {
                            continue;
                        }
                        let handle = tokio::spawn(self.clone().read_urcs(
                            modem_id,
                            iccid.clone(),
                            port.clone(),
                        ));
                        readers.insert(port, (iccid, handle));
                    }
                    debug!("📞 {} URC readers running", readers.len());
                }
                Err(e) => warn!("📞 Cannot enumerate ttyUSB ports: {}", e),
            }

            tokio::time::sleep(Duration::from_secs(30)).await;
        }
    }

    async fn read_urcs(self: Arc<Self>, modem_id: String, iccid: Iccid, port: String) {
        let fd = match AtModemManager::open_serial(&port).and_then(|f| Ok(async_file(f)?)) {
            Ok(fd) => fd,
            Err(e) => {
                debug!(modem_id = %modem_id, "📞 Cannot open URC port {}: {}", port, e);
                return;
            }
        };
        let mut tracker = RingTracker::default();
        let mut line = Vec::new();
        let mut buf = [0u8; 512];
        loop {
            let n = match read_some(&fd, &mut buf).await {
                Ok(n) => n,
                Err(e) => {
                    debug!(modem_id = %modem_id, "📞 URC port {} closed: {}", port, e);
                    return;
                }
            };
            let Some(chunk) = buf.get(..n) else {
                warn!(modem_id = %modem_id, "📞 URC port {} read {} bytes into a {}-byte buffer", port, n, buf.len());
                return;
            };
            for &byte in chunk {
                if byte != b'\n' && byte != b'\r' {
                    line.push(byte);
                    continue;
                }
                let text = String::from_utf8_lossy(&line).into_owned();
                line.clear();
                let Some(event) = parse_urc_line(&text) else {
                    continue;
                };
                match event {
                    UrcEvent::NoCarrier => self.on_no_carrier(&modem_id).await,
                    UrcEvent::PcmReady(ready) => self.on_pcm_ready(&modem_id, ready).await,
                    _ => {}
                }
                match tracker.on_event(&event, Instant::now()) {
                    Some(RingReport::Ringing(from)) => {
                        info!(modem_id = %modem_id, iccid = %iccid, "📞 Incoming call");
                        let api = self.api.clone();
                        let iccid = iccid.clone();
                        tokio::spawn(async move {
                            if let Err(e) = api.report_incoming_call(&iccid, from.as_deref()).await
                            {
                                warn!("📞 Failed to report incoming call: {}", e);
                            }
                        });
                    }
                    Some(RingReport::Ended) => {
                        let api = self.api.clone();
                        let iccid = iccid.clone();
                        tokio::spawn(async move {
                            if let Err(e) = api
                                .report_call_ended(None, &iccid, CallEndReason::Missed)
                                .await
                            {
                                warn!("📞 Failed to report missed call: {}", e);
                            }
                        });
                    }
                    None => {}
                }
            }
            // A modem that never ends a line must not grow this without bound.
            if line.len() > 1024 {
                line.clear();
            }
        }
    }
}
