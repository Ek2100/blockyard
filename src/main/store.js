// Persists the list of servers and app settings as JSON in the app's data folder.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let base = null;
let data = null;

function init(dir) { base = dir; data = null; }
function file() { return path.join(base, 'servers.json'); }

function load() {
  if (!data) {
    try { data = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { data = {}; }
    data.servers ||= [];
    data.settings = { keepAwake: true, ...(data.settings || {}) };
  }
  return data;
}
function save() {
  fs.mkdirSync(base, { recursive: true });
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file());
}

const listServers = () => load().servers;
const getServer = id => load().servers.find(s => s.id === id) || null;

function addServer(cfg) {
  const s = { id: crypto.randomUUID(), createdAt: Date.now(), ...cfg };
  load().servers.push(s);
  save();
  return s;
}
function updateServer(id, patch) {
  const s = getServer(id);
  if (!s) throw new Error('Unknown server');
  Object.assign(s, patch, { id });
  save();
  return s;
}
function removeServer(id) {
  load().servers = load().servers.filter(s => s.id !== id);
  save();
}
const getSettings = () => load().settings;
function setSettings(patch) { Object.assign(load().settings, patch); save(); return load().settings; }

module.exports = { init, listServers, getServer, addServer, updateServer, removeServer, getSettings, setSettings };
