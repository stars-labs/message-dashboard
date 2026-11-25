use super::send_at;
use nix::fcntl::{fcntl, FcntlArg, OFlag};
use nix::pty::openpty;
use nix::unistd::ttyname;
use std::fs::File;
use std::io::{ErrorKind, Read, Write};
use std::os::fd::AsRawFd;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

#[test]
fn writes_a_carriage_return_and_returns_the_modem_result() {
    for reply in ["\r\nOK\r\n", "\r\nERROR\r\n"] {
        let pty = openpty(None, None).unwrap();
        let port = ttyname(&pty.slave).unwrap();
        let mut modem = File::from(pty.master);
        fcntl(modem.as_raw_fd(), FcntlArg::F_SETFL(OFlag::O_NONBLOCK)).unwrap();

        thread::scope(|scope| {
            let (result_tx, result_rx) = mpsc::channel();
            scope.spawn(move || {
                let response = send_at(port.to_str().unwrap(), "AT", 3_000);
                let _ = result_tx.send(response);
            });

            assert_eq!(read_command(&mut modem), *b"AT\r");
            modem.write_all(reply.as_bytes()).unwrap();
            let response = result_rx
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .unwrap();
            assert_eq!(response, reply);
        });
    }
}

#[test]
fn returns_an_empty_response_when_the_modem_is_silent() {
    let pty = openpty(None, None).unwrap();
    let port = ttyname(&pty.slave).unwrap();

    let reply = send_at(port.to_str().unwrap(), "AT", 100).unwrap();

    assert!(reply.is_empty());
}

fn read_command(modem: &mut File) -> [u8; 3] {
    let mut command = [0; 3];
    let mut received = 0;
    let deadline = Instant::now() + Duration::from_secs(2);
    while received < command.len() {
        assert!(
            Instant::now() < deadline,
            "timed out waiting for an AT command"
        );
        match modem.read(&mut command[received..]) {
            Ok(count) => received += count,
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(5));
            }
            Err(error) => panic!("failed to read the AT command: {error}"),
        }
    }
    command
}
