//! What the engine needs from whoever is hosting it (the desktop app, or a test).
use futures_util::future::BoxFuture;
use serde_json::Value;

/// A question for the user, shown as a native dialog by the app.
#[derive(Debug, Clone)]
pub struct Ask {
    pub kind: &'static str, // "question" | "warning" | "info"
    pub message: String,
    pub detail: String,
    pub buttons: Vec<String>,
}

impl Ask {
    pub fn new(kind: &'static str, message: impl Into<String>, detail: impl Into<String>, buttons: &[&str]) -> Self {
        Ask { kind, message: message.into(), detail: detail.into(), buttons: buttons.iter().map(|s| s.to_string()).collect() }
    }
}

pub trait Host: Send + Sync + 'static {
    /// Push an event to the UI (channel names match the old Electron events, e.g. "server:line").
    fn emit(&self, event: &str, payload: Value);
    /// A system notification. `always` = show even when the window is focused.
    fn notify(&self, title: &str, body: &str, always: bool);
    /// Ask the user something; resolves to the index of the chosen button.
    fn ask(&self, ask: Ask) -> BoxFuture<'static, usize>;
    /// Open a URL in the browser (only ever https URLs).
    fn open_url(&self, _url: &str) {}
    /// Something changed that the tray / menu bar icon shows.
    fn tray_changed(&self) {}
}

/// A host that does nothing and answers every question with the first button. Used by tests.
pub struct NullHost;
impl Host for NullHost {
    fn emit(&self, _event: &str, _payload: Value) {}
    fn notify(&self, _title: &str, _body: &str, _always: bool) {}
    fn ask(&self, _ask: Ask) -> BoxFuture<'static, usize> { Box::pin(async { 0 }) }
}
