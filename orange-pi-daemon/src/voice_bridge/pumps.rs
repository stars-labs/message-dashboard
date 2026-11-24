use super::serial::{read_some, write_all};
use crate::voice_codec::{adapter_to_modem, modem_to_adapter, Packet};
use crate::voice_pacer::{Pacer, HOST_FRAME_INTERVAL};
use crate::wire::CallEndReason;
use futures_util::{SinkExt, StreamExt};
use std::fs::File;
use std::sync::Arc;
use tokio::io::unix::AsyncFd;
use tokio::sync::{broadcast, mpsc, watch};
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, warn};

/// Bytes the module sends per 40 ms frame (320 samples of 8 kHz s16le).
const MODEM_FRAME: usize = 640;

/// Moves PCM between the NMEA port and the two legs until the call stops.
///
/// Modem audio is forwarded as it arrives: the module paces itself at one
/// 640-byte frame per 40 ms. Browser audio goes through a [`Pacer`] so the
/// module receives one 1600-byte frame per 100 ms and nothing while it reports
/// `+QPCMV: 0`.
pub(super) async fn pump_nmea(
    fd: AsyncFd<File>,
    to_browser: broadcast::Sender<Arc<Vec<u8>>>,
    mut from_browser: mpsc::Receiver<Vec<u8>>,
    mut pcm_ready: watch::Receiver<bool>,
    mut stop: watch::Receiver<bool>,
) -> CallEndReason {
    let mut pending = Vec::with_capacity(MODEM_FRAME * 4);
    let mut buf = [0u8; 4096];
    let mut last_sample = 0i16;
    let mut sequence = 0u32;
    let mut pacer = Pacer::default();
    let mut tick = tokio::time::interval(HOST_FRAME_INTERVAL);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = stop.changed() => return CallEndReason::Stopped,
            read = read_some(&fd, &mut buf) => {
                let n = match read {
                    Ok(n) => n,
                    Err(e) => {
                        warn!("📞 NMEA read failed: {}", e);
                        return CallEndReason::NmeaError;
                    }
                };
                let Some(chunk) = buf.get(..n) else {
                    warn!("📞 NMEA read {} bytes into a {}-byte buffer", n, buf.len());
                    return CallEndReason::NmeaError;
                };
                pending.extend_from_slice(chunk);
                while pending.len() >= MODEM_FRAME {
                    let frame: Vec<u8> = pending.drain(..MODEM_FRAME).collect();
                    let payload = modem_to_adapter(&frame, &mut last_sample);
                    let samples = u32::try_from(payload.len() / 4).unwrap_or(u32::MAX);
                    let packet = Packet { sequence_number: sequence, timestamp: sequence.wrapping_mul(samples), payload };
                    sequence = sequence.wrapping_add(1);
                    // No subscriber yet just means the up leg has not connected.
                    let _ = to_browser.send(Arc::new(packet.encode()));
                }
            }
            Some(pcm) = from_browser.recv() => pacer.push(&pcm),
            changed = pcm_ready.changed() => {
                // The sender lives in the call state and goes away on teardown.
                if changed.is_err() {
                    return CallEndReason::Stopped;
                }
                let ready = *pcm_ready.borrow_and_update();
                pacer.set_ready(ready);
                if ready {
                    debug!("📞 Modem ready for PCM again, {} bytes queued", pacer.buffered());
                } else {
                    debug!("📞 Modem busy, holding browser audio");
                }
            }
            _ = tick.tick() => {
                if let Some(frame) = pacer.next_frame() {
                    if let Err(e) = write_all(&fd, &frame).await {
                        warn!("📞 NMEA write failed: {}", e);
                        return CallEndReason::NmeaError;
                    }
                }
                let dropped = pacer.take_dropped();
                if dropped > 0 {
                    debug!("📞 Dropped {} bytes of browser audio to keep latency bounded", dropped);
                }
            }
        }
    }
}

pub(super) async fn pump_up<S>(
    mut ws: tokio_tungstenite::WebSocketStream<S>,
    mut audio: broadcast::Receiver<Arc<Vec<u8>>>,
    mut stop: watch::Receiver<bool>,
) -> CallEndReason
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        tokio::select! {
            _ = stop.changed() => {
                let _ = ws.close(None).await;
                return CallEndReason::Stopped;
            }
            frame = audio.recv() => match frame {
                Ok(bytes) => {
                    if ws.send(Message::Binary(bytes.as_ref().clone())).await.is_err() {
                        return CallEndReason::AdapterClosed;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    debug!("📞 up leg dropped {} frames", skipped);
                }
                Err(broadcast::error::RecvError::Closed) => return CallEndReason::Stopped,
            },
            incoming = ws.next() => match incoming {
                Some(Ok(Message::Close(_)) | Err(_)) | None => return CallEndReason::AdapterClosed,
                Some(Ok(_)) => {}
            },
        }
    }
}

pub(super) async fn pump_down<S>(
    mut ws: tokio_tungstenite::WebSocketStream<S>,
    to_modem: mpsc::Sender<Vec<u8>>,
    mut stop: watch::Receiver<bool>,
) -> CallEndReason
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        tokio::select! {
            _ = stop.changed() => {
                let _ = ws.close(None).await;
                return CallEndReason::Stopped;
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
                Some(Ok(Message::Close(_)) | Err(_)) | None => return CallEndReason::AdapterClosed,
                Some(Ok(_)) => {}
            },
        }
    }
}
