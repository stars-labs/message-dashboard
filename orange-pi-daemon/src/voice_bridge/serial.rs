use crate::at_modem::AtModemManager;
use anyhow::Result;
use std::fs::File;
use std::io::{Read, Write};
use std::time::Duration;
use tokio::io::unix::AsyncFd;

pub(super) fn open_nmea(port: &str) -> Result<AsyncFd<File>> {
    Ok(async_file(AtModemManager::open_serial(port)?)?)
}

#[allow(
    unsafe_code,
    reason = "tokio 1.54 made AsyncFd registration unsafe; an owned File meets its contract"
)]
pub(super) fn async_file(file: File) -> std::io::Result<AsyncFd<File>> {
    // SAFETY: the AsyncFd owns `file`, so its descriptor stays open and names the same
    // file description until the AsyncFd drops it.
    Ok(unsafe { AsyncFd::register(file) }?)
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
/// does not clear the closed state. A loop that trusts readiness then never
/// suspends: each spinning reader pins a runtime worker, and enough of them
/// stall the whole daemon while the process stays alive.
pub(super) async fn read_some(fd: &AsyncFd<File>, buf: &mut [u8]) -> std::io::Result<usize> {
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
            Err(_would_block) => {}
        }
    }
}

pub(super) async fn write_all(fd: &AsyncFd<File>, mut data: &[u8]) -> std::io::Result<()> {
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
            Ok(Ok(n)) => {
                data = data.get(n..).ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "serial port wrote more bytes than were offered",
                    )
                })?;
            }
            Ok(Err(e)) => return Err(e),
            Err(_would_block) => {}
        }
    }
    Ok(())
}
