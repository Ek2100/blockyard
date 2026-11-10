// Server statistics: a rolling in-memory time series for charts, plus persistent per-server records
// (players ever seen with playtime, peak player count, starts, crashes, total uptime).
const fs = require('fs');
const path = require('path');

const SAMPLE_MS = 10_000;
const KEEP_MS = 6 * 3600_000;

class StatsStore {
  constructor(dir) {
    this.dir = dir;
    this.series = new Map();   // id -> [{ t, tps, mspt, cpu, mem, players }]
    this.records = new Map();  // id -> persisted record
    this.open = new Map();     // id -> Map(name -> joinedAt)
    this.timers = new Map();
  }

  file(id) { return path.join(this.dir, `${id}.json`); }

  record(id) {
    if (!this.records.has(id)) {
      let r = {};
      try { r = JSON.parse(fs.readFileSync(this.file(id), 'utf8')); } catch {}
      this.records.set(id, { players: {}, peak: { count: 0, at: null }, starts: 0, crashes: 0, uptimeMs: 0, ...r });
    }
    return this.records.get(id);
  }

  save(id, now = false) {
    clearTimeout(this.timers.get(id));
    const write = () => {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        const tmp = this.file(id) + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.record(id)));
        fs.renameSync(tmp, this.file(id));
      } catch {}
    };
    if (now) write(); else this.timers.set(id, setTimeout(write, 2000));
  }

  addPoint(id, point) {
    const arr = this.series.get(id) || [];
    arr.push({ t: Date.now(), ...point });
    const cutoff = Date.now() - KEEP_MS;
    while (arr.length && arr[0].t < cutoff) arr.shift();
    this.series.set(id, arr);
    const r = this.record(id);
    if ((point.players || 0) > (r.peak.count || 0)) { r.peak = { count: point.players, at: Date.now() }; this.save(id); }
  }

  getSeries(id, sinceMs = KEEP_MS) {
    const cutoff = Date.now() - sinceMs;
    return (this.series.get(id) || []).filter(p => p.t >= cutoff);
  }

  onStart(id) { this.record(id).starts++; this.save(id); this.open.set(id, new Map()); }

  onJoin(id, name, uuid) {
    const r = this.record(id);
    const p = r.players[name] ||= { name, uuid: null, firstSeen: Date.now(), lastSeen: null, playtimeMs: 0, sessions: 0 };
    if (uuid) p.uuid = uuid;
    p.sessions++;
    p.lastSeen = Date.now();
    if (!this.open.has(id)) this.open.set(id, new Map());
    this.open.get(id).set(name, Date.now());
    this.save(id);
  }

  onLeave(id, name) {
    const joined = this.open.get(id)?.get(name);
    const p = this.record(id).players[name];
    if (p) {
      if (joined) p.playtimeMs += Date.now() - joined;
      p.lastSeen = Date.now();
    }
    this.open.get(id)?.delete(name);
    this.save(id);
  }

  /** Server stopped: close every open session and add the run to total uptime. */
  onStop(id, { startedAt, crashed = false } = {}) {
    for (const name of [...(this.open.get(id)?.keys() || [])]) this.onLeave(id, name);
    const r = this.record(id);
    if (startedAt) r.uptimeMs += Date.now() - startedAt;
    if (crashed) r.crashes++;
    this.save(id, true);
  }

  /** Everything the Stats tab needs. `online` = names online now (for live playtime). */
  summary(id, online = []) {
    const r = this.record(id);
    const openMap = this.open.get(id) || new Map();
    const players = Object.values(r.players).map(p => {
      const live = online.includes(p.name) && openMap.has(p.name) ? Date.now() - openMap.get(p.name) : 0;
      return { ...p, playtimeMs: p.playtimeMs + live, online: online.includes(p.name) };
    }).sort((a, b) => (b.online - a.online) || (b.lastSeen || 0) - (a.lastSeen || 0));
    return { peak: r.peak, starts: r.starts, crashes: r.crashes, uptimeMs: r.uptimeMs, players, series: this.getSeries(id) };
  }

  forget(id) { this.records.delete(id); this.series.delete(id); fs.rmSync(this.file(id), { force: true }); }

  flushAll() { for (const id of this.records.keys()) this.save(id, true); }
}

module.exports = { StatsStore, SAMPLE_MS };
