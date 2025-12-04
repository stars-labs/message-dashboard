//! Debug tool to test AT commands directly

use anyhow::Result;
use nix::sys::termios::{self, BaudRate, SetArg};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::time::{Duration, Instant};

fn open_serial(port: &str) -> Result<File> {
    let file = OpenOptions::new().read(true).write(true).open(port)?;

    let mut term = termios::tcgetattr(&file)?;

    termios::cfsetispeed(&mut term, BaudRate::B115200)?;
    termios::cfsetospeed(&mut term, BaudRate::B115200)?;

    // Raw mode: 8N1
    term.control_flags &= !(termios::ControlFlags::CSIZE | termios::ControlFlags::PARENB);
    term.control_flags |=
        termios::ControlFlags::CS8 | termios::ControlFlags::CREAD | termios::ControlFlags::CLOCAL;
    term.control_flags &= !termios::ControlFlags::CRTSCTS;

    term.local_flags &= !(termios::LocalFlags::ICANON
        | termios::LocalFlags::ECHO
        | termios::LocalFlags::ECHOE
        | termios::LocalFlags::ISIG);
    term.input_flags &= !(termios::InputFlags::IXON
        | termios::InputFlags::IXOFF
        | termios::InputFlags::IXANY
        | termios::InputFlags::ICRNL
        | termios::InputFlags::INLCR);
    term.output_flags &= !termios::OutputFlags::OPOST;

    term.control_chars[termios::SpecialCharacterIndices::VMIN as usize] = 0;
    term.control_chars[termios::SpecialCharacterIndices::VTIME as usize] = 1;

    termios::tcsetattr(&file, SetArg::TCSANOW, &term)?;
    termios::tcflush(&file, termios::FlushArg::TCIOFLUSH)?;

    Ok(file)
}

fn send_at(port: &str, cmd: &str, timeout_ms: u64) -> Result<String> {
    let mut file = open_serial(port)?;

    // Send command
    let full_cmd = format!("{}\r", cmd);
    file.write_all(full_cmd.as_bytes())?;
    file.flush()?;

    // Read response
    let mut response = Vec::new();
    let mut buf = [0u8; 256];
    let start = Instant::now();
    let timeout = Duration::from_millis(timeout_ms);

    loop {
        if start.elapsed() > timeout {
            break;
        }

        match file.read(&mut buf) {
            Ok(0) => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Ok(n) => {
                response.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&response);
                if text.contains("OK\r") || text.contains("ERROR") {
                    break;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => return Err(e.into()),
        }
    }

    Ok(String::from_utf8_lossy(&response).to_string())
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();

    if args.len() < 2 {
        println!("AT Command Debug Tool");
        println!();
        println!("Usage: {} <port> [command]", args[0]);
        println!();
        println!("Examples:");
        println!(
            "  {} /dev/ttyUSB2           # Test common commands",
            args[0]
        );
        println!(
            "  {} /dev/ttyUSB2 AT+QCCID  # Test specific command",
            args[0]
        );
        return Ok(());
    }

    let port = &args[1];

    if args.len() > 2 {
        // Single command mode
        let cmd = &args[2];
        println!("Port: {}", port);
        println!("Command: {}", cmd);
        println!("---");
        let response = send_at(port, cmd, 3000)?;
        println!("Response (raw):");
        println!("{:?}", response);
        println!();
        println!("Response (cleaned):");
        for line in response.lines() {
            println!("  [{}]", line.trim());
        }
    } else {
        // Test multiple commands
        println!("Testing AT commands on {}", port);
        println!("================================");

        let commands = [
            ("AT", "Basic test"),
            ("AT+CPIN?", "SIM PIN status"),
            ("AT+QCCID", "ICCID (Quectel)"),
            ("AT+CCID", "ICCID (generic)"),
            ("AT+ICCID", "ICCID (alt)"),
            ("AT+CGSN", "IMEI"),
            ("AT+CGMI", "Manufacturer"),
            ("AT+CGMM", "Model"),
            ("AT+CSQ", "Signal quality"),
            ("AT+CNUM", "Phone number"),
            ("AT+COPS?", "Operator"),
        ];

        for (cmd, desc) in commands {
            println!("\n{} ({})", cmd, desc);
            println!("-----------------------");
            match send_at(port, cmd, 2000) {
                Ok(response) => {
                    println!("Raw: {:?}", response);
                    for line in response.lines() {
                        let line = line.trim();
                        if !line.is_empty() {
                            println!("  > {}", line);
                        }
                    }
                }
                Err(e) => println!("ERROR: {}", e),
            }
        }
    }

    Ok(())
}
