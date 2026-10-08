//! PROXY protocol v1, as sent by nginx `stream { proxy_protocol on; }`.
//!
//! The voice bridge now sits behind an nginx SNI router that shares port 443
//! with NetBird. A plain TCP proxy would make every connection look like it came
//! from 127.0.0.1, which defeats the Cloudflare allowlist. With the PROXY
//! protocol nginx prefixes each connection with one text line naming the real
//! source, and the bridge reads that line before the TLS handshake begins.
//!
//! Spec: <https://www.haproxy.org/download/1.8/doc/proxy-protocol.txt>, §2.1.

use std::net::{IpAddr, SocketAddr};

/// A v1 header is at most 107 bytes including the trailing CRLF.
pub const MAX_HEADER_LEN: usize = 107;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxyHeader {
    /// `None` for `PROXY UNKNOWN`: the proxy accepted a connection it could not
    /// describe, e.g. a health check over a Unix socket.
    pub source: Option<SocketAddr>,
    /// Bytes to consume from the stream before the payload starts.
    pub len: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    /// No CRLF yet and still under the maximum length: read more bytes.
    Incomplete,
    /// Not a PROXY header: the peer is not speaking the protocol.
    Malformed(&'static str),
}

/// Parse the header at the start of `buf`.
pub fn parse_v1(buf: &[u8]) -> Result<ProxyHeader, ParseError> {
    let limit = buf.len().min(MAX_HEADER_LEN);
    let Some(end) = buf[..limit].windows(2).position(|w| w == b"\r\n") else {
        return if buf.len() >= MAX_HEADER_LEN {
            Err(ParseError::Malformed("no CRLF within 107 bytes"))
        } else {
            Err(ParseError::Incomplete)
        };
    };
    let line = std::str::from_utf8(&buf[..end]).map_err(|_| ParseError::Malformed("not ASCII"))?;
    let len = end + 2;

    let mut fields = line.split(' ');
    if fields.next() != Some("PROXY") {
        return Err(ParseError::Malformed("does not start with PROXY"));
    }
    match fields.next() {
        Some("UNKNOWN") => return Ok(ProxyHeader { source: None, len }),
        Some("TCP4") | Some("TCP6") => {}
        _ => return Err(ParseError::Malformed("unknown protocol family")),
    }
    let src_ip: IpAddr = fields
        .next()
        .and_then(|s| s.parse().ok())
        .ok_or(ParseError::Malformed("bad source address"))?;
    let _dst_ip: IpAddr = fields
        .next()
        .and_then(|s| s.parse().ok())
        .ok_or(ParseError::Malformed("bad destination address"))?;
    let src_port: u16 = fields
        .next()
        .and_then(|s| s.parse().ok())
        .ok_or(ParseError::Malformed("bad source port"))?;
    let _dst_port: u16 = fields
        .next()
        .and_then(|s| s.parse().ok())
        .ok_or(ParseError::Malformed("bad destination port"))?;
    if fields.next().is_some() {
        return Err(ParseError::Malformed("trailing fields"));
    }
    Ok(ProxyHeader {
        source: Some(SocketAddr::new(src_ip, src_port)),
        len,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_nginx_tcp4_header() {
        let buf = b"PROXY TCP4 172.70.204.71 10.171.150.102 60498 443\r\n\x16\x03\x01";
        let header = parse_v1(buf).unwrap();
        assert_eq!(header.source, Some("172.70.204.71:60498".parse().unwrap()));
        // Exactly the header, so the TLS ClientHello that follows is untouched.
        assert_eq!(&buf[header.len..], b"\x16\x03\x01");
    }

    #[test]
    fn parses_tcp6_and_unknown() {
        let v6 = parse_v1(b"PROXY TCP6 2606:4700::1 ::1 1234 443\r\n").unwrap();
        assert_eq!(v6.source, Some("[2606:4700::1]:1234".parse().unwrap()));
        let unknown = parse_v1(b"PROXY UNKNOWN\r\n").unwrap();
        assert_eq!(unknown.source, None);
        assert_eq!(unknown.len, 15);
    }

    #[test]
    fn asks_for_more_bytes_until_the_line_ends() {
        assert_eq!(
            parse_v1(b"PROXY TCP4 1.2.3.4").unwrap_err(),
            ParseError::Incomplete
        );
        assert_eq!(parse_v1(b"").unwrap_err(), ParseError::Incomplete);
    }

    #[test]
    fn rejects_anything_that_is_not_a_proxy_header() {
        // A raw TLS ClientHello: the proxy is not in front of us after all.
        assert!(matches!(
            parse_v1(&[0x16, 0x03, 0x01, 0x02, 0x00, b'\r', b'\n']),
            Err(ParseError::Malformed(_))
        ));
        assert!(matches!(
            parse_v1(b"PROXY TCP4 nope 1.2.3.4 1 2\r\n"),
            Err(ParseError::Malformed(_))
        ));
        assert!(matches!(
            parse_v1(b"PROXY TCP4 1.2.3.4 5.6.7.8 1 2 extra\r\n"),
            Err(ParseError::Malformed(_))
        ));
        let too_long = [b'P'; 110];
        assert!(matches!(parse_v1(&too_long), Err(ParseError::Malformed(_))));
    }
}
