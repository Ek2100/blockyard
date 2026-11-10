//! The list of servers and app settings, saved as JSON in the app's data folder.
//! Server records are kept as JSON objects so the UI can add settings without schema changes.
use crate::Result;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct Store {
    file: PathBuf,
    data: Mutex<Value>,
}

fn obj(v: &Value) -> Map<String, Value> { v.as_object().cloned().unwrap_or_default() }

impl Store {
    pub fn open(dir: &Path) -> Store {
        let file = dir.join("servers.json");
        let mut data: Value = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| json!({}));
        if !data.is_object() { data = json!({}); }
        if !data["servers"].is_array() { data["servers"] = json!([]); }
        let mut settings = obj(&json!({ "keepAwake": true }));
        settings.extend(obj(&data["settings"]));
        data["settings"] = Value::Object(settings);
        Store { file, data: Mutex::new(data) }
    }

    fn save(&self, data: &Value) -> Result<()> {
        if let Some(p) = self.file.parent() { std::fs::create_dir_all(p)?; }
        let tmp = self.file.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(data)?)?;
        std::fs::rename(&tmp, &self.file)?;
        Ok(())
    }

    pub fn list(&self) -> Vec<Value> { self.data.lock().unwrap()["servers"].as_array().cloned().unwrap_or_default() }

    pub fn get(&self, id: &str) -> Option<Value> {
        self.list().into_iter().find(|s| s["id"].as_str() == Some(id))
    }

    pub fn add(&self, cfg: Value) -> Result<Value> {
        let mut s = obj(&json!({ "id": uuid::Uuid::new_v4().to_string(), "createdAt": crate::now_ms() }));
        s.extend(obj(&cfg));
        let s = Value::Object(s);
        let mut d = self.data.lock().unwrap();
        d["servers"].as_array_mut().unwrap().push(s.clone());
        self.save(&d)?;
        Ok(s)
    }

    /// Shallow merge, like `Object.assign`. `null` values are stored as null.
    pub fn update(&self, id: &str, patch: Value) -> Result<Value> {
        let mut d = self.data.lock().unwrap();
        let servers = d["servers"].as_array_mut().unwrap();
        let Some(s) = servers.iter_mut().find(|s| s["id"].as_str() == Some(id)) else { crate::bail!("Unknown server") };
        if let (Some(o), Some(p)) = (s.as_object_mut(), patch.as_object()) {
            for (k, v) in p { if k != "id" { o.insert(k.clone(), v.clone()); } }
        }
        let out = s.clone();
        self.save(&d)?;
        Ok(out)
    }

    pub fn remove(&self, id: &str) -> Result<()> {
        let mut d = self.data.lock().unwrap();
        d["servers"].as_array_mut().unwrap().retain(|s| s["id"].as_str() != Some(id));
        self.save(&d)
    }

    pub fn settings(&self) -> Value { self.data.lock().unwrap()["settings"].clone() }

    pub fn set_settings(&self, patch: Value) -> Result<Value> {
        let mut d = self.data.lock().unwrap();
        if let (Some(o), Some(p)) = (d["settings"].as_object_mut(), patch.as_object()) {
            for (k, v) in p { o.insert(k.clone(), v.clone()); }
        }
        let out = d["settings"].clone();
        self.save(&d)?;
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persists() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::open(d.path());
        assert_eq!(s.settings()["keepAwake"], true);
        let a = s.add(json!({ "name": "A", "dir": "/x" })).unwrap();
        let id = a["id"].as_str().unwrap().to_string();
        s.update(&id, json!({ "name": "B", "id": "hacked" })).unwrap();
        s.set_settings(json!({ "checkUpdates": false })).unwrap();
        let s2 = Store::open(d.path());
        assert_eq!(s2.get(&id).unwrap()["name"], "B");
        assert_eq!(s2.settings()["checkUpdates"], false);
        assert_eq!(s2.settings()["keepAwake"], true);
        s2.remove(&id).unwrap();
        assert!(Store::open(d.path()).list().is_empty());
    }
}
