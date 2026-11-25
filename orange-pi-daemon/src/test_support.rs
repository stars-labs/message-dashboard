// An in-process stand-in for the Worker. Each test serves its own scripted answers
// on a random loopback port, so no test depends on what else listens on the
// machine, and no server task outlives the test.
use anyhow::{bail, Context};
use std::{future::Future, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

const HEADER_LIMIT: usize = 8192;

#[derive(Debug)]
pub(crate) struct Request {
    pub(crate) method: String,
    pub(crate) path: String,
    /// Header lines with lowercase names, as `name: value`.
    pub(crate) headers: Vec<String>,
    pub(crate) body: String,
}

impl Request {
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        let prefix = format!("{name}: ");
        self.headers
            .iter()
            .find_map(|line| line.strip_prefix(prefix.as_str()))
    }
}

/// Answers the next requests with `replies` in order (`"200 OK"`, body), one
/// connection each, while `call` runs against the server's base URL. Fails if
/// `call` finishes without sending every scripted request.
pub(crate) async fn serve<F, Fut, T>(
    replies: &[(&str, String)],
    call: F,
) -> anyhow::Result<(T, Vec<Request>)>
where
    F: FnOnce(String) -> Fut,
    Fut: Future<Output = T>,
{
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let base_url = format!("http://{}", listener.local_addr()?);
    let server = async {
        let mut requests = Vec::with_capacity(replies.len());
        for (status, body) in replies {
            let (mut stream, _) = listener.accept().await?;
            requests.push(read_request(&mut stream).await?);
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await?;
        }
        anyhow::Ok(requests)
    };
    let (requests, result) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(server, call(base_url))
    })
    .await
    .context("fixture HTTP exchange timed out: a scripted request was never sent")?;
    Ok((result, requests?))
}

async fn read_request(stream: &mut TcpStream) -> anyhow::Result<Request> {
    let mut raw = Vec::new();
    let header_end = loop {
        if let Some(end) = raw.windows(4).position(|window| window == b"\r\n\r\n") {
            break end;
        }
        if raw.len() > HEADER_LIMIT {
            bail!("request headers exceeded {HEADER_LIMIT} bytes");
        }
        read_more(stream, &mut raw).await?;
    };
    let head = String::from_utf8(raw.get(..header_end).context("header end")?.to_vec())?;
    let mut lines = head.split("\r\n");
    let request_line = lines.next().context("empty request")?;
    let mut parts = request_line.split(' ');
    let method = parts.next().context("no method")?.to_string();
    let path = parts.next().context("no path")?.to_string();
    let headers: Vec<String> = lines
        .map(|line| match line.split_once(": ") {
            Some((name, value)) => format!("{}: {value}", name.to_ascii_lowercase()),
            None => line.to_ascii_lowercase(),
        })
        .collect();
    let length: usize = headers
        .iter()
        .find_map(|line| line.strip_prefix("content-length: "))
        .map_or(Ok(0), str::parse)?;
    let body_start = header_end + 4;
    while raw.len() < body_start + length {
        read_more(stream, &mut raw).await?;
    }
    let body = String::from_utf8(
        raw.get(body_start..body_start + length)
            .context("body")?
            .to_vec(),
    )?;
    Ok(Request {
        method,
        path,
        headers,
        body,
    })
}

async fn read_more(stream: &mut TcpStream, raw: &mut Vec<u8>) -> anyhow::Result<()> {
    let mut chunk = [0; 4096];
    let count = stream.read(&mut chunk).await?;
    if count == 0 {
        bail!("connection closed mid-request");
    }
    raw.extend_from_slice(chunk.get(..count).context("read past the buffer")?);
    Ok(())
}
