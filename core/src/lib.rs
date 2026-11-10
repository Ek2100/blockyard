//! Blockyard's engine: creating, running and sharing Minecraft servers.
//!
//! Nothing in here knows about windows, menus or web views. The desktop app (and the test bridge)
//! talk to it through [`Core::call`], one channel name plus JSON arguments, and receive events and
//! questions through the [`Host`] trait.

pub mod archive;
pub mod backups;
pub mod core;
pub mod files;
pub mod geyser;
pub mod host;
pub mod installer;
pub mod instance;
pub mod java;
pub mod modrinth;
pub mod mrpack;
pub mod nbt;
pub mod net;
pub mod paths;
pub mod playit;
pub mod portmap;
pub mod proc;
pub mod props;
pub mod protocol;
pub mod providers;
pub mod stats;
pub mod store;
pub mod updates;
pub mod versions;
pub mod wake;
pub mod worlds;

pub use crate::core::{Core, CoreOpts};
pub use host::{Ask, Host, NullHost};

pub type Result<T, E = anyhow::Error> = std::result::Result<T, E>;

/// Return early with a plain, user-facing message.
#[macro_export]
macro_rules! bail {
    ($($t:tt)*) => { return Err(anyhow::anyhow!($($t)*)) };
}

/// Milliseconds since the Unix epoch, the time format the UI uses everywhere.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}
