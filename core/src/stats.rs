//! Server statistics: a rolling in-memory time series for charts, plus persistent per-server records
//! (players ever seen with playtime, peak player count, starts, crashes, total uptime).
use crate::now_ms;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Mutex;

pub const SAMPLE_MS: u64 = 10_000;
const KEEP_MS: i64 = 6 * 3_600_000;

pub struct Stats {
    dir: PathBuf,
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    series: HashMap<String, VecDeque<Value>>,
    records: HashMap<String, Value>,
    open: HashMap<String, HashMap<String, i64>>,
    dirty: std::collections::HashSet<String>,
}

fn blank() -> Value { json!({ "players": {}, "peak": { "count": 0, "at": null }, "starts": 0, "crashes": 0, "uptimeMs": 0 }) }

impl Stats {
    pub fn new(dir: PathBuf) -> Stats { Stats { dir, inner: Mutex::new(Inner::default()) } }

    fn file(&self, id: &str) -> PathBuf { self.dir.join(format!("{id}.json")) }

    fn record<'a>(&self, i: &'a mut Inner, id: &str) -> &'a mut Value {
        if !i.records.contains_key(id) {
            let mut r = blank();
            if let Some(saved) = std::fs::read_to_string(self.file(id)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
                if let (Some(o), Some(s)) = (r.as_object_mut(), saved.as_object()) { for (k, v) in s { o.insert(k.clone(), v.clone()); } }
            }
            i.records.insert(id.to_string(), r);
        }
        i.records.get_mut(id).unwrap()
    }

    fn write(&self, id: &str, r: &Value) {
        let _ = std::fs::create_dir_all(&self.dir);
        let tmp = self.file(id).with_extension("json.tmp");
        if std::fs::write(&tmp, r.to_string()).is_ok() { let _ = std::fs::rename(&tmp, self.file(id)); }
    }

    /// Save everything that changed (called every few seconds and on quit).
    pub fn flush(&self) {
        let pending: Vec<(String, Value)> = {
            let mut i = self.inner.lock().unwrap();
            let ids: Vec<String> = i.dirty.drain().collect();
            ids.into_iter().filter_map(|id| i.records.get(&id).map(|r| (id.clone(), r.clone()))).collect()
        };
        for (id, r) in pending { self.write(&id, &r); }
    }

    pub fn add_point(&self, id: &str, tps: Option<f64>, mspt: Option<f64>, cpu: f64, mem: u64, players: usize) {
        let mut i = self.inner.lock().unwrap();
        let now = now_ms();
        let s = i.series.entry(id.to_string()).or_default();
        s.push_back(json!({ "t": now, "tps": tps, "mspt": mspt, "cpu": cpu, "mem": mem, "players": players }));
        while s.front().is_some_and(|p| p["t"].as_i64().unwrap_or(0) < now - KEEP_MS) { s.pop_front(); }
        let r = self.record(&mut i, id);
        if players as i64 > r["peak"]["count"].as_i64().unwrap_or(0) {
            r["peak"] = json!({ "count": players, "at": now });
            i.dirty.insert(id.to_string());
        }
    }

    pub fn on_start(&self, id: &str) {
        let mut i = self.inner.lock().unwrap();
        let r = self.record(&mut i, id);
        r["starts"] = json!(r["starts"].as_i64().unwrap_or(0) + 1);
        i.open.insert(id.to_string(), HashMap::new());
        i.dirty.insert(id.to_string());
    }

    pub fn on_join(&self, id: &str, name: &str, uuid: Option<&str>) {
        let mut i = self.inner.lock().unwrap();
        let now = now_ms();
        let r = self.record(&mut i, id);
        let p = r["players"].as_object_mut().unwrap().entry(name.to_string())
            .or_insert_with(|| json!({ "name": name, "uuid": null, "firstSeen": now, "lastSeen": null, "playtimeMs": 0, "sessions": 0 }));
        if let Some(u) = uuid { p["uuid"] = json!(u); }
        p["sessions"] = json!(p["sessions"].as_i64().unwrap_or(0) + 1);
        p["lastSeen"] = json!(now);
        i.open.entry(id.to_string()).or_default().insert(name.to_string(), now);
        i.dirty.insert(id.to_string());
    }

    pub fn on_leave(&self, id: &str, name: &str) {
        let mut i = self.inner.lock().unwrap();
        self.leave(&mut i, id, name);
    }

    fn leave(&self, i: &mut Inner, id: &str, name: &str) {
        let now = now_ms();
        let joined = i.open.get_mut(id).and_then(|m| m.remove(name));
        let r = self.record(i, id);
        if let Some(p) = r["players"].get_mut(name) {
            if let Some(j) = joined { p["playtimeMs"] = json!(p["playtimeMs"].as_i64().unwrap_or(0) + now - j); }
            p["lastSeen"] = json!(now);
        }
        i.dirty.insert(id.to_string());
    }

    /// Server stopped: close every open session and add the run to total uptime.
    pub fn on_stop(&self, id: &str, started_at: Option<i64>, crashed: bool) {
        {
            let mut i = self.inner.lock().unwrap();
            let names: Vec<String> = i.open.get(id).map(|m| m.keys().cloned().collect()).unwrap_or_default();
            for n in names { self.leave(&mut i, id, &n); }
            let r = self.record(&mut i, id);
            if let Some(s) = started_at { r["uptimeMs"] = json!(r["uptimeMs"].as_i64().unwrap_or(0) + now_ms() - s); }
            if crashed { r["crashes"] = json!(r["crashes"].as_i64().unwrap_or(0) + 1); }
            i.dirty.insert(id.to_string());
        }
        self.flush();
    }

    /// Everything the Stats tab needs. `online` = names online now (for live playtime).
    pub fn summary(&self, id: &str, online: &[String]) -> Value {
        let mut i = self.inner.lock().unwrap();
        let now = now_ms();
        let open = i.open.get(id).cloned().unwrap_or_default();
        let series: Vec<Value> = i.series.get(id).map(|s| s.iter().cloned().collect()).unwrap_or_default();
        let r = self.record(&mut i, id).clone();
        let mut players: Vec<Value> = r["players"].as_object().map(|o| o.values().cloned().collect()).unwrap_or_default();
        for p in players.iter_mut() {
            let name = p["name"].as_str().unwrap_or("").to_string();
            let is_on = online.contains(&name);
            let live = if is_on { open.get(&name).map(|j| now - j).unwrap_or(0) } else { 0 };
            p["playtimeMs"] = json!(p["playtimeMs"].as_i64().unwrap_or(0) + live);
            p["online"] = json!(is_on);
        }
        players.sort_by(|a, b| b["online"].as_bool().cmp(&a["online"].as_bool()).then(b["lastSeen"].as_i64().unwrap_or(0).cmp(&a["lastSeen"].as_i64().unwrap_or(0))));
        json!({ "peak": r["peak"], "starts": r["starts"], "crashes": r["crashes"], "uptimeMs": r["uptimeMs"], "players": players, "series": series })
    }

    pub fn forget(&self, id: &str) {
        let mut i = self.inner.lock().unwrap();
        i.records.remove(id); i.series.remove(id); i.open.remove(id); i.dirty.remove(id);
        let _ = std::fs::remove_file(self.file(id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sessions_playtime_peak_uptime_crashes() {
        let d = tempfile::tempdir().unwrap();
        let s = Stats::new(d.path().to_path_buf());
        s.on_start("a");
        let t0 = now_ms();
        s.on_join("a", "Steve", Some("u1"));
        s.add_point("a", Some(20.0), Some(3.0), 12.0, 900, 1);
        std::thread::sleep(std::time::Duration::from_millis(30));
        let live = s.summary("a", &["Steve".into()]);
        assert!(live["players"][0]["playtimeMs"].as_i64().unwrap() >= 25);
        assert_eq!(live["players"][0]["online"], true);
        s.on_stop("a", Some(t0 - 1000), true);
        let s2 = Stats::new(d.path().to_path_buf());
        let r = s2.summary("a", &[]);
        assert_eq!(r["starts"], 1);
        assert_eq!(r["crashes"], 1);
        assert_eq!(r["peak"]["count"], 1);
        assert!(r["uptimeMs"].as_i64().unwrap() >= 1000);
        assert_eq!(r["players"][0]["sessions"], 1);
        assert_eq!(r["players"][0]["uuid"], "u1");
        assert!(r["players"][0]["playtimeMs"].as_i64().unwrap() >= 25);
        s2.forget("a");
        assert!(!d.path().join("a.json").exists());
    }
}
