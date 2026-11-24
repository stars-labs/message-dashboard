use super::{VoiceBridge, VoiceBridgeConfig};
use crate::proxy_protocol;
use crate::voice_auth;
use anyhow::{anyhow, bail, Result};
use futures_util::StreamExt;
use rustls_acme::caches::DirCache;
use rustls_acme::{is_tls_alpn_challenge, AcmeConfig};
use std::net::SocketAddr;
use std::sync::{Arc, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::LazyConfigAcceptor;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tracing::{debug, info, warn};

/// Consume the PROXY protocol header and return the source it names.
///
/// The header is peeked until its CRLF arrives, then read off the stream for
/// exactly its own length, so the TLS `ClientHello` that follows is untouched.
pub(super) async fn read_proxy_source(tcp: &mut TcpStream) -> Result<Option<SocketAddr>> {
    use tokio::io::AsyncReadExt;
    let mut buf = [0u8; proxy_protocol::MAX_HEADER_LEN];
    let header = loop {
        let n = tokio::time::timeout(Duration::from_secs(5), tcp.peek(&mut buf)).await??;
        if n == 0 {
            bail!("connection closed before the proxy header");
        }
        let Some(peeked) = buf.get(..n) else {
            bail!("peeked {n} bytes into a {}-byte buffer", buf.len());
        };
        match proxy_protocol::parse_v1(peeked) {
            Ok(header) => break header,
            Err(proxy_protocol::ParseError::Incomplete) if n < buf.len() => {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Err(e) => bail!("{e:?}"),
        }
    };
    let mut discard = vec![0u8; header.len];
    tcp.read_exact(&mut discard).await?;
    Ok(header.source)
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

impl VoiceBridge {
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

        let listener = TcpListener::bind((config.listen, config.port)).await?;
        info!(
            "📞 Voice bridge listening on {}:{} for {}{}",
            config.listen,
            config.port,
            config.domain,
            if config.proxy_protocol {
                " (behind a PROXY protocol router)"
            } else {
                ""
            }
        );
        let proxy_protocol = config.proxy_protocol;

        loop {
            let (tcp, peer) = match listener.accept().await {
                Ok(conn) => conn,
                Err(e) => {
                    warn!("📞 Voice bridge accept failed: {}", e);
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    continue;
                }
            };
            let bridge = Arc::clone(&self);
            let challenge_config = Arc::clone(&challenge_config);
            let default_config = Arc::clone(&default_config);
            tokio::spawn(async move {
                let mut tcp = tcp;
                // Behind the router every TCP peer is 127.0.0.1; the PROXY header
                // carries the address the allowlist must judge.
                let peer = if proxy_protocol {
                    match read_proxy_source(&mut tcp).await {
                        Ok(Some(source)) => source,
                        Ok(None) => {
                            debug!("📞 Dropping connection with an UNKNOWN proxy source");
                            return;
                        }
                        Err(e) => {
                            debug!(
                                "📞 Dropping connection from {} without a proxy header: {}",
                                peer, e
                            );
                            return;
                        }
                    }
                } else {
                    peer
                };
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
            LazyConfigAcceptor::new(tokio_rustls::rustls::server::Acceptor::default(), tcp),
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
        let admitted_slot = Arc::clone(&admitted);
        #[expect(
            clippy::result_large_err,
            reason = "Tungstenite requires an unboxed ErrorResponse in its handshake callback"
        )]
        let callback = move |request: &Request, response: Response| {
            let path = request.uri().path();
            match voice_auth::parse_path(path) {
                Some(req) if voice_auth::verify(api_key.expose(), &req, now_unix()) => {
                    *admitted_slot.lock().unwrap_or_else(PoisonError::into_inner) = Some(req);
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
            .unwrap_or_else(PoisonError::into_inner)
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
}
