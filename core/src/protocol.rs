//! Just enough of the Minecraft Java protocol to answer the server list and turn players away politely
//! while a server sleeps, plus matching client helpers (used by tests and the "is it up?" check).
use crate::Result;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const MAX_PACKET: usize = 4096;

pub fn write_varint(out: &mut Vec<u8>, mut v: i32) {
    loop {
        let mut b = (v & 0x7f) as u8;
        v = ((v as u32) >> 7) as i32;
        if v != 0 { b |= 0x80; }
        out.push(b);
        if v == 0 { break; }
    }
}

pub fn read_varint_slice(b: &[u8], pos: &mut usize) -> Result<i32> {
    let mut v: u32 = 0;
    for i in 0..5 {
        let Some(&byte) = b.get(*pos) else { crate::bail!("short varint") };
        *pos += 1;
        v |= ((byte & 0x7f) as u32) << (7 * i);
        if byte & 0x80 == 0 { return Ok(v as i32); }
    }
    crate::bail!("varint too long")
}

async fn read_varint<R: AsyncRead + Unpin>(r: &mut R) -> Result<i32> {
    let mut v: u32 = 0;
    for i in 0..5 {
        let byte = r.read_u8().await?;
        v |= ((byte & 0x7f) as u32) << (7 * i);
        if byte & 0x80 == 0 { return Ok(v as i32); }
    }
    crate::bail!("varint too long")
}

pub fn write_string(out: &mut Vec<u8>, s: &str) { write_varint(out, s.len() as i32); out.extend_from_slice(s.as_bytes()); }

pub fn read_string(b: &[u8], pos: &mut usize) -> Result<String> {
    let n = read_varint_slice(b, pos)?;
    if n < 0 || *pos + n as usize > b.len() { crate::bail!("bad string") }
    let s = String::from_utf8_lossy(&b[*pos..*pos + n as usize]).into_owned();
    *pos += n as usize;
    Ok(s)
}

/// Read one length-prefixed packet: (id, payload). Refuses packets over MAX_PACKET.
pub async fn read_packet<R: AsyncRead + Unpin>(r: &mut R) -> Result<(i32, Vec<u8>)> {
    let len = read_varint(r).await?;
    if len <= 0 || len as usize > MAX_PACKET { crate::bail!("bad packet length {len}") }
    let mut buf = vec![0u8; len as usize];
    r.read_exact(&mut buf).await?;
    let mut pos = 0;
    let id = read_varint_slice(&buf, &mut pos)?;
    Ok((id, buf[pos..].to_vec()))
}

pub async fn write_packet<W: AsyncWrite + Unpin>(w: &mut W, id: i32, payload: &[u8]) -> Result<()> {
    let mut body = vec![];
    write_varint(&mut body, id);
    body.extend_from_slice(payload);
    let mut out = vec![];
    write_varint(&mut out, body.len() as i32);
    out.extend(body);
    w.write_all(&out).await?;
    w.flush().await?;
    Ok(())
}

#[derive(Debug, Clone)]
pub struct Handshake { pub protocol: i32, pub host: String, pub port: u16, pub next: i32 }

pub fn parse_handshake(p: &[u8]) -> Result<Handshake> {
    let mut pos = 0;
    let protocol = read_varint_slice(p, &mut pos)?;
    let host = read_string(p, &mut pos)?;
    if pos + 2 > p.len() { crate::bail!("short handshake") }
    let port = u16::from_be_bytes([p[pos], p[pos + 1]]);
    pos += 2;
    let next = read_varint_slice(p, &mut pos)?;
    Ok(Handshake { protocol, host, port, next })
}

pub fn handshake_payload(protocol: i32, host: &str, port: u16, next: i32) -> Vec<u8> {
    let mut p = vec![];
    write_varint(&mut p, protocol);
    write_string(&mut p, host);
    p.extend_from_slice(&port.to_be_bytes());
    write_varint(&mut p, next);
    p
}

/// Client: the server list entry (status JSON) of host:port.
pub async fn status(host: &str, port: u16, timeout: Duration) -> Result<Value> {
    tokio::time::timeout(timeout, async {
        let mut s = tokio::net::TcpStream::connect((host, port)).await?;
        write_packet(&mut s, 0, &handshake_payload(769, host, port, 1)).await?;
        write_packet(&mut s, 0, &[]).await?;
        let (id, p) = read_packet_big(&mut s).await?;
        if id != 0 { crate::bail!("unexpected status packet {id}") }
        let mut pos = 0;
        let json = read_string(&p, &mut pos)?;
        Ok(serde_json::from_str(&json)?)
    }).await.map_err(|_| anyhow::anyhow!("timed out"))?
}

/// Like read_packet but allows big status answers (server icons).
async fn read_packet_big<R: AsyncRead + Unpin>(r: &mut R) -> Result<(i32, Vec<u8>)> {
    let len = read_varint(r).await?;
    if len <= 0 || len > 1 << 21 { crate::bail!("bad packet length") }
    let mut buf = vec![0u8; len as usize];
    r.read_exact(&mut buf).await?;
    let mut pos = 0;
    let id = read_varint_slice(&buf, &mut pos)?;
    Ok((id, buf[pos..].to_vec()))
}

/// Client: try to log in as `name`; returns the disconnect message the server sends.
pub async fn login_attempt(host: &str, port: u16, name: &str, timeout: Duration) -> Result<String> {
    tokio::time::timeout(timeout, async {
        let mut s = tokio::net::TcpStream::connect((host, port)).await?;
        write_packet(&mut s, 0, &handshake_payload(769, host, port, 2)).await?;
        let mut p = vec![];
        write_string(&mut p, name);
        p.extend_from_slice(&[0u8; 16]); // player UUID (1.20.2+)
        write_packet(&mut s, 0, &p).await?;
        let (id, body) = read_packet_big(&mut s).await?;
        if id != 0 { crate::bail!("not a disconnect ({id})") }
        let mut pos = 0;
        let text = read_string(&body, &mut pos)?;
        Ok(serde_json::from_str::<Value>(&text).ok().and_then(|v| v["text"].as_str().map(String::from)).unwrap_or(text))
    }).await.map_err(|_| anyhow::anyhow!("timed out"))?
}

pub fn text_component(s: &str) -> String { json!({ "text": s }).to_string() }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn varints() {
        for (v, bytes) in [(0, vec![0u8]), (1, vec![1]), (127, vec![0x7f]), (128, vec![0x80, 1]), (25565, vec![0xdd, 0xc7, 1]), (-1, vec![0xff, 0xff, 0xff, 0xff, 0x0f])] {
            let mut out = vec![];
            write_varint(&mut out, v);
            assert_eq!(out, bytes);
            let mut pos = 0;
            assert_eq!(read_varint_slice(&out, &mut pos).unwrap(), v);
        }
        let h = parse_handshake(&handshake_payload(769, "play.example.com", 25565, 2)).unwrap();
        assert_eq!((h.protocol, h.host.as_str(), h.port, h.next), (769, "play.example.com", 25565, 2));
        assert!(parse_handshake(&[1, 2]).is_err());
    }
}
