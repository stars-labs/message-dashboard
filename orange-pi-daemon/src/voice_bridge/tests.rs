use super::admission::read_proxy_source;
use super::serial::{async_file, read_some};
use super::{finish_modem_call, ActiveCall, BridgeState, CallHandles};
use crate::identifiers::Iccid;
use std::fs::File;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::unix::AsyncFd;
use tokio::sync::{broadcast, mpsc, watch, Mutex};

#[tokio::test]
async fn next_call_cannot_enter_while_modem_cleanup_is_pending() {
    let (stop, stopped) = watch::channel(false);
    let (pcm_ready, _) = watch::channel(true);
    let (to_browser, _) = broadcast::channel(1);
    let (to_modem, _) = mpsc::channel(1);
    let state = Mutex::new(BridgeState {
        active: Some(ActiveCall {
            handles: CallHandles {
                call_id: "old".into(),
                stop: stopped.clone(),
                to_browser,
                to_modem,
                up_seen: Arc::new(AtomicBool::new(false)),
                down_seen: Arc::new(AtomicBool::new(false)),
            },
            stop,
            pcm_ready,
            iccid: Iccid::try_from("89860000000000000042").unwrap(),
            modem_id: "modem".into(),
        }),
        ..Default::default()
    });

    let cancelled = tokio::time::timeout(
        Duration::from_millis(20),
        finish_modem_call(&state, "old", async |_| std::future::pending().await),
    )
    .await;
    assert!(cancelled.is_err());
    assert!(state.try_lock().unwrap().active.is_some());

    let ended = finish_modem_call(&state, "old", async |modem| {
        assert_eq!(modem, "modem");
        assert!(*stopped.borrow());
        tokio::task::yield_now().await;
        assert!(state.try_lock().is_err());
    })
    .await;
    assert!(ended.is_some());
    let state = state.try_lock().unwrap();
    assert!(state.active.is_none());
    assert_eq!(state.ended.front().map(String::as_str), Some("old"));
}
use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;

/// A non-blocking fd whose peer can be dropped to simulate a hang-up.
fn pair() -> (AsyncFd<File>, UnixStream) {
    let (ours, theirs) = UnixStream::pair().unwrap();
    ours.set_nonblocking(true).unwrap();
    let file = File::from(OwnedFd::from(ours));
    (async_file(file).unwrap(), theirs)
}

#[tokio::test]
async fn read_some_returns_data_when_there_is_some() {
    let (fd, mut peer) = pair();
    std::io::Write::write_all(&mut peer, b"RING\r\n").unwrap();

    let mut buf = [0u8; 16];
    let n = read_some(&fd, &mut buf).await.unwrap();
    assert_eq!(&buf[..n], b"RING\r\n");
}

/// A port whose device vanished must end the read, not spin on it forever.
#[tokio::test]
async fn read_some_fails_instead_of_spinning_when_the_port_hangs_up() {
    let (fd, peer) = pair();
    drop(peer);

    let mut buf = [0u8; 16];
    let outcome = tokio::time::timeout(Duration::from_secs(10), read_some(&fd, &mut buf)).await;
    assert!(outcome.expect("read_some must return, not hang").is_err());
}

/// The router prefixes each connection with one PROXY line; the bridge must
/// take the source from it and leave the TLS bytes that follow untouched.
#[tokio::test]
async fn proxy_header_is_consumed_and_names_the_real_source() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let client = tokio::spawn(async move {
        let mut c = tokio::net::TcpStream::connect(addr).await.unwrap();
        c.write_all(b"PROXY TCP4 172.70.204.71 10.171.150.102 60498 443\r\n")
            .await
            .unwrap();
        c.write_all(b"\x16\x03\x01hello").await.unwrap();
        c
    });
    let (mut tcp, _) = listener.accept().await.unwrap();

    let source = read_proxy_source(&mut tcp).await.unwrap();
    assert_eq!(source, Some("172.70.204.71:60498".parse().unwrap()));

    let mut rest = [0u8; 8];
    tcp.read_exact(&mut rest).await.unwrap();
    assert_eq!(&rest, b"\x16\x03\x01hello");
    drop(client.await.unwrap());
}

#[tokio::test]
async fn a_connection_without_a_proxy_header_is_refused() {
    use tokio::io::AsyncWriteExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let client = tokio::spawn(async move {
        let mut c = tokio::net::TcpStream::connect(addr).await.unwrap();
        // A raw ClientHello, as a client that bypassed the router would send.
        c.write_all(b"\x16\x03\x01\x02\x00\x01\x00\x01\xfc\x03\x03\r\n")
            .await
            .unwrap();
        c
    });
    let (mut tcp, _) = listener.accept().await.unwrap();

    assert!(read_proxy_source(&mut tcp).await.is_err());
    drop(client.await.unwrap());
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
