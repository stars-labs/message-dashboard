//! Voice bridge: Cloudflare Realtime WebSocket adapters <-> EC20 voice over USB.
//!
//! The SFU connects in over `wss://` twice per call. The `up` leg carries modem
//! audio to the browser, the `down` leg carries browser audio to the modem. The
//! first admitted leg of a call places or answers it; losing either leg, the far
//! end hanging up, or a failed setup tears the call down and reports it to the
//! Worker. Design and evidence: `docs/voice-call-plan.md`.
//!
//! The same listener serves Let's Encrypt TLS-ALPN-01 challenges, so the
//! certificate renews itself with no DNS token on the Pi.

mod admission;
mod pumps;
mod serial;
#[cfg(test)]
mod tests;
mod urc;

use crate::api_client::ApiClient;
use crate::at_modem::{AtModemManager, VoicePorts};
use crate::identifiers::Iccid;
use crate::modem_manager::ModemManager;
use crate::types::ApiKey;
use crate::voice_auth::{CallAction, Leg, VoiceRequest};
use crate::voice_call::{is_ringing, parse_clcc};
use crate::wire::{CallEndReason, ModemReport};
use anyhow::{anyhow, bail, Result};
use pumps::{pump_down, pump_nmea, pump_up};
use serial::open_nmea;
use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, mpsc, watch, Mutex, RwLock};
use tracing::{error, info, warn};

/// How often an established call is checked against `AT+CLCC`.
const WATCHDOG_INTERVAL: Duration = Duration::from_secs(2);
/// Both adapters must have connected by then, or the call is abandoned.
const LEGS_DEADLINE: Duration = Duration::from_secs(30);
/// Matches the Worker's KV lock TTL.
const MAX_CALL: Duration = Duration::from_secs(3600);
/// How many finished call ids are remembered, so a signed path cannot restart one.
const ENDED_MEMORY: usize = 32;

#[derive(Debug, Clone)]
pub struct VoiceBridgeConfig {
    pub domain: String,
    /// Address to bind. `127.0.0.1` when an nginx SNI router in front shares
    /// port 443 with other services; `0.0.0.0` when the bridge owns the port.
    pub listen: IpAddr,
    pub port: u16,
    /// Expect a PROXY protocol v1 header on every connection, so the real
    /// source address survives the router for the Cloudflare allowlist.
    pub proxy_protocol: bool,
    pub acme_dir: PathBuf,
    pub acme_production: bool,
}

impl VoiceBridgeConfig {
    /// Enabled only when `VOICE_BRIDGE_DOMAIN` is set.
    pub fn from_env() -> Option<Self> {
        let domain = std::env::var("VOICE_BRIDGE_DOMAIN")
            .ok()
            .filter(|d| !d.is_empty())?;
        Some(Self {
            domain,
            listen: std::env::var("VOICE_BRIDGE_LISTEN")
                .ok()
                .and_then(|a| a.parse().ok())
                .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED)),
            proxy_protocol: std::env::var("VOICE_BRIDGE_PROXY_PROTOCOL").as_deref() == Ok("1"),
            port: std::env::var("VOICE_BRIDGE_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(443),
            acme_dir: std::env::var("VOICE_BRIDGE_ACME_DIR")
                .map_or_else(|_| PathBuf::from("/var/lib/sms-daemon/acme"), PathBuf::from),
            acme_production: std::env::var("VOICE_BRIDGE_ACME_STAGING").as_deref() != Ok("1"),
        })
    }
}

/// Handles shared by the tasks of the one active call.
#[derive(Debug, Clone)]
struct CallHandles {
    call_id: String,
    stop: watch::Receiver<bool>,
    to_browser: broadcast::Sender<Arc<Vec<u8>>>,
    to_modem: mpsc::Sender<Vec<u8>>,
    up_seen: Arc<AtomicBool>,
    down_seen: Arc<AtomicBool>,
}

#[derive(Debug)]
struct ActiveCall {
    handles: CallHandles,
    stop: watch::Sender<bool>,
    /// `+QPCMV` flow control from the URC reader to the NMEA pump.
    pcm_ready: watch::Sender<bool>,
    iccid: Iccid,
    modem_id: String,
}

#[derive(Debug, Default)]
struct BridgeState {
    active: Option<ActiveCall>,
    ended: VecDeque<String>,
}

#[derive(Debug)]
pub struct VoiceBridge {
    api_key: ApiKey,
    modems: Arc<ModemManager>,
    api: ApiClient,
    devices: Arc<RwLock<HashMap<String, ModemReport>>>,
    state: Mutex<BridgeState>,
}

fn remember_ended(ended: &mut VecDeque<String>, call_id: &str) {
    ended.push_back(call_id.to_string());
    if ended.len() > ENDED_MEMORY {
        ended.pop_front();
    }
}

async fn finish_modem_call(
    state: &Mutex<BridgeState>,
    call_id: &str,
    cleanup: impl AsyncFnOnce(&str),
) -> Option<ActiveCall> {
    let mut state = state.lock().await;
    let active = state.active.as_ref()?;
    if active.handles.call_id != call_id {
        return None;
    }
    let _ = active.stop.send(true);
    // Admission uses the same mutex. Keep it until ATH and PCM cleanup finish.
    cleanup(&active.modem_id).await;
    remember_ended(&mut state.ended, call_id);
    state.active.take()
}

impl VoiceBridge {
    pub fn new(
        api_key: ApiKey,
        modems: Arc<ModemManager>,
        api: ApiClient,
        devices: Arc<RwLock<HashMap<String, ModemReport>>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            api_key,
            modems,
            api,
            devices,
            state: Mutex::new(BridgeState::default()),
        })
    }

    async fn run_leg<S>(
        self: Arc<Self>,
        request: VoiceRequest,
        ws: tokio_tungstenite::WebSocketStream<S>,
    ) where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    {
        let handles = match Arc::clone(&self).join_or_start(&request).await {
            Ok(handles) => handles,
            Err(e) => {
                warn!(call_id = %request.call_id, "📞 Call refused: {:#}", e);
                let mut ws = ws;
                let _ = ws.close(None).await;
                return;
            }
        };

        let reason = match request.leg {
            Leg::Up => {
                handles.up_seen.store(true, Ordering::Relaxed);
                pump_up(ws, handles.to_browser.subscribe(), handles.stop.clone()).await
            }
            Leg::Down => {
                handles.down_seen.store(true, Ordering::Relaxed);
                pump_down(ws, handles.to_modem.clone(), handles.stop.clone()).await
            }
        };
        self.end_call(&handles.call_id, reason).await;
    }

    /// Attach to the active call, or place/answer it when this is its first leg.
    async fn join_or_start(self: Arc<Self>, request: &VoiceRequest) -> Result<CallHandles> {
        let mut state = self.state.lock().await;
        if state.ended.contains(&request.call_id) {
            bail!("call already ended");
        }
        if let Some(active) = &state.active {
            if active.handles.call_id == request.call_id {
                return Ok(active.handles.clone());
            }
            bail!("another call is active ({})", active.handles.call_id);
        }

        let setup = async {
            let (modem_id, ports) = self.resolve_modem(&request.iccid).await?;
            let nmea = open_nmea(&ports.nmea)?;
            self.place_or_answer(&modem_id, &request.action).await?;
            Ok::<_, anyhow::Error>((modem_id, nmea))
        };
        let (modem_id, nmea) = match setup.await {
            Ok(ready) => ready,
            Err(e) => {
                // The other leg must not retry the dial, and the Worker must not
                // wait for audio that will never come.
                remember_ended(&mut state.ended, &request.call_id);
                drop(state);
                let api = self.api.clone();
                let (call_id, iccid) = (request.call_id.clone(), request.iccid.clone());
                tokio::spawn(async move {
                    if let Err(e) = api
                        .report_call_ended(Some(&call_id), &iccid, CallEndReason::SetupFailed)
                        .await
                    {
                        warn!(call_id = %call_id, "📞 Failed to report call setup failure: {}", e);
                    }
                });
                return Err(e);
            }
        };

        let (stop_tx, stop_rx) = watch::channel(false);
        let (pcm_ready_tx, pcm_ready_rx) = watch::channel(true);
        let (to_browser, _) = broadcast::channel(64);
        let (to_modem, from_browser) = mpsc::channel(64);
        let handles = CallHandles {
            call_id: request.call_id.clone(),
            stop: stop_rx,
            to_browser: to_browser.clone(),
            to_modem,
            up_seen: Arc::new(AtomicBool::new(false)),
            down_seen: Arc::new(AtomicBool::new(false)),
        };

        let bridge = Arc::clone(&self);
        let call_id = request.call_id.clone();
        let stop = handles.stop.clone();
        tokio::spawn(async move {
            let reason = pump_nmea(nmea, to_browser, from_browser, pcm_ready_rx, stop).await;
            bridge.end_call(&call_id, reason).await;
        });
        tokio::spawn(Arc::clone(&self).watchdog(handles.clone(), modem_id.clone()));

        info!(
            call_id = %request.call_id,
            modem_id = %modem_id,
            iccid = %request.iccid,
            action = ?request.action,
            "📞 Call started"
        );
        state.active = Some(ActiveCall {
            handles: handles.clone(),
            stop: stop_tx,
            pcm_ready: pcm_ready_tx,
            iccid: request.iccid.clone(),
            modem_id,
        });
        Ok(handles)
    }

    /// The live modem holding `iccid`, confirmed on the SIM itself because the
    /// device snapshot can be up to a scan cycle old.
    async fn resolve_modem(&self, iccid: &Iccid) -> Result<(String, VoicePorts)> {
        let candidates: Vec<String> = self
            .devices
            .read()
            .await
            .iter()
            .filter(|(_, report)| report.detected_iccid.as_ref() == Some(iccid))
            .map(|(modem_id, _)| modem_id.clone())
            .collect();
        for modem_id in candidates {
            if self
                .modems
                .get_iccid(&modem_id)
                .await
                .ok()
                .flatten()
                .as_ref()
                != Some(iccid)
            {
                continue;
            }
            let at_port = self.modems.get_port(&modem_id).await;
            return match AtModemManager::voice_ports_for_at_port(&at_port)? {
                Some(ports) => Ok((modem_id, ports)),
                None => Err(anyhow!(
                    "modem {modem_id} has no NMEA port and cannot carry voice"
                )),
            };
        }
        bail!("no modem currently holds SIM {iccid}")
    }

    async fn at(&self, modem_id: &str, command: &str, timeout: Duration) -> Result<String> {
        self.modems.voice_command(modem_id, command, timeout).await
    }

    async fn place_or_answer(&self, modem_id: &str, action: &CallAction) -> Result<()> {
        if let CallAction::Answer = action {
            let clcc = self.at(modem_id, "AT+CLCC", Duration::from_secs(3)).await?;
            if !is_ringing(&parse_clcc(&clcc)) {
                bail!("modem {modem_id} is not ringing");
            }
        }

        // Voice over USB must be on before the call is set up. Whether it is
        // accepted while an incoming call is ringing is unverified, so for
        // answers a refusal is logged, not fatal.
        let pcm = self
            .at(modem_id, "AT+QPCMV=1,0", Duration::from_secs(3))
            .await?;
        if !pcm.contains("OK") {
            match action {
                CallAction::Dial(_) => bail!("AT+QPCMV=1,0 refused: {}", pcm.trim()),
                CallAction::Answer => {
                    warn!(
                        modem_id,
                        "📞 AT+QPCMV=1,0 refused while ringing: {}",
                        pcm.trim()
                    );
                }
            }
        }

        let (command, timeout) = match action {
            CallAction::Dial(number) => (format!("ATD{number};"), Duration::from_secs(10)),
            CallAction::Answer => ("ATA".to_string(), Duration::from_secs(15)),
        };
        let response = self.at(modem_id, &command, timeout).await;
        match response {
            Ok(text) if text.contains("OK") => Ok(()),
            other => {
                self.release_modem(modem_id).await;
                Err(anyhow!("{command} failed: {other:?}"))
            }
        }
    }

    /// Always runs on teardown; every path must leave the modem idle.
    async fn release_modem(&self, modem_id: &str) {
        for command in ["ATH", "AT+QPCMV=0"] {
            if let Err(e) = self.at(modem_id, command, Duration::from_secs(5)).await {
                error!(modem_id, "📞 {} failed during teardown: {}", command, e);
            }
        }
    }

    async fn watchdog(self: Arc<Self>, handles: CallHandles, modem_id: String) {
        let started = Instant::now();
        let mut stop = handles.stop.clone();
        loop {
            tokio::select! {
                _ = stop.changed() => return,
                () = tokio::time::sleep(WATCHDOG_INTERVAL) => {}
            }
            let reason = match self.at(&modem_id, "AT+CLCC", Duration::from_secs(3)).await {
                Ok(clcc) if parse_clcc(&clcc).is_empty() => Some(CallEndReason::RemoteHangup),
                Ok(_) => None,
                Err(e) => {
                    warn!(modem_id = %modem_id, "📞 CLCC failed during call: {}", e);
                    None
                }
            };
            let legs_missing = started.elapsed() > LEGS_DEADLINE
                && !(handles.up_seen.load(Ordering::Relaxed)
                    && handles.down_seen.load(Ordering::Relaxed));
            let reason = reason
                .or(legs_missing.then_some(CallEndReason::AdapterMissing))
                .or((started.elapsed() > MAX_CALL).then_some(CallEndReason::MaxDuration));
            if let Some(reason) = reason {
                self.end_call(&handles.call_id, reason).await;
                return;
            }
        }
    }

    /// Idempotent: only the first caller for a call id does the teardown.
    async fn end_call(&self, call_id: &str, reason: CallEndReason) {
        let active = finish_modem_call(&self.state, call_id, async |modem| {
            self.release_modem(modem).await;
        })
        .await;
        let Some(active) = active else {
            return;
        };

        info!(call_id, modem_id = %active.modem_id, reason = reason.as_str(), "📞 Call ended");
        if let Err(e) = self
            .api
            .report_call_ended(Some(call_id), &active.iccid, reason)
            .await
        {
            warn!(call_id, "📞 Failed to report call end: {}", e);
        }
    }
}
