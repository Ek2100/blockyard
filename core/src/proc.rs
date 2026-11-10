//! Starting and stopping helper processes the same way on every OS.
use std::ffi::OsStr;

/// A `tokio` command that never flashes a console window on Windows.
pub fn command(program: impl AsRef<OsStr>) -> tokio::process::Command {
    #[allow(unused_mut)]
    let mut c = tokio::process::Command::new(program);
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: console programs (java.exe, tar, playitd) get a hidden console.
        c.creation_flags(0x0800_0000);
    }
    c
}

/// Same for `std::process` (used for quick, blocking calls).
pub fn std_command(program: impl AsRef<OsStr>) -> std::process::Command {
    #[allow(unused_mut)]
    let mut c = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c
}

/// Run a program and return its stdout (empty on any failure). Gives up after `secs`.
pub async fn output(program: &str, args: &[&str], secs: u64) -> String {
    let fut = command(program).args(args).stdin(std::process::Stdio::null()).output();
    match tokio::time::timeout(std::time::Duration::from_secs(secs), fut).await {
        Ok(Ok(o)) => String::from_utf8_lossy(&o.stdout).into_owned() + &String::from_utf8_lossy(&o.stderr),
        _ => String::new(),
    }
}

fn system_for(pid: u32) -> sysinfo::System {
    let mut sys = sysinfo::System::new();
    let p = sysinfo::Pid::from_u32(pid);
    sys.refresh_processes_specifics(sysinfo::ProcessesToUpdate::Some(&[p]), true, sysinfo::ProcessRefreshKind::new().with_cmd(sysinfo::UpdateKind::Always).with_exe(sysinfo::UpdateKind::Always));
    sys
}

pub fn alive(pid: u32) -> bool { system_for(pid).process(sysinfo::Pid::from_u32(pid)).is_some() }

/// The full command line of a process, if it exists.
pub fn command_line(pid: u32) -> Option<String> {
    let sys = system_for(pid);
    let p = sys.process(sysinfo::Pid::from_u32(pid))?;
    let mut parts: Vec<String> = p.cmd().iter().map(|s| s.to_string_lossy().into_owned()).collect();
    if parts.is_empty() {
        parts.push(p.exe().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default());
    }
    Some(parts.join(" "))
}

/// Ask a process to shut down cleanly: SIGTERM on macOS/Linux, Ctrl+C on Windows.
/// Java runs its shutdown hooks for both, so Minecraft saves the world first.
pub fn terminate(pid: u32) -> bool {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGTERM) == 0
    }
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::Console::*;
        // Attach to the server's (hidden) console and send Ctrl+C to it, ignoring it ourselves.
        FreeConsole();
        if AttachConsole(pid) == 0 {
            return false;
        }
        SetConsoleCtrlHandler(None, 1);
        let ok = GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0) != 0;
        // Give the event time to arrive before detaching, then restore normal Ctrl+C handling.
        std::thread::sleep(std::time::Duration::from_millis(500));
        FreeConsole();
        SetConsoleCtrlHandler(None, 0);
        ok
    }
}

/// Stop a process immediately.
pub fn kill(pid: u32) -> bool {
    let sys = system_for(pid);
    sys.process(sysinfo::Pid::from_u32(pid)).map(|p| p.kill()).unwrap_or(false)
}

/// CPU % (of one core) and resident memory in MB for a process. Call regularly with the same `System`.
pub struct Sampler {
    sys: sysinfo::System,
}

impl Default for Sampler {
    fn default() -> Self { Sampler { sys: sysinfo::System::new() } }
}

impl Sampler {
    pub fn sample(&mut self, pid: u32) -> Option<(f64, u64)> {
        let p = sysinfo::Pid::from_u32(pid);
        self.sys.refresh_processes_specifics(sysinfo::ProcessesToUpdate::Some(&[p]), true, sysinfo::ProcessRefreshKind::new().with_cpu().with_memory());
        let pr = self.sys.process(p)?;
        Some((pr.cpu_usage() as f64, pr.memory() / 1_048_576))
    }
}

pub fn total_memory_mb() -> u64 {
    let mut s = sysinfo::System::new();
    s.refresh_memory();
    s.total_memory() / 1_048_576
}

/// Keeps the computer from idle-sleeping while a server runs. Dropping it lets the computer sleep again.
pub struct KeepAwake {
    #[allow(dead_code)]
    child: Option<std::process::Child>,
    #[cfg(windows)]
    stop: Option<std::sync::mpsc::Sender<()>>,
}

impl KeepAwake {
    pub fn start(pid: u32) -> Option<KeepAwake> {
        let _ = pid;
        #[cfg(target_os = "macos")]
        {
            // caffeinate exits by itself when the server process does.
            let child = std_command("caffeinate").args(["-i", "-w", &pid.to_string()]).stdin(std::process::Stdio::null()).spawn().ok();
            return Some(KeepAwake { child });
        }
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::Power::*;
            // The request lasts while the thread that made it is alive, so park a thread on it.
            let (tx, rx) = std::sync::mpsc::channel::<()>();
            std::thread::spawn(move || unsafe {
                SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
                let _ = rx.recv();
                SetThreadExecutionState(ES_CONTINUOUS);
            });
            return Some(KeepAwake { child: None, stop: Some(tx) });
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            let child = std_command("systemd-inhibit")
                .args(["--what=idle:sleep", "--who=Blockyard", "--why=A Minecraft server is running", "--mode=block", "sleep", "infinity"])
                .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
                .spawn().ok()?;
            return Some(KeepAwake { child: Some(child) });
        }
        #[allow(unreachable_code)]
        None
    }
}

impl Drop for KeepAwake {
    fn drop(&mut self) {
        if let Some(c) = self.child.as_mut() { let _ = c.kill(); let _ = c.wait(); }
        #[cfg(windows)]
        if let Some(tx) = self.stop.take() { let _ = tx.send(()); }
    }
}
