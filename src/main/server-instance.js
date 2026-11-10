// Wraps one running Minecraft server process: console in/out, state, players, stats.
const { spawn, execFile } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const net = require('net');

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][0-9A-Za-z]|\x1b[=>]/g;
const MAX_LOG = 2500;
const NAME = '([.\\w]{1,17})'; // Java names are 3-16 \w; Bedrock (Geyser/Floodgate) adds a leading "."

const RE = {
  done: /\bDone \(\d+[.,]?\d*s\)!/,
  join: new RegExp(`\\]: ${NAME} joined the game\\s*$`),
  leave: new RegExp(`\\]: ${NAME} left the game\\s*$`),
  list: /There are (\d+)(?: of a max of |\/)(\d+) players online:?\s*(.*)$/,
  uuid: new RegExp(`UUID of player ${NAME} is ([0-9a-f-]{32,36})`),
};

function readProps(dir) {
  try {
    const out = {};
    for (const line of fs.readFileSync(path.join(dir, 'server.properties'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([^#!=:\s][^=:]*?)\s*[=:]\s*(.*)$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch { return {}; }
}

function portFree(port) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '0.0.0.0');
  });
}

// Aikar's widely used G1 flags (https://docs.papermc.io/paper/aikars-flags), minus ones newer JDKs dropped.
// IgnoreUnrecognizedVMOptions keeps an older/newer Java from refusing to start over one flag.
const OPTIMIZED_FLAGS = [
  '-XX:+IgnoreUnrecognizedVMOptions', '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200',
  '-XX:+UnlockExperimentalVMOptions', '-XX:+DisableExplicitGC', '-XX:+AlwaysPreTouch', '-XX:G1NewSizePercent=30',
  '-XX:G1MaxNewSizePercent=40', '-XX:G1HeapRegionSize=8M', '-XX:G1ReservePercent=20', '-XX:G1HeapWastePercent=5',
  '-XX:G1MixedGCCountTarget=4', '-XX:InitiatingHeapOccupancyPercent=15', '-XX:G1MixedGCLiveThresholdPercent=90',
  '-XX:SurvivorRatio=32', '-XX:+PerfDisableSharedMem', '-XX:MaxTenuringThreshold=1',
  '-Dusing.aikars.flags=https://mcflags.emc.gs', '-Daikars.new.flags=true',
];

// Answers to the background TPS probes.
const METRIC_RE = {
  paperTps: /TPS from last 1m, 5m, 15m: \*?([\d.]+)/,
  paperMsptHeader: /Server tick times \(avg\/min\/max\)/,
  paperMsptValues: /([\d.]+)\/([\d.]+)\/([\d.]+)/,
  vanillaMspt: /Average time per tick: ([\d.]+)\s*ms/,
};
const PROBE_ANSWERS = {
  paper: [/TPS from last 1m/, /Server tick times \(avg/, /^\S*\s*[\d.]+\/[\d.]+\/[\d.]+/, /\]: \W*[\d.]+\/[\d.]+\/[\d.]+,/],
  vanilla: [/The game is (running|frozen|sprinting|stepping)/, /Target tick rate/, /Average time per tick/, /Percentiles: /],
};

function splitArgs(str) {
  return (String(str || '').match(/"[^"]*"|'[^']*'|\S+/g) || []).map(t => t.replace(/^["']|["']$/g, ''));
}

class ServerInstance extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.state = 'stopped';
    this.log = [];
    this.players = new Map();
    this.maxPlayers = null;
    this.proc = null;
    this.startedAt = null;
    this.stats = { cpu: 0, memMB: 0 };
    this.buf = '';
    this.lastExit = null;
    this.metrics = { tps: null, mspt: null, at: null };
    this.hide = [];            // [{ re, until }] console lines produced by silent probes
    this.unsupported = new Set(); // probe commands this server doesn't know
    this.expectMspt = false;
  }

  get id() { return this.cfg.id; }
  isRunning() { return !!this.proc; }

  snapshot() {
    return {
      id: this.cfg.id, state: this.state, players: [...this.players.values()], maxPlayers: this.maxPlayers,
      startedAt: this.startedAt, stats: this.stats, lastExit: this.lastExit, pid: this.proc?.pid || null, metrics: this.metrics,
    };
  }

  setState(s) { this.state = s; this.emit('state', this.snapshot()); }

  pushLine(text, source = 'server') {
    const entry = { t: Date.now(), text, source };
    this.log.push(entry);
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
    this.emit('line', entry);
  }
  info(msg) { this.pushLine(msg, 'app'); }

  buildArgs() {
    const mem = Math.max(512, Number(this.cfg.memoryMB) || 2048);
    const optimized = !!this.cfg.optimizedFlags;
    const xms = optimized ? mem : Math.min(mem, 1024); // Aikar's flags expect Xms = Xmx
    return [
      `-Xms${xms}M`, `-Xmx${mem}M`,
      ...(optimized ? OPTIMIZED_FLAGS : []),
      ...splitArgs(this.cfg.jvmArgs),
      ...(this.cfg.launchArgs || ['-jar', 'server.jar']),
      ...(this.cfg.noGui === false ? [] : ['nogui']),
    ];
  }

  async start(javaPath, { keepAwake = true } = {}) {
    if (this.proc) throw new Error('This server is already running.');
    if (!fs.existsSync(this.cfg.dir)) throw new Error(`The server folder is missing: ${this.cfg.dir}`);
    const port = parseInt(readProps(this.cfg.dir)['server-port'] || '25565', 10);
    if (port && !(await portFree(port))) {
      throw new Error(`Port ${port} is already in use, maybe by another server. Stop it or change "server-port" in Properties.`);
    }
    const args = this.buildArgs();
    this.players.clear();
    this.maxPlayers = null;
    this.lastExit = null;
    this.metrics = { tps: null, mspt: null, at: null };
    this.hide = [];
    this.unsupported = new Set();
    this.buf = '';
    this.info(`Starting server with: ${path.basename(javaPath) === 'java' ? javaPath : 'java'} ${args.join(' ')}`);

    const proc = spawn(javaPath, args, { cwd: this.cfg.dir, env: { ...process.env, TERM: 'dumb' }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    this.startedAt = Date.now();
    this.setState('starting');

    proc.stdout.on('data', d => this.onData(d));
    proc.stderr.on('data', d => this.onData(d));
    proc.stdin.on('error', () => {});
    proc.on('error', err => this.info(`Couldn't start Java: ${err.message}`));
    proc.on('exit', (code, signal) => this.onExit(code, signal));

    if (keepAwake && process.platform === 'darwin' && proc.pid) {
      // Stop the Mac from idle-sleeping while this server runs; caffeinate exits with the server.
      try { this.caffeinate = spawn('caffeinate', ['-i', '-w', String(proc.pid)], { stdio: 'ignore' }); this.caffeinate.on('error', () => {}); } catch {}
    }
    this.statsTimer = setInterval(() => this.sampleStats(), 2500);
  }

  onData(d) {
    this.buf += d.toString('utf8');
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const raw = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      this.handleLine(raw);
    }
  }

  handleLine(raw) {
    // Console prompts like ">" and carriage-return redraws: keep the last real segment.
    const segs = raw.replace(ANSI, '').split('\r').filter(s => s.trim());
    let line = segs.length ? segs[segs.length - 1] : '';
    line = line.replace(/^>\s?(?=\[)/, '').replace(/\s+$/, '');
    if (!line) return;
    const now = Date.now();
    this.hide = this.hide.filter(h => h.until > now);
    const hidden = this.hide.find(h => h.re.test(line));
    this.parseMetrics(line, hidden);
    if (hidden) return; // answer to a background probe: keep the console clean
    this.pushLine(line);
    this.parse(line);
  }

  /**
   * Run a command without echoing it, and hide its answer for `ms`. Used for TPS/MSPT sampling.
   * If the server answers "unknown command", the probe is disabled for this session.
   */
  probe(command, answers, ms = 2500) {
    if (!this.proc || this.state !== 'online' || this.unsupported.has(command)) return false;
    const until = Date.now() + ms;
    for (const re of answers) this.hide.push({ re, until, command });
    this.hide.push({ re: /Unknown (or incomplete )?command|Unknown command\. Type|<--\[HERE\]|Incorrect argument for command/i, until, command, unknown: true });
    try { this.proc.stdin.write(command + '\n'); } catch { return false; }
    return true;
  }

  parseMetrics(line, hidden) {
    let m;
    if (hidden?.unknown) { this.unsupported.add(hidden.command); return; }
    if ((m = line.match(METRIC_RE.paperTps))) {
      this.metrics = { ...this.metrics, tps: Math.min(20, parseFloat(m[1])), at: Date.now() };
      this.emit('metrics', this.metrics);
    } else if (METRIC_RE.paperMsptHeader.test(line)) {
      this.expectMspt = true;
    } else if (this.expectMspt && (m = line.match(METRIC_RE.paperMsptValues))) {
      this.expectMspt = false;
      this.metrics = { ...this.metrics, mspt: parseFloat(m[1]), at: Date.now() };
      this.emit('metrics', this.metrics);
    } else if ((m = line.match(METRIC_RE.vanillaMspt))) {
      const mspt = parseFloat(m[1]);
      // Vanilla only reports time per tick; the server can't exceed 20 TPS, and falls behind past 50 ms.
      this.metrics = { tps: Math.min(20, mspt > 0 ? 1000 / Math.max(50, mspt) : 20), mspt, at: Date.now() };
      this.emit('metrics', this.metrics);
    }
  }

  parse(line) {
    let m;
    if (this.state === 'starting' && RE.done.test(line)) { this.setState('online'); return; }
    if ((m = line.match(RE.uuid))) {
      const p = this.players.get(m[1]);
      if (p) p.uuid = m[2]; else this.pendingUuid = { name: m[1], uuid: m[2] };
      return;
    }
    if ((m = line.match(RE.join))) {
      const name = m[1];
      const uuid = this.pendingUuid?.name === name ? this.pendingUuid.uuid : undefined;
      this.players.set(name, { name, uuid, joinedAt: Date.now() });
      this.emit('player', { type: 'join', name });
      this.emit('state', this.snapshot());
      return;
    }
    if ((m = line.match(RE.leave))) {
      if (this.players.delete(m[1])) { this.emit('player', { type: 'leave', name: m[1] }); this.emit('state', this.snapshot()); }
      return;
    }
    if ((m = line.match(RE.list))) {
      this.maxPlayers = parseInt(m[2], 10);
      const names = m[3].split(',').map(s => s.trim().replace(/§./g, '')).filter(Boolean)
        .map(s => s.replace(/^.*\s/, '')); // strip rank prefixes some plugins add
      const next = new Map();
      for (const n of names) next.set(n, this.players.get(n) || { name: n, joinedAt: null });
      this.players = next;
      this.emit('state', this.snapshot());
    }
  }

  sampleStats() {
    if (!this.proc?.pid) return;
    execFile('ps', ['-o', '%cpu=,rss=', '-p', String(this.proc.pid)], (err, out) => {
      if (err) return;
      const [cpu, rss] = String(out).trim().split(/\s+/).map(Number);
      this.stats = { cpu: cpu || 0, memMB: Math.round((rss || 0) / 1024) };
      this.emit('stats', this.stats);
    });
  }

  onExit(code, signal) {
    if (this.buf.trim()) this.handleLine(this.buf);
    this.buf = '';
    clearInterval(this.statsTimer);
    clearTimeout(this.killTimer);
    try { this.caffeinate?.kill(); } catch {}
    const expected = this.state === 'stopping';
    this.proc = null;
    this.lastExit = code ?? signal;
    this.players.clear();
    this.startedAt = null;
    this.stats = { cpu: 0, memMB: 0 };
    this.info(expected || code === 0 ? 'Server stopped.' : `Server stopped unexpectedly (exit ${code ?? signal}). Check the lines above for the error.`);
    this.setState('stopped');
    this.emit('exit', code, expected);
  }

  send(command) {
    if (!this.proc) throw new Error('The server is not running.');
    const cmd = String(command).replace(/^\//, '').trim();
    if (!cmd) return;
    this.pushLine(cmd, 'cmd');
    // The user is typing: never risk hiding their output behind a background probe's filter.
    this.hide = [];
    this.proc.stdin.write(cmd + '\n');
    if (/^stop$/i.test(cmd)) this.markStopping();
  }

  markStopping() {
    this.setState('stopping');
    clearTimeout(this.killTimer);
    this.killTimer = setTimeout(() => {
      if (this.proc) { this.info("The server didn't stop within 60 seconds, so it was force-closed."); this.proc.kill('SIGKILL'); }
    }, 60000);
  }

  stop() {
    if (!this.proc) return;
    if (this.state === 'stopping') return;
    this.pushLine('stop', 'cmd');
    this.proc.stdin.write('stop\n');
    this.markStopping();
  }

  kill() {
    if (!this.proc) return;
    this.info('Force-stopping the server…');
    this.state = 'stopping';
    this.proc.kill('SIGKILL');
  }

  /** Resolve with the first console line matching `re` (or reject after `ms`). */
  waitForLine(re, ms = 15000) {
    return new Promise((resolve, reject) => {
      const onLine = e => { if (e.source === 'server' && re.test(e.text)) { cleanup(); resolve(e.text); } };
      const onExit = () => { cleanup(); reject(new Error('The server stopped.')); };
      const t = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, ms);
      const cleanup = () => { clearTimeout(t); this.off('line', onLine); this.off('exit', onExit); };
      this.on('line', onLine); this.once('exit', onExit);
    });
  }

  waitForExit() {
    return this.proc ? new Promise(r => this.once('exit', () => r())) : Promise.resolve();
  }
}

module.exports = { ServerInstance, readProps, portFree, splitArgs, RE, OPTIMIZED_FLAGS, METRIC_RE, PROBE_ANSWERS };
