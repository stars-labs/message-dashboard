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

use crate::api_client::ApiClient;
use crate::at_modem::{AtModemManager, VoicePorts};
use crate::modem_manager::ModemManager;
use crate::types::ModemReport;
use crate::urc_reader::{parse_urc_line, UrcEvent};
use crate::voice_auth::{self, CallAction, Leg, VoiceRequest};
use crate::voice_call::{is_ringing, parse_clcc, RingReport, RingTracker};
use crate::voice_codec::{adapter_to_modem, modem_to_adapter, Packet};
use anyhow::{anyhow, bail, Result};
use futures_util::{SinkExt, StreamExt};
use rustls_acme::caches::DirCache;
use rustls_acme::{is_tls_alpn_challenge, AcmeConfig};
use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::unix::AsyncFd;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, mpsc, watch, Mutex, RwLock};
use tokio_rustls::LazyConfigAcceptor;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, error, info, warn};

/// Bytes the module sends per 40 ms frame (320 samples of 8 kHz s16le).
const MODEM_FRAME: usize = 640;
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
    pub port: u16,
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
            port: std::env::var("VOICE_BRIDGE_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(443),
            acme_dir: std::env::var("VOICE_BRIDGE_ACME_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|_| PathBuf::from("/var/lib/sms-daemon/acme")),
            acme_production: std::env::var("VOICE_BRIDGE_ACME_STAGING").as_deref() != Ok("1"),
        })
    }
}

/// Handles shared by the tasks of the one active call.
#[derive(Clone)]
struct CallHandles {
    call_id: String,
    stop: watch::Receiver<bool>,
    to_browser: broadcast::Sender<Arc<Vec<u8>>>,
    to_modem: mpsc::Sender<Vec<u8>>,
    up_seen: Arc<AtomicBool>,
    down_seen: Arc<AtomicBool>,
}

struct ActiveCall {
    handles: CallHandles,
    stop: watch::Sender<bool>,
    iccid: String,
    modem_id: String,
}

#[derive(Default)]
struct BridgeState {
    active: Option<ActiveCall>,
    ended: VecDeque<String>,
}

pub struct VoiceBridge {
    api_key: String,
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

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl VoiceBridge {
    pub fn new(
        api_key: String,
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

    // ---------------------------------------------------------------------
    // Listener
    // ---------------------------------------------------------------------

    pub async fn serve(self: Arc<Self>, config: VoiceBridgeConfig) -> Result<()> {
        // reqwest may already have installed one; either way ring is the provider.
        let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();
        let mut acme = AcmeConfig::new([config.domain.clone()])
            .cache(DirCache::new(config.acme_dir.clone()))
            .directory_lets_encrypt(config.acme_production)
            .state();
        let challenge_config = acme.challenge_rustls_config();
        let default_config = acme.default_rustls_config();

        tokio::spawn(async move {
            while let Some(event) = acme.next().await {
                match event {
                    Ok(ok) => info!("🔐 Voice bridge certificate: {:?}", ok),
                    Err(e) => warn!("🔐 Voice bridge certificate error: {:?}", e),
                }
            }
        });

        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, config.port)).await?;
        info!(
            "📞 Voice bridge listening on :{} for {}",
            config.port, config.domain
        );

        loop {
            let (tcp, peer) = match listener.accept().await {
                Ok(conn) => conn,
                Err(e) => {
                    warn!("📞 Voice bridge accept failed: {}", e);
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    continue;
                }
            };
            let bridge = self.clone();
            let challenge_config = challenge_config.clone();
            let default_config = default_config.clone();
            tokio::spawn(async move {
                if let Err(e) = bridge
                    .handle_connection(tcp, peer, challenge_config, default_config)
                    .await
                {
                    debug!("📞 Voice bridge connection from {} closed: {}", peer, e);
                }
            });
        }
    }

    async fn handle_connection(
        self: Arc<Self>,
        tcp: TcpStream,
        peer: SocketAddr,
        challenge_config: Arc<rustls_acme::rustls::ServerConfig>,
        default_config: Arc<rustls_acme::rustls::ServerConfig>,
    ) -> Result<()> {
        let start = tokio::time::timeout(
            Duration::from_secs(10),
            LazyConfigAcceptor::new(Default::default(), tcp),
        )
        .await??;

        // Let's Encrypt validates from its own addresses, so challenges are
        // answered before the Cloudflare allowlist applies.
        if is_tls_alpn_challenge(&start.client_hello()) {
            info!("🔐 Answering TLS-ALPN-01 challenge from {}", peer);
            let mut tls = start.into_stream(challenge_config).await?;
            tokio::io::AsyncWriteExt::shutdown(&mut tls).await?;
            return Ok(());
        }
        if !voice_auth::is_cloudflare_ip(peer.ip()) {
            bail!("peer is not a Cloudflare address");
        }

        let tls = tokio::time::timeout(Duration::from_secs(10), start.into_stream(default_config))
            .await??;

        let api_key = self.api_key.clone();
        let admitted = Arc::new(std::sync::Mutex::new(None));
        let admitted_slot = admitted.clone();
        let callback = move |request: &Request, response: Response| {
            let path = request.uri().path();
            match voice_auth::parse_path(path) {
                Some(req) if voice_auth::verify(&api_key, &req, now_unix()) => {
                    *admitted_slot.lock().unwrap() = Some(req);
                    Ok(response)
                }
                _ => {
                    let mut reject = ErrorResponse::new(None);
                    *reject.status_mut() = StatusCode::FORBIDDEN;
                    Err(reject)
                }
            }
        };
        let ws = tokio::time::timeout(
            Duration::from_secs(10),
            tokio_tungstenite::accept_hdr_async(tls, callback),
        )
        .await??;
        let request = admitted
            .lock()
            .unwrap()
            .take()
            .ok_or_else(|| anyhow!("upgrade accepted without an admitted request"))?;

        info!(
            call_id = %request.call_id,
            leg = ?request.leg,
            "📞 Adapter connected from {}",
            peer
        );
        self.run_leg(request, ws).await;
        Ok(())
    }

    // ---------------------------------------------------------------------
    // Call lifecycle
    // ---------------------------------------------------------------------

    async fn run_leg<S>(
        self: Arc<Self>,
        request: VoiceRequest,
        ws: tokio_tungstenite::WebSocketStream<S>,
    ) where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    {
        let handles = match self.clone().join_or_start(&request).await {
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
                        .report_call_ended(Some(&call_id), &iccid, "setup_failed")
                        .await
                    {
                        warn!(call_id = %call_id, "📞 Failed to report call setup failure: {}", e);
                    }
                });
                return Err(e);
            }
        };

        let (stop_tx, stop_rx) = watch::channel(false);
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

        let bridge = self.clone();
        let call_id = request.call_id.clone();
        let stop = handles.stop.clone();
        tokio::spawn(async move {
            let reason = pump_nmea(nmea, to_browser, from_browser, stop).await;
            bridge.end_call(&call_id, reason).await;
        });
        tokio::spawn(self.clone().watchdog(handles.clone(), modem_id.clone()));

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
            iccid: request.iccid.clone(),
            modem_id,
        });
        Ok(handles)
    }

    /// The live modem holding `iccid`, confirmed on the SIM itself because the
    /// device snapshot can be up to a scan cycle old.
    async fn resolve_modem(&self, iccid: &str) -> Result<(String, VoicePorts)> {
        let candidates: Vec<String> = self
            .devices
            .read()
            .await
            .iter()
            .filter(|(_, report)| report.detected_iccid.as_deref() == Some(iccid))
            .map(|(modem_id, _)| modem_id.clone())
            .collect();
        for modem_id in candidates {
            if self
                .modems
                .get_iccid(&modem_id)
                .await
                .ok()
                .flatten()
                .as_deref()
                != Some(iccid)
            {
                continue;
            }
            let at_port = self.modems.get_port(&modem_id).await;
            return match AtModemManager::voice_ports_for_at_port(&at_port)? {
                Some(ports) => Ok((modem_id, ports)),
                None => Err(anyhow!(
                    "modem {} has no NMEA port and cannot carry voice",
                    modem_id
                )),
            };
        }
        bail!("no modem currently holds SIM {}", iccid)
    }

    async fn at(&self, modem_id: &str, command: &str, timeout: Duration) -> Result<String> {
        self.modems.voice_command(modem_id, command, timeout).await
    }

    async fn place_or_answer(&self, modem_id: &str, action: &CallAction) -> Result<()> {
        if let CallAction::Answer = action {
            let clcc = self.at(modem_id, "AT+CLCC", Duration::from_secs(3)).await?;
            if !is_ringing(&parse_clcc(&clcc)) {
                bail!("modem {} is not ringing", modem_id);
            }
        }

        // Voice over USB must be on before the call is set up (verified
        // 2026-09-16 for dialing). Whether it is accepted while an incoming call
        // is ringing is unverified, so for answers a refusal is logged, not fatal.
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
                    )
                }
            }
        }

        let (command, timeout) = match action {
            CallAction::Dial(number) => (format!("ATD{};", number), Duration::from_secs(10)),
            CallAction::Answer => ("ATA".to_string(), Duration::from_secs(15)),
        };
        let response = self.at(modem_id, &command, timeout).await;
        match response {
            Ok(text) if text.contains("OK") => Ok(()),
            other => {
                self.release_modem(modem_id).await;
                Err(anyhow!("{} failed: {:?}", command, other))
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
                _ = tokio::time::sleep(WATCHDOG_INTERVAL) => {}
            }
            let reason = match self.at(&modem_id, "AT+CLCC", Duration::from_secs(3)).await {
                Ok(clcc) if parse_clcc(&clcc).is_empty() => Some("remote_hangup"),
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
                .or(legs_missing.then_some("adapter_missing"))
                .or((started.elapsed() > MAX_CALL).then_some("max_duration"));
            if let Some(reason) = reason {
                self.end_call(&handles.call_id, reason).await;
                return;
            }
        }
    }

    /// Idempotent: only the first caller for a call id does the teardown.
    async fn end_call(&self, call_id: &str, reason: &str) {
        let active = {
            let mut state = self.state.lock().await;
            match &state.active {
                Some(active) if active.handles.call_id == call_id => {
                    remember_ended(&mut state.ended, call_id);
                    state.active.take()
                }
                _ => None,
            }
        };
        let Some(active) = active else {
            return;
        };

        info!(call_id, modem_id = %active.modem_id, reason, "📞 Call ended");
        let _ = active.stop.send(true);
        self.release_modem(&active.modem_id).await;
        if let Err(e) = self
            .api
            .report_call_ended(Some(call_id), &active.iccid, reason)
            .await
        {
            warn!(call_id, "📞 Failed to report call end: {}", e);
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
            self.end_call(&call_id, "remote_hangup").await;
        }
    }

    // ---------------------------------------------------------------------
    // Incoming calls
    // ---------------------------------------------------------------------

    /// Keep one URC reader per voice-capable modem with a known SIM.
    pub async fn run_urc_readers(self: Arc<Self>) {
        let mut readers: HashMap<String, (String, tokio::task::JoinHandle<()>)> = HashMap::new();
        info!("📞 URC reader supervisor started");
        loop {
            let snapshot: Vec<(String, String)> = self
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

    async fn read_urcs(self: Arc<Self>, modem_id: String, iccid: String, port: String) {
        let fd = match AtModemManager::open_serial(&port).and_then(|f| Ok(AsyncFd::new(f)?)) {
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
            for &byte in &buf[..n] {
                if byte != b'\n' && byte != b'\r' {
                    line.push(byte);
                    continue;
                }
                let text = String::from_utf8_lossy(&line).into_owned();
                line.clear();
                let Some(event) = parse_urc_line(&text) else {
                    continue;
                };
                if event == UrcEvent::NoCarrier {
                    self.on_no_carrier(&modem_id).await;
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
                            if let Err(e) = api.report_call_ended(None, &iccid, "missed").await {
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

// -------------------------------------------------------------------------
// Audio pumps
// -------------------------------------------------------------------------

fn open_nmea(port: &str) -> Result<AsyncFd<File>> {
    Ok(AsyncFd::new(AtModemManager::open_serial(port)?)?)
}

/// How many empty reads in a row mean the port is gone rather than idle.
const MAX_EMPTY_READS: u32 = 50;
/// Pause after an empty read. This is what guarantees the task really yields.
const EMPTY_READ_PAUSE: Duration = Duration::from_millis(100);

/// Read whatever is available, or fail once the port has gone away.
///
/// A tty opened with VMIN=0 can report readiness and then return 0 bytes, so an
/// empty read is retried. But when the USB device disappears the tty is hung
/// up: it reports readable forever, `read` returns 0 forever, and `clear_ready`
/// does not clear the closed state. The first version of this loop therefore
/// never suspended — one spinning reader pinned a runtime worker, four of them
/// pinned all four, and the whole daemon (SMS collection, heartbeats, and the
/// stall watchdog that lived on the same runtime) stopped while the process
/// stayed alive. That was the outage of 2026-09-18 and the 23-hour one of
/// 2026-09-20; both began with a USB re-enumeration.
async fn read_some(fd: &AsyncFd<File>, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut empty_reads = 0u32;
    loop {
        let mut guard = fd.readable().await?;
        if guard.ready().is_read_closed() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "serial port hung up",
            ));
        }
        match guard.try_io(|inner| inner.get_ref().read(buf)) {
            Ok(Ok(0)) => {
                guard.clear_ready();
                empty_reads += 1;
                if empty_reads >= MAX_EMPTY_READS {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        "serial port returned no data while reporting readable",
                    ));
                }
                // A real suspension point, whatever the readiness state claims.
                tokio::time::sleep(EMPTY_READ_PAUSE).await;
            }
            Ok(result) => return result,
            Err(_would_block) => continue,
        }
    }
}

async fn write_all(fd: &AsyncFd<File>, mut data: &[u8]) -> std::io::Result<()> {
    while !data.is_empty() {
        let mut guard = fd.writable().await?;
        match guard.try_io(|inner| inner.get_ref().write(data)) {
            // A write that accepts nothing would otherwise loop forever.
            Ok(Ok(0)) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WriteZero,
                    "serial port accepted no data",
                ))
            }
            Ok(Ok(n)) => data = &data[n..],
            Ok(Err(e)) => return Err(e),
            Err(_would_block) => continue,
        }
    }
    Ok(())
}

/// Moves PCM between the NMEA port and the two legs until the call stops.
async fn pump_nmea(
    fd: AsyncFd<File>,
    to_browser: broadcast::Sender<Arc<Vec<u8>>>,
    mut from_browser: mpsc::Receiver<Vec<u8>>,
    mut stop: watch::Receiver<bool>,
) -> &'static str {
    let mut pending = Vec::with_capacity(MODEM_FRAME * 4);
    let mut buf = [0u8; 4096];
    let mut last_sample = 0i16;
    let mut sequence = 0u32;
    loop {
        tokio::select! {
            _ = stop.changed() => return "stopped",
            read = read_some(&fd, &mut buf) => {
                let n = match read {
                    Ok(n) => n,
                    Err(e) => {
                        warn!("📞 NMEA read failed: {}", e);
                        return "nmea_error";
                    }
                };
                pending.extend_from_slice(&buf[..n]);
                while pending.len() >= MODEM_FRAME {
                    let frame: Vec<u8> = pending.drain(..MODEM_FRAME).collect();
                    let payload = modem_to_adapter(&frame, &mut last_sample);
                    let samples = (payload.len() / 4) as u32;
                    let packet = Packet { sequence_number: sequence, timestamp: sequence.wrapping_mul(samples), payload };
                    sequence = sequence.wrapping_add(1);
                    // No subscriber yet just means the up leg has not connected.
                    let _ = to_browser.send(Arc::new(packet.encode()));
                }
            }
            Some(pcm) = from_browser.recv() => {
                if let Err(e) = write_all(&fd, &pcm).await {
                    warn!("📞 NMEA write failed: {}", e);
                    return "nmea_error";
                }
            }
        }
    }
}

/// `up` leg: modem audio out to the SFU.
async fn pump_up<S>(
    mut ws: tokio_tungstenite::WebSocketStream<S>,
    mut audio: broadcast::Receiver<Arc<Vec<u8>>>,
    mut stop: watch::Receiver<bool>,
) -> &'static str
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        tokio::select! {
            _ = stop.changed() => {
                let _ = ws.close(None).await;
                return "stopped";
            }
            frame = audio.recv() => match frame {
                Ok(bytes) => {
                    if ws.send(Message::Binary(bytes.as_ref().clone())).await.is_err() {
                        return "adapter_closed";
                    }
                }
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    debug!("📞 up leg dropped {} frames", skipped);
                }
                Err(broadcast::error::RecvError::Closed) => return "stopped",
            },
            incoming = ws.next() => match incoming {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return "adapter_closed",
                Some(Ok(_)) => {}
            },
        }
    }
}

/// `down` leg: browser audio in from the SFU.
async fn pump_down<S>(
    mut ws: tokio_tungstenite::WebSocketStream<S>,
    to_modem: mpsc::Sender<Vec<u8>>,
    mut stop: watch::Receiver<bool>,
) -> &'static str
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        tokio::select! {
            _ = stop.changed() => {
                let _ = ws.close(None).await;
                return "stopped";
            }
            incoming = ws.next() => match incoming {
                Some(Ok(Message::Binary(bytes))) => {
                    let Some(packet) = Packet::decode(&bytes) else {
                        continue;
                    };
                    let pcm = adapter_to_modem(&packet.payload);
                    // A full queue means the modem side stalled; drop rather than
                    // add latency to a live call.
                    let _ = to_modem.try_send(pcm);
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return "adapter_closed",
                Some(Ok(_)) => {}
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::{FromRawFd, IntoRawFd};
    use std::os::unix::net::UnixStream;

    /// A non-blocking fd whose peer can be dropped to simulate a hang-up.
    fn pair() -> (AsyncFd<File>, UnixStream) {
        let (ours, theirs) = UnixStream::pair().unwrap();
        ours.set_nonblocking(true).unwrap();
        let file = unsafe { File::from_raw_fd(ours.into_raw_fd()) };
        (AsyncFd::new(file).unwrap(), theirs)
    }

    #[tokio::test]
    async fn read_some_returns_data_when_there_is_some() {
        let (fd, mut peer) = pair();
        std::io::Write::write_all(&mut peer, b"RING\r\n").unwrap();

        let mut buf = [0u8; 16];
        let n = read_some(&fd, &mut buf).await.unwrap();
        assert_eq!(&buf[..n], b"RING\r\n");
    }

    /// The regression for the 2026-09-18 and 2026-09-20 outages: a port whose
    /// device vanished must end the read, not spin on it forever.
    #[tokio::test]
    async fn read_some_fails_instead_of_spinning_when_the_port_hangs_up() {
        let (fd, peer) = pair();
        drop(peer);

        let mut buf = [0u8; 16];
        let outcome = tokio::time::timeout(Duration::from_secs(10), read_some(&fd, &mut buf)).await;
        assert!(outcome.expect("read_some must return, not hang").is_err());
    }

    /// Even while one reader waits on a dead port, other tasks must keep running.
    /// A single-threaded runtime makes starvation show up as a timeout.
    #[tokio::test(flavor = "current_thread")]
    async fn a_dead_port_does_not_starve_other_tasks() {
        let (fd, peer) = pair();
        drop(peer);
        let reader = tokio::spawn(async move {
            let mut buf = [0u8; 16];
            let _ = read_some(&fd, &mut buf).await;
        });

        let ticked = tokio::time::timeout(Duration::from_secs(5), async {
            tokio::time::sleep(Duration::from_millis(50)).await;
        })
        .await;
        assert!(ticked.is_ok(), "another task was starved by the reader");
        let _ = reader.await;
    }
}
