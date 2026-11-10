//! "Sleep mode": while a server is stopped to save memory and power, Blockyard listens on its port,
//! shows a "sleeping" message in the server list and starts the real server when an allowed player
//! tries to join. Only a few bytes are ever read from strangers, with tight size and time limits.
use crate::protocol::{self, read_packet, write_packet};
use crate::Result;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Semaphore};

/// What happens when someone tries to join: Ok = wake up, Err(message) = turn them away.
pub type Decide = Arc<dyn Fn(&str) -> std::result::Result<(), String> + Send + Sync>;

pub struct WakeListener {
    stop: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
    pub port: u16,
}

pub struct WakeOpts {
    pub port: u16,
    pub motd: String,
    pub decide: Decide,
    /// Called (once) with the player's name when the server should start.
    pub on_wake: Arc<dyn Fn(String) + Send + Sync>,
}

impl WakeListener {
    pub async fn start(o: WakeOpts) -> Result<WakeListener> {
        // IPv4 always; IPv6 too where the computer has it, so IPv6 friends can wake it as well.
        let listener = TcpListener::bind(("0.0.0.0", o.port)).await
            .map_err(|e| anyhow::anyhow!("Couldn't listen on port {} for sleep mode ({e}).", o.port))?;
        let port = listener.local_addr()?.port();
        let v6 = bind_v6_only(port);
        let (tx, mut rx) = oneshot::channel::<()>();
        let limit = Arc::new(Semaphore::new(8));
        let o = Arc::new(o);
        let woke = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut rx => break,
                    a = listener.accept() => {
                        let Ok((sock, _)) = a else { continue };
                        let Ok(permit) = limit.clone().try_acquire_owned() else { continue }; // busy: drop the connection
                        let (o, woke) = (o.clone(), woke.clone());
                        tokio::spawn(async move {
                            let _ = tokio::time::timeout(Duration::from_secs(5), serve(sock, &o, &woke)).await;
                            drop(permit);
                        });
                    }
                    a = accept_opt(&v6) => {
                        let Ok((sock, _)) = a else { continue };
                        let Ok(permit) = limit.clone().try_acquire_owned() else { continue }; // busy: drop the connection
                        let (o, woke) = (o.clone(), woke.clone());
                        tokio::spawn(async move {
                            let _ = tokio::time::timeout(Duration::from_secs(5), serve(sock, &o, &woke)).await;
                            drop(permit);
                        });
                    }
                }
            }
        });
        Ok(WakeListener { stop: Some(tx), task, port })
    }

    /// Stop listening and free the port (waits until it's released).
    pub async fn close(mut self) {
        if let Some(tx) = self.stop.take() { let _ = tx.send(()); }
        let _ = (&mut self.task).await;
    }
}

impl Drop for WakeListener {
    fn drop(&mut self) {
        if let Some(tx) = self.stop.take() { let _ = tx.send(()); }
    }
}

/// An IPv6-only listener on the same port (none if the computer has no IPv6).
fn bind_v6_only(port: u16) -> Option<TcpListener> {
    let s = tokio::net::TcpSocket::new_v6().ok()?;
    set_v6_only(&s);
    s.bind(std::net::SocketAddr::from((std::net::Ipv6Addr::UNSPECIFIED, port))).ok()?;
    s.listen(16).ok()
}

#[cfg(unix)]
fn set_v6_only(s: &tokio::net::TcpSocket) {
    use std::os::fd::AsRawFd;
    let on: libc::c_int = 1;
    unsafe { libc::setsockopt(s.as_raw_fd(), libc::IPPROTO_IPV6, libc::IPV6_V6ONLY, &on as *const _ as *const libc::c_void, std::mem::size_of::<libc::c_int>() as libc::socklen_t); }
}
#[cfg(windows)]
fn set_v6_only(_s: &tokio::net::TcpSocket) {} // IPv6 sockets are IPv6-only by default on Windows

async fn accept_opt(l: &Option<TcpListener>) -> std::io::Result<(TcpStream, std::net::SocketAddr)> {
    match l { Some(l) => l.accept().await, None => std::future::pending().await }
}

async fn serve(mut s: TcpStream, o: &WakeOpts, woke: &std::sync::atomic::AtomicBool) -> Result<()> {
    let mut first = [0u8; 1];
    if s.peek(&mut first).await? == 0 || first[0] == 0xfe { return Ok(()); } // legacy (pre-1.7) ping: just close
    let (id, p) = read_packet(&mut s).await?;
    if id != 0 { return Ok(()); }
    let hs = protocol::parse_handshake(&p)?;
    match hs.next {
        1 => {
            let (id, _) = read_packet(&mut s).await?;
            if id != 0 { return Ok(()); }
            let status = json!({
                "version": { "name": "Blockyard (sleeping)", "protocol": hs.protocol },
                "players": { "max": 0, "online": 0 },
                "description": { "text": o.motd },
            });
            let mut out = vec![];
            protocol::write_string(&mut out, &status.to_string());
            write_packet(&mut s, 0, &out).await?;
            if let Ok((1, ping)) = read_packet(&mut s).await { write_packet(&mut s, 1, &ping).await?; }
        }
        2 | 3 => {
            let (id, p) = read_packet(&mut s).await?;
            if id != 0 { return Ok(()); }
            let mut pos = 0;
            let name = protocol::read_string(&p, &mut pos)?.chars().take(17).collect::<String>();
            let msg = match (o.decide)(&name) {
                Ok(()) => {
                    if !woke.swap(true, std::sync::atomic::Ordering::SeqCst) { (o.on_wake)(name.clone()); }
                    "The server was asleep and is starting now. Join again in about a minute!".to_string()
                }
                Err(m) => m,
            };
            let mut out = vec![];
            protocol::write_string(&mut out, &protocol::text_component(&msg));
            write_packet(&mut s, 0, &out).await?;
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[tokio::test]
    async fn answers_status_and_wakes_only_allowed_players() {
        let woken: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
        let w = woken.clone();
        let l = WakeListener::start(WakeOpts {
            port: 0, motd: "💤 Sleeping. Join to wake it up".into(),
            decide: Arc::new(|n: &str| if n == "Steve" || n == "Alex" { Ok(()) } else { Err("You're not on this server's whitelist.".into()) }),
            on_wake: Arc::new(move |n| w.lock().unwrap().push(n)),
        }).await.unwrap();
        let port = l.port;
        let st = protocol::status("127.0.0.1", port, Duration::from_secs(3)).await.unwrap();
        assert_eq!(st["description"]["text"], "💤 Sleeping. Join to wake it up");
        assert_eq!(st["version"]["protocol"], 769);
        // IPv6 friends get the same answer (where this machine has IPv6 at all).
        if std::net::TcpListener::bind("[::1]:0").is_ok() {
            let st6 = protocol::status("::1", port, Duration::from_secs(3)).await.unwrap();
            assert_eq!(st6["description"]["text"], "💤 Sleeping. Join to wake it up");
        }
        let msg = protocol::login_attempt("127.0.0.1", port, "Griefer", Duration::from_secs(3)).await.unwrap();
        assert!(msg.contains("whitelist"));
        assert!(woken.lock().unwrap().is_empty());
        let msg = protocol::login_attempt("127.0.0.1", port, "Steve", Duration::from_secs(3)).await.unwrap();
        assert!(msg.contains("starting"));
        protocol::login_attempt("127.0.0.1", port, "Alex", Duration::from_secs(3)).await.unwrap();
        assert_eq!(*woken.lock().unwrap(), vec!["Steve".to_string()], "wakes once");
        // Garbage and oversized packets are dropped without crashing the listener.
        use tokio::io::AsyncWriteExt;
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(&[0xff, 0xff, 0xff, 0xff, 0x07]).await.unwrap();
        drop(s);
        assert!(protocol::status("127.0.0.1", port, Duration::from_secs(3)).await.is_ok());
        l.close().await;
        assert!(crate::instance::port_free(port).await, "port is released after close");
    }
}
