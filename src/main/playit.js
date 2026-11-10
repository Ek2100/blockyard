// playit.gg integration. Blockyard runs its own copy of playit's daemon (playitd) in the
// foreground with its own secret and socket, then talks to it over playit's local IPC
// protocol (newline-delimited JSON on a Unix socket, IPC version 3).
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const EventEmitter = require('events');
const { download, UA } = require('./net');

const IPC_VERSION = 3;
const API = 'https://api.playit.gg';
const DOWNLOAD_URL = 'https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-macos-universal.tar.gz';

async function api(pathname, body, secret) {
  let res;
  try {
    res = await fetch(API + pathname, {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA, ...(secret ? { Authorization: `Agent-Key ${secret}` } : {}) },
    });
  } catch (e) { throw new Error(`Couldn't reach playit.gg (${e.cause?.code || e.message})`); }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`playit.gg answered HTTP ${res.status}`); }
  return json; // { status: 'success'|'fail'|'error', data }
}

const TUNNEL_ERRORS = {
  RequiresVerifiedAccount: 'playit needs a verified account for this. Open the playit dashboard, verify your email, then try again.',
  AgentNotFound: 'playit doesn’t know this agent yet. Wait a few seconds and try again.',
  AgentVersionTooOld: 'The playit agent is too old. Reinstall it from the Public Access tab.',
  InvalidPortCount: 'playit rejected the port count.',
  RegionNotSupported: 'Your playit plan doesn’t support that region.',
};

class Playit extends EventEmitter {
  constructor(dir, opts = {}) {
    super();
    this.dir = dir;
    this.binDir = path.join(dir, 'bin');
    this.secretPath = path.join(dir, 'playit.toml');
    this.logPath = path.join(dir, 'playitd.log');
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'u';
    this.socketPath = opts.socketPath || path.join(os.tmpdir(), `blockyard-playit-${uid}.sock`);
    this.daemonPath = opts.daemonPath || path.join(this.binDir, 'playitd');
    this.downloadUrl = opts.downloadUrl || DOWNLOAD_URL;
    this.proc = null;
    this.sock = null;
    this.reqId = 1;
    this.pending = new Map();
    this.claim = null; // { code, url, status, cancelled }
    this.state = { phase: 'stopped', lifecycle: null, stats: null, error: null, logs: [] };
  }

  installed() { return fs.existsSync(this.daemonPath); }

  snapshot() {
    const lc = this.state.lifecycle;
    const running = lc?.state === 'running' ? lc.data : null;
    return {
      installed: this.installed(),
      daemon: this.proc ? 'running' : 'stopped',
      phase: this.state.phase,
      lifecycle: lc?.state || null,
      needsLink: lc?.state === 'waiting_for_secret' || lc?.state === 'has_invalid_secret',
      error: this.state.error || (lc && lc.data && lc.data.message) || null,
      agentId: running?.agent_id || null,
      accountStatus: running?.account_status || null,
      loginLink: running?.login_link || null,
      tunnels: (running?.tunnels || []).map(t => ({ id: t.id, address: t.display_address, destination: t.destination, disabled: t.is_disabled, disabledReason: t.disabled_reason })),
      pending: running?.pending_tunnels || [],
      notices: running?.notices || [],
      claim: this.claim ? { url: this.claim.url, status: this.claim.status } : null,
      stats: this.state.stats,
    };
  }

  changed() { this.emit('state', this.snapshot()); }

  log(msg) {
    this.state.logs.push(`${new Date().toLocaleTimeString()} ${msg}`);
    if (this.state.logs.length > 300) this.state.logs.shift();
  }

  async install(progress = () => {}) {
    fs.mkdirSync(this.binDir, { recursive: true });
    const tgz = path.join(this.dir, 'playit.tar.gz');
    progress('Downloading the playit agent…', 0);
    await download(this.downloadUrl, tgz, (got, total) => progress(`Downloading the playit agent… ${(got / 1048576).toFixed(1)} MB`, total ? got / total : null));
    progress('Unpacking…', null);
    const tmp = path.join(this.dir, 'unpack');
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    await new Promise((resolve, reject) => execFile('tar', ['-xzf', tgz, '-C', tmp], err => (err ? reject(new Error('Couldn’t unpack the playit agent: ' + err.message)) : resolve())));
    const find = (dir, name) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { const f = find(p, name); if (f) return f; } else if (e.name === name) return p;
      }
      return null;
    };
    for (const name of ['playitd', 'playit']) {
      const f = find(tmp, name);
      if (!f && name === 'playitd') throw new Error('The playit download didn’t contain playitd.');
      if (f) { fs.copyFileSync(f, path.join(this.binDir, name)); fs.chmodSync(path.join(this.binDir, name), 0o755); }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(tgz, { force: true });
    progress('playit agent installed.', 1);
    this.changed();
  }

  async start() {
    if (this.proc) return;
    if (!this.installed()) throw new Error('Install the playit agent first.');
    try { fs.rmSync(this.socketPath, { force: true }); } catch {}
    const args = ['--secret-path', this.secretPath, '--socket-path', this.socketPath, '--log-path', this.logPath];
    this.log('Starting playitd');
    const proc = spawn(this.daemonPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    this.state.phase = 'starting';
    this.state.error = null;
    const onOut = d => String(d).split('\n').filter(Boolean).forEach(l => this.log(l));
    proc.stdout.on('data', onOut);
    proc.stderr.on('data', onOut);
    proc.on('error', e => { this.state.error = `Couldn't run playitd: ${e.message}`; });
    proc.on('exit', code => {
      this.log(`playitd exited (${code})`);
      this.proc = null;
      this.sock?.destroy();
      this.sock = null;
      this.state.phase = 'stopped';
      if (code && !this.stopping) this.state.error = `playitd stopped unexpectedly (exit ${code}).`;
      this.stopping = false;
      this.changed();
    });
    this.changed();
    // wait for the socket
    for (let i = 0; i < 80; i++) {
      if (!this.proc) throw new Error(this.state.error || 'playitd exited during start-up.');
      try { await this.connect(); break; } catch { await new Promise(r => setTimeout(r, 125)); }
    }
    if (!this.sock) { this.stop(); throw new Error('playitd didn’t open its control socket in time.'); }
    const sub = await this.request({ type: 'subscribe' });
    this.state.lifecycle = sub.snapshot?.lifecycle || null;
    this.state.stats = sub.snapshot?.stats || null;
    this.state.phase = sub.snapshot?.status?.phase || 'running';
    this.changed();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.socketPath);
      let buf = '';
      let hello = false;
      sock.once('error', reject);
      sock.on('data', d => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          if (!hello) {
            hello = true;
            if (msg.message_kind === 'hello') { this.sock = sock; sock.removeListener('error', reject); sock.on('error', () => {}); resolve(); continue; }
            if (msg.message_kind === 'response' && msg.data?.response?.type === 'error') { sock.destroy(); reject(new Error(msg.data.response.data?.message || 'playitd refused the connection')); return; }
          }
          this.onMessage(msg);
        }
      });
      sock.on('close', () => { if (this.sock === sock) this.sock = null; for (const [, p] of this.pending) p.reject(new Error('playitd connection closed')); this.pending.clear(); });
    });
  }

  onMessage(msg) {
    if (msg.message_kind === 'response') {
      const { request_id: id, response } = msg.data || {};
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (response?.type === 'error') p.reject(new Error(response.data?.message || 'playitd error'));
      else p.resolve(response?.data);
    } else if (msg.message_kind === 'event') {
      const ev = msg.data?.event;
      if (!ev) return;
      if (ev.type === 'lifecycle') this.state.lifecycle = ev.data;
      else if (ev.type === 'status') this.state.phase = ev.data?.phase || this.state.phase;
      else if (ev.type === 'stats') { this.state.stats = ev.data; return; }
      else if (ev.type === 'log') { this.log(`${ev.data?.level || ''} ${ev.data?.message || ''}`); return; }
      this.changed();
    }
  }

  request(request, timeout = 10000) {
    if (!this.sock) return Promise.reject(new Error('playit isn’t running.'));
    const id = this.reqId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error('playitd didn’t answer in time.')); }, timeout);
      this.pending.set(id, { resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } });
      this.sock.write(JSON.stringify({ ipc_version: IPC_VERSION, request_id: id, request }) + '\n');
    });
  }

  /**
   * Link this agent to a playit account: open playit.gg/claim/<code>, wait for the user to
   * approve it in the browser, swap the code for a secret and hand that to playitd.
   */
  async link(openUrl, { pollMs = 1500, timeoutMs = 15 * 60e3 } = {}) {
    if (!this.proc) await this.start();
    if (this.claim && this.claim.status !== 'done' && this.claim.status !== 'failed') { openUrl(this.claim.url); return; }
    const code = crypto.randomBytes(5).toString('hex');
    const claim = this.claim = { code, url: `https://playit.gg/claim/${code}`, status: 'waiting_for_visit', cancelled: false };
    this.changed();
    openUrl(claim.url);
    const end = Date.now() + timeoutMs;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    try {
      for (;;) {
        if (claim.cancelled) throw new Error('Linking was cancelled.');
        if (Date.now() > end) throw new Error('Linking timed out. Try again.');
        const r = await api('/claim/setup', { code, agent_type: 'assignable', version: 'Blockyard (playit agent)' }).catch(e => ({ status: 'neterr', data: e.message }));
        if (r.status === 'success') {
          const status = { WaitingForUserVisit: 'waiting_for_visit', WaitingForUser: 'waiting_for_approval', UserAccepted: 'accepted', UserRejected: 'rejected' }[r.data] || 'waiting_for_visit';
          if (status !== claim.status) { claim.status = status; this.changed(); }
          if (status === 'rejected') throw new Error('The link was declined in the browser.');
          if (status === 'accepted') break;
        } else if (r.status === 'fail' && (r.data === 'CodeExpired' || r.data === 'InvalidCode')) throw new Error('The link code expired. Try again.');
        await sleep(pollMs);
      }
      let secret = null;
      while (!secret) {
        if (claim.cancelled) throw new Error('Linking was cancelled.');
        const r = await api('/claim/exchange', { code }).catch(() => ({}));
        if (r.status === 'success' && r.data?.secret_key) secret = r.data.secret_key;
        else if (r.status === 'fail' && ['UserRejected', 'CodeExpired', 'CodeNotFound'].includes(r.data)) throw new Error(`playit: ${r.data}`);
        else if (Date.now() > end) throw new Error('Linking timed out. Try again.');
        else await sleep(pollMs);
      }
      const res = await this.request({ type: 'set_secret', secret });
      if (res && res.accepted === false) throw new Error(res.message || 'playitd didn’t accept the new key.');
      claim.status = 'done';
      this.changed();
    } catch (e) {
      claim.status = 'failed';
      this.state.error = e.message;
      this.changed();
      throw e;
    }
  }

  cancelLink() { if (this.claim) { this.claim.cancelled = true; this.claim.status = 'failed'; this.changed(); } }

  secret() {
    try {
      const txt = fs.readFileSync(this.secretPath, 'utf8');
      return txt.match(/secret_key\s*=\s*"([^"]+)"/)?.[1] || (/^[0-9a-f]+$/i.test(txt.trim()) ? txt.trim() : null);
    } catch { return null; }
  }

  tunnelForPort(port) {
    return this.snapshot().tunnels.find(t => new RegExp(`:${port}\\b`).test(t.destination)) || null;
  }

  /** Create a Minecraft tunnel to 127.0.0.1:<port>: Java (TCP) by default, or Bedrock (UDP) for Geyser. */
  async createTunnel({ name, port, bedrock = false }) {
    const snap = this.snapshot();
    if (!snap.agentId) throw new Error('Link playit first (the agent isn’t connected yet).');
    const existing = this.tunnelForPort(port);
    if (existing) return existing;
    const secret = this.secret();
    if (!secret) throw new Error('playit has no key yet. Link your account first.');
    const r = await api('/tunnels/create', {
      name: (String(name).replace(/[^\x20-\x7e]/g, '').slice(0, 22) || 'Minecraft') + (bedrock ? ' Bedrock' : ''),
      tunnel_type: bedrock ? 'minecraft-bedrock' : 'minecraft-java', port_type: bedrock ? 'udp' : 'tcp', port_count: 1,
      origin: { type: 'agent', data: { agent_id: snap.agentId, local_ip: '127.0.0.1', local_port: port } },
      enabled: true, alloc: null, firewall_id: null, proxy_protocol: null,
    }, secret);
    if (r.status !== 'success') {
      const why = typeof r.data === 'string' ? r.data : r.data?.message || r.data?.type || JSON.stringify(r.data);
      throw new Error(TUNNEL_ERRORS[why] || `playit couldn’t create the tunnel (${why}). You can add it on the playit dashboard instead.`);
    }
    this.log(`Created tunnel ${r.data?.id}`);
    // The daemon picks up new tunnels on its next refresh; wait briefly for the address.
    for (let i = 0; i < 40; i++) {
      const t = this.tunnelForPort(port);
      if (t) return t;
      await new Promise(res => setTimeout(res, 500));
    }
    return { id: r.data?.id, address: null, destination: `127.0.0.1:${port}`, pending: true };
  }

  stop() {
    if (!this.proc) return;
    this.stopping = true;
    try { this.proc.kill('SIGTERM'); } catch {}
  }

  waitForExit() { return this.proc ? new Promise(r => this.proc.once('exit', r)) : Promise.resolve(); }
}

module.exports = { Playit, IPC_VERSION };
