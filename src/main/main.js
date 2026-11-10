const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeTheme, Notification, Tray, Menu, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');
const providers = require('./providers');
const java = require('./java');
const files = require('./files');
const installer = require('./installer');
const { ServerInstance, portFree, readProps } = require('./server-instance');
const { PortMapper, testReachable, tailscaleAddress } = require('./portmap');
const { Playit } = require('./playit');
const backups = require('./backups');
const modrinth = require('./modrinth');

app.setName('Blockyard');
const isMac = process.platform === 'darwin';

// Only one Blockyard may manage the servers at a time; a second launch focuses the first window.
if (!process.env.BLOCKYARD_TEST && !app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

// ---------- app error log (~/Library/Application Support/Blockyard/logs/blockyard.log) ----------
const LOG_DIR = path.join(app.getPath('userData'), 'logs');
function appLog(level, ...parts) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, 'blockyard.log');
    try { if (fs.statSync(file).size > 5 * 1048576) fs.renameSync(file, file + '.1'); } catch {}
    const msg = parts.map(p => (p instanceof Error ? `${p.message}\n${p.stack}` : typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
    fs.appendFileSync(file, `${new Date().toISOString()} [${level}] ${msg}\n`);
  } catch {}
}
process.on('uncaughtException', e => appLog('error', 'uncaught', e));
process.on('unhandledRejection', e => appLog('error', 'unhandled rejection', e));
appLog('info', `Blockyard ${app.getVersion()} starting on ${os.platform()} ${os.release()} (${process.arch})`);
let win = null;
let quitting = false;
const instances = new Map();

store.init(app.getPath('userData'));
java.setManagedRoot(path.join(app.getPath('userData'), 'java'));
// BLOCKYARD_PORTMAP_OPTS lets the UI tests point at a fake router.
const mapper = new PortMapper(process.env.BLOCKYARD_PORTMAP_OPTS ? JSON.parse(process.env.BLOCKYARD_PORTMAP_OPTS) : {});
const playit = new Playit(path.join(app.getPath('userData'), 'playit'));
playit.on('state', snap => { send('playit:state', snap); for (const c of store.listServers()) if (accessOf(c).method === 'playit') pushAccess(c.id); });

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function getInstance(id) {
  let inst = instances.get(id);
  if (!inst) {
    const cfg = store.getServer(id);
    if (!cfg) throw new Error('That server no longer exists.');
    inst = new ServerInstance(cfg);
    inst.on('line', line => send('server:line', { id, line }));
    inst.on('state', snap => send('server:state', snap));
    inst.on('stats', stats => send('server:stats', { id, stats }));
    inst.on('player', ev => onPlayer(id, ev));
    inst.on('exit', (code, expected) => onExit(id, code, expected));
    inst.on('state', snap => { if (snap.state === 'online' && inst._lastState !== 'online') onOnline(id); inst._lastState = snap.state; });
    inst.on('state', () => updateTray());
    extras.attach(inst, id);
    instances.set(id, inst);
  }
  return inst;
}

function serverView(cfg) {
  const inst = instances.get(cfg.id);
  return { ...cfg, snapshot: inst ? inst.snapshot() : { id: cfg.id, state: 'stopped', players: [], stats: { cpu: 0, memMB: 0 } } };
}

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
  }
  // Wi-Fi/Ethernet (en*) first on macOS
  return out.sort((a, b) => (/^en/.test(b.name) - /^en/.test(a.name)));
}

/** Throttle percentage logs so the console doesn't get one line per chunk. */
function steppedLogger(fn) {
  let lastStep = -1;
  return (msg, pct) => {
    if (pct == null) { if (!/Downloading .*MB$/.test(msg)) fn(msg); return; }
    const step = Math.floor(pct * 10);
    if (step !== lastStep) { lastStep = step; fn(msg); }
  };
}

async function resolveJava(cfg, log, { auto = false } = {}) {
  if (cfg.javaPath && fs.existsSync(cfg.javaPath)) return cfg.javaPath;
  let major = cfg.javaMajor;
  if (!major && cfg.mcVersion) major = await providers.javaMajorFor(cfg.mcVersion);
  if (!major) {
    const all = await java.listJavas();
    if (all.length) return all[0].path;
    major = 25;
  }
  const found = await java.find(major);
  if (found) return found.path;
  if (auto) throw new Error(`Java ${major} isn't installed.`);
  const r = await dialog.showMessageBox(win, {
    type: 'question', message: `Java ${major} is needed`,
    detail: `${cfg.name} needs Java ${major}, which isn't installed on this Mac. Blockyard can download it for you (Eclipse Temurin, about 50 MB). It's kept inside Blockyard and won't change anything else on your Mac.`,
    buttons: ['Download Java', 'Cancel'], defaultId: 0, cancelId: 1,
  });
  if (r.response !== 0) return null;
  return java.install(major, steppedLogger(log));
}

async function startServer(id, { auto = false } = {}) {
  const inst = getInstance(id);
  const cfg = inst.cfg;
  if (inst.isRunning()) return { ok: true };
  const eulaPath = path.join(cfg.dir, 'eula.txt');
  let eula = '';
  try { eula = fs.readFileSync(eulaPath, 'utf8'); } catch {}
  if (!/^\s*eula\s*=\s*true/im.test(eula)) {
    if (auto) throw new Error('The Minecraft EULA hasn’t been accepted for this server.');
    const r = await dialog.showMessageBox(win, {
      type: 'question', message: 'Accept the Minecraft EULA?',
      detail: 'Mojang requires everyone who runs a server to agree to the Minecraft End User License Agreement (aka.ms/MinecraftEULA).',
      buttons: ['I Agree', 'Read the EULA', 'Cancel'], defaultId: 0, cancelId: 2,
    });
    if (r.response === 1) shell.openExternal('https://aka.ms/MinecraftEULA');
    if (r.response !== 0) return { cancelled: true };
    fs.writeFileSync(eulaPath, `# Accepted in Blockyard on ${new Date().toISOString()}\neula=true\n`);
  }
  const javaPath = await resolveJava(cfg, msg => inst.info(msg), { auto });
  if (!javaPath) return { cancelled: true };
  extras.beforeStart(cfg);
  await inst.start(javaPath, { keepAwake: store.getSettings().keepAwake });
  extras.afterStart(id, inst);
  if (accessOf(cfg).method === 'playit' && accessOf(cfg).auto !== false) ensurePlayit(id).catch(e => inst.info(`playit: ${e.message}`));
  return { ok: true };
}

function suggestPort() {
  const used = new Set(store.listServers().map(s => {
    try { return parseInt(files.readProperties(s.dir).values['server-port'], 10); } catch { return null; }
  }));
  let p = 25565;
  while (used.has(p)) p++;
  return p;
}

// ---------- IPC ----------
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    const result = await fn(...args);
    if (channel.startsWith('servers:')) updateTray(); // names / list changed
    return result;
  });
}

handle('app:info', () => ({
  platform: process.platform, arch: process.arch, version: app.getVersion(),
  totalMemMB: Math.round(os.totalmem() / 1048576), home: os.homedir(),
  defaultParent: store.getSettings().defaultParent || path.join(os.homedir(), 'Minecraft Servers'),
  lan: lanAddresses(), suggestedPort: suggestPort(),
}));
handle('settings:get', () => store.getSettings());
handle('settings:set', patch => store.setSettings(patch));

handle('software:list', () => providers.catalogue());
handle('software:versions', id => providers.SOFTWARE[id].versions());

handle('servers:list', () => store.listServers().map(serverView));
handle('server:log', id => (instances.get(id)?.log || []));

handle('servers:create', async (opts, taskId) => {
  const log = (message, pct, verbose) => send('task:progress', { taskId, message, pct, verbose: !!verbose });
  const cfg = await installer.createServer(opts, log);
  store.setSettings({ defaultParent: opts.parentDir });
  return serverView(store.addServer(cfg));
});
handle('servers:detect', dir => installer.detect(dir));
handle('servers:import', data => {
  if (store.listServers().some(s => path.resolve(s.dir) === path.resolve(data.dir))) throw new Error('That folder is already in Blockyard.');
  const sw = providers.SOFTWARE[data.software];
  const cfg = store.addServer({
    name: data.name || path.basename(data.dir), dir: data.dir, software: data.software, kind: sw.kind,
    mcVersion: data.mcVersion || '', javaMajor: data.mcVersion ? providers.guessJavaMajor(data.mcVersion) : null,
    memoryMB: data.memoryMB || 2048, launchArgs: data.launchArgs || ['-jar', 'server.jar'], jvmArgs: '', javaPath: '', imported: true,
  });
  // Ask Mojang for the precise Java version in the background.
  if (data.mcVersion) providers.javaMajorFor(data.mcVersion).then(m => store.updateServer(cfg.id, { javaMajor: m })).catch(() => {});
  return serverView(cfg);
});
handle('servers:update', (id, patch) => {
  const allowed = ['name', 'memoryMB', 'jvmArgs', 'javaPath', 'launchArgs', 'mcVersion', 'javaMajor', 'software', 'noGui', 'backup', 'automation', 'optimizedFlags', 'schedules', 'webhook', 'onboarded'];
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  if (clean.software) clean.kind = providers.SOFTWARE[clean.software].kind;
  if (clean.mcVersion && !('javaMajor' in clean)) clean.javaMajor = providers.guessJavaMajor(clean.mcVersion);
  const cfg = store.updateServer(id, clean);
  if (instances.has(id)) instances.get(id).cfg = cfg;
  return serverView(cfg);
});
handle('servers:remove', async (id, { trash } = {}) => {
  const inst = instances.get(id);
  if (inst?.isRunning()) throw new Error('Stop the server first.');
  const cfg = store.getServer(id);
  if (trash && cfg && fs.existsSync(cfg.dir)) await shell.trashItem(cfg.dir);
  instances.delete(id);
  extras.stats.forget(id);
  store.removeServer(id);
});

handle('server:start', id => startServer(id));
handle('server:stop', id => getInstance(id).stop());
handle('server:kill', id => getInstance(id).kill());
handle('server:restart', async id => {
  const inst = getInstance(id);
  if (inst.isRunning()) { const done = inst.waitForExit(); inst.stop(); await done; }
  return startServer(id);
});
handle('server:command', (id, cmd) => getInstance(id).send(cmd));

handle('java:list', () => java.listJavas(true));
handle('java:install', (major, taskId) => java.install(major, (message, pct) => send('task:progress', { taskId, message, pct })));

const cfgOf = id => { const c = store.getServer(id); if (!c) throw new Error('Unknown server'); return c; };
handle('files:list', (id, rel) => files.list(cfgOf(id).dir, rel));
handle('files:read', (id, rel) => files.readText(cfgOf(id).dir, rel));
handle('files:write', (id, rel, content) => files.writeText(cfgOf(id).dir, rel, content));
handle('files:mkdir', (id, rel) => files.mkdir(cfgOf(id).dir, rel));
handle('files:rename', (id, rel, name) => files.rename(cfgOf(id).dir, rel, name));
handle('files:trash', (id, rel) => shell.trashItem(files.safe(cfgOf(id).dir, rel)));
handle('files:copyIn', (id, rel, paths) => files.copyIn(cfgOf(id).dir, rel, paths));
handle('files:reveal', (id, rel) => {
  const p = files.safe(cfgOf(id).dir, rel || '');
  if (!rel) return shell.openPath(p);
  return shell.showItemInFolder(p);
});
handle('files:open', (id, rel) => shell.openPath(files.safe(cfgOf(id).dir, rel)));

handle('addons:list', id => files.listAddons(cfgOf(id)));
handle('addons:toggle', (id, file, enabled) => files.toggleAddon(cfgOf(id), file, enabled));
handle('addons:add', (id, paths) => files.addAddons(cfgOf(id), paths));
handle('addons:trash', (id, file) => shell.trashItem(files.safe(cfgOf(id).dir, path.join(files.addonsDir(cfgOf(id)), file))));
handle('addons:openFolder', id => {
  const c = cfgOf(id);
  const p = files.safe(c.dir, files.addonsDir(c));
  fs.mkdirSync(p, { recursive: true });
  return shell.openPath(p);
});

handle('props:get', id => files.readProperties(cfgOf(id).dir));
handle('props:set', (id, updates) => files.writeProperties(cfgOf(id).dir, updates));
handle('players:lists', id => files.playerLists(cfgOf(id).dir));
handle('port:check', port => portFree(Number(port)));

handle('dialog:pickFolder', async (opts = {}) => {
  const r = await dialog.showOpenDialog(win, { title: opts.title, defaultPath: opts.defaultPath, buttonLabel: opts.buttonLabel, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
handle('dialog:pickFiles', async (opts = {}) => {
  const r = await dialog.showOpenDialog(win, { title: opts.title, filters: opts.filters, properties: ['openFile', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
});
handle('dialog:confirm', async ({ message, detail, buttons = ['OK', 'Cancel'], danger }) => {
  const r = await dialog.showMessageBox(win, { type: danger ? 'warning' : 'question', message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1 });
  return r.response;
});
handle('shell:external', url => { if (/^https:\/\//.test(url)) return shell.openExternal(url); });
handle('clipboard:write', text => clipboard.writeText(String(text)));

// ---------- notifications ----------
function notify(title, body, { always = false } = {}) {
  if (!always && win && !win.isDestroyed() && win.isFocused()) return;
  try { if (Notification.isSupported()) new Notification({ title, body }).show(); } catch {}
}
function onPlayer(id, ev) {
  const cfg = store.getServer(id);
  if (!cfg || store.getSettings().notifyPlayers === false) return;
  notify(cfg.name, `${ev.name} ${ev.type === 'join' ? 'joined' : 'left'} the game`);
}

// ---------- crash auto-restart ----------
const crashLog = new Map();
function onExit(id, code, expected) {
  const cfg = store.getServer(id);
  if (!cfg) return;
  const inst = instances.get(id);
  if (accessOf(cfg).method === 'upnp') closeUpnp(id).catch(() => {});
  maybeStopPlayit();
  if (expected || code === 0) return;
  if (store.getSettings().notifyCrashes !== false) notify(`${cfg.name} crashed`, `The server stopped unexpectedly (exit ${code}).`, { always: true });
  if (cfg.automation?.restartOnCrash === false || restarting.has(id)) return;
  const recent = (crashLog.get(id) || []).filter(t => Date.now() - t < 10 * 60e3);
  recent.push(Date.now());
  crashLog.set(id, recent);
  if (recent.length > 3) { inst?.info('It crashed 4 times in 10 minutes, so automatic restarts are paused. Check the errors above.'); return; }
  inst?.info('Restarting automatically in 5 seconds… (turn this off in Automation)');
  setTimeout(() => startServer(id, { auto: true }).catch(e => inst?.info(`Automatic restart failed: ${e.message}`)), 5000);
}

// ---------- public access ----------
const upnpState = new Map(); // id -> { status: 'idle'|'opening'|'open'|'error', info, error }
let lastDiag = null;
const accessOf = cfg => ({ method: 'off', auto: true, ...(cfg.access || {}) });
const portOfCfg = cfg => parseInt(readProps(cfg.dir)['server-port'] || '25565', 10) || 25565;
const withPort = (host, port) => (port === 25565 ? host : `${host}:${port}`);

function accessView(id) {
  const cfg = store.getServer(id);
  if (!cfg) throw new Error('Unknown server');
  const a = accessOf(cfg);
  const port = portOfCfg(cfg);
  const up = upnpState.get(id) || { status: 'idle' };
  const pl = playit.snapshot();
  const tunnel = playit.tunnelForPort(port);
  let publicAddress = null;
  if (a.method === 'upnp' && up.status === 'open' && up.info?.externalIP) publicAddress = withPort(up.info.externalIP, up.info.externalPort || port);
  if (a.method === 'playit' && tunnel?.address) publicAddress = tunnel.address;
  if (a.method === 'manual' && lastDiag?.publicIP) publicAddress = withPort(lastDiag.publicIP, port);
  const ts = tailscaleAddress();
  if (a.method === 'vpn' && ts) publicAddress = withPort(ts, port);
  return { ...a, port, upnp: up, playit: pl, tunnel, publicAddress, tailscale: ts, diag: lastDiag };
}
const pushAccess = id => { try { send('access:state', { id, view: accessView(id) }); } catch {} };

async function openUpnp(id) {
  const cfg = store.getServer(id);
  const port = portOfCfg(cfg);
  upnpState.set(id, { status: 'opening' }); pushAccess(id);
  try {
    const info = await mapper.map(port, `Blockyard ${cfg.name}`.slice(0, 40));
    upnpState.set(id, { status: 'open', info });
    instances.get(id)?.info(`Port ${port} opened on your router via ${info.via}${info.externalIP ? `. Public address: ${withPort(info.externalIP, info.externalPort)}` : ''}`);
  } catch (e) {
    upnpState.set(id, { status: 'error', error: e.message });
    instances.get(id)?.info(`Automatic port forwarding failed: ${e.message}`);
  }
  pushAccess(id);
  return accessView(id);
}
async function closeUpnp(id) {
  const cfg = store.getServer(id);
  const st = upnpState.get(id);
  if (st?.info?.port) await mapper.unmap(st.info.port);
  else if (cfg) await mapper.unmap(portOfCfg(cfg));
  upnpState.set(id, { status: 'idle' }); pushAccess(id);
  return accessView(id);
}

async function ensurePlayit(id) {
  if (!playit.installed()) throw new Error('playit isn’t installed yet. Open Public Access to set it up.');
  await playit.start();
  const cfg = store.getServer(id);
  if (cfg && playit.snapshot().agentId && !playit.tunnelForPort(portOfCfg(cfg))) {
    instances.get(id)?.info('playit: no tunnel for this server yet. Create one in Public Access.');
  }
}
function maybeStopPlayit() {
  // Keep playit running while any playit server is running.
  setTimeout(() => {
    const needed = store.listServers().some(c => accessOf(c).method === 'playit' && instances.get(c.id)?.isRunning());
    if (!needed && !playit.claim?.status?.startsWith('waiting')) playit.stop();
  }, 1000);
}

function onOnline(id) {
  const cfg = store.getServer(id);
  if (!cfg) return;
  const a = accessOf(cfg);
  if (a.method === 'upnp' && a.auto !== false) openUpnp(id);
  extras.onOnline(id).catch(e => appLog('warn', 'bedrock onOnline', e));
  pushAccess(id);
}

handle('access:get', id => accessView(id));
handle('access:set', async (id, patch) => {
  const cfg = store.getServer(id);
  const prev = accessOf(cfg);
  const next = { ...prev, ...patch };
  store.updateServer(id, { access: next });
  if (prev.method === 'upnp' && next.method !== 'upnp') await closeUpnp(id).catch(() => {});
  if (prev.method === 'playit' && next.method !== 'playit') maybeStopPlayit();
  const inst = instances.get(id);
  if (inst?.state === 'online') {
    if (next.method === 'upnp' && prev.method !== 'upnp' && next.auto !== false) openUpnp(id);
    if (next.method === 'playit' && playit.installed()) ensurePlayit(id).catch(() => {});
  }
  return accessView(id);
});
handle('access:upnpOpen', id => openUpnp(id));
handle('access:upnpClose', id => closeUpnp(id));
handle('access:diagnose', async () => { lastDiag = await mapper.diagnose(); for (const c of store.listServers()) pushAccess(c.id); return lastDiag; });
handle('access:test', async id => {
  const cfg = store.getServer(id);
  if (instances.get(id)?.state !== 'online') throw new Error('Start the server first, then test.');
  const v = accessView(id);
  let target = v.publicAddress;
  if (!target || v.method === 'vpn') {
    if (v.method === 'vpn') throw new Error('Private networks (Tailscale/ZeroTier) can’t be tested from the public internet. Ask a friend on your network to try.');
    const ip = (lastDiag = lastDiag || await mapper.diagnose()).publicIP;
    if (!ip) throw new Error('Couldn’t find your public IP address.');
    target = withPort(ip, v.port);
  }
  const [host, port] = target.includes(':') ? [target.slice(0, target.lastIndexOf(':')), +target.slice(target.lastIndexOf(':') + 1)] : [target, 25565];
  const r = await testReachable(host, port);
  return { ...r, target, cfgPort: portOfCfg(cfg), at: Date.now() };
});

handle('playit:state', () => playit.snapshot());
handle('playit:install', taskId => playit.install((message, pct) => send('task:progress', { taskId, message, pct })).then(() => playit.snapshot()));
handle('playit:start', async () => { await playit.start(); return playit.snapshot(); });
handle('playit:stop', () => { playit.stop(); return playit.snapshot(); });
handle('playit:link', async () => { await playit.link(url => { shell.openExternal(url).catch(() => {}); }); return playit.snapshot(); });
handle('playit:cancelLink', () => { playit.cancelLink(); return playit.snapshot(); });
handle('playit:createTunnel', async id => {
  const cfg = store.getServer(id);
  if (!playit.snapshot().agentId) await playit.start();
  const t = await playit.createTunnel({ name: cfg.name, port: portOfCfg(cfg) });
  pushAccess(id);
  return t;
});
handle('playit:logs', () => playit.state.logs.slice(-200));

// ---------- backups ----------
const backupBusy = new Set();
async function runBackup(id, reason, scopeOverride) {
  const cfg = store.getServer(id);
  if (backupBusy.has(id)) throw new Error('A backup is already running.');
  const inst = instances.get(id);
  backupBusy.add(id);
  send('backups:busy', { id, busy: true });
  try {
    const b = await backups.create(cfg, { scope: scopeOverride || cfg.backup?.scope || 'world', reason, inst, log: m => inst?.info(m) });
    if (reason === 'auto') { store.updateServer(id, { lastAutoBackup: Date.now() }); backups.prune(cfg, cfg.backup?.keep ?? 10); }
    inst?.info(`Backup saved: ${b.file} (${(b.size / 1048576).toFixed(1)} MB)`);
    return b;
  } catch (e) {
    inst?.info(`Backup failed: ${e.message}`);
    if (reason === 'auto') notify(`${cfg.name}: backup failed`, e.message, { always: true });
    throw e;
  } finally {
    backupBusy.delete(id);
    send('backups:busy', { id, busy: false });
  }
}
handle('backups:list', id => ({ items: backups.list(cfgOf(id)), busy: backupBusy.has(id), folder: backups.backupDir(cfgOf(id)) }));
handle('backups:create', (id, scope) => runBackup(id, 'manual', scope));
handle('backups:restore', async (id, file, taskId) => {
  if (instances.get(id)?.isRunning()) throw new Error('Stop the server before restoring a backup.');
  if (backupBusy.has(id)) throw new Error('A backup is already running.');
  backupBusy.add(id);
  try { await backups.restore(cfgOf(id), file, { log: message => send('task:progress', { taskId, message }) }); }
  finally { backupBusy.delete(id); }
});
handle('backups:trash', (id, file) => shell.trashItem(path.join(backups.backupDir(cfgOf(id)), path.basename(file))));
handle('backups:reveal', (id, file) => {
  const dir = backups.backupDir(cfgOf(id));
  fs.mkdirSync(dir, { recursive: true });
  return file ? shell.showItemInFolder(path.join(dir, path.basename(file))) : shell.openPath(dir);
});

// ---------- scheduler: backups + daily restarts ----------
const warned = new Map();
const restarting = new Set();
async function scheduledRestart(id) {
  const inst = instances.get(id);
  if (!inst?.isRunning()) return;
  restarting.add(id);
  try {
    const done = inst.waitForExit();
    inst.stop();
    await done;
    await startServer(id, { auto: true });
  } catch (e) { inst.info(`Scheduled restart failed: ${e.message}`); } finally { restarting.delete(id); }
}
function tick() {
  const now = new Date();
  for (const cfg of store.listServers()) {
    const inst = instances.get(cfg.id);
    if (!inst || inst.state !== 'online') continue;
    const hrs = Number(cfg.backup?.intervalHours) || 0;
    if (hrs > 0 && !backupBusy.has(cfg.id)) {
      const last = Math.max(cfg.lastAutoBackup || 0, inst.startedAt || 0);
      if (now - last >= hrs * 3600e3) runBackup(cfg.id, 'auto').catch(() => {});
    }
    const t = cfg.automation?.dailyRestart;
    if (/^\d{1,2}:\d{2}$/.test(t || '')) {
      const [h, m] = t.split(':').map(Number);
      const target = new Date(now); target.setHours(h, m, 0, 0);
      const day = now.toDateString();
      const w = warned.get(cfg.id)?.day === day ? warned.get(cfg.id) : { day };
      warned.set(cfg.id, w);
      const mins = (target - now) / 60000;
      if (cfg.lastDailyRestart === day) continue;
      if (mins <= 5 && mins > 4 && !w.w5) { w.w5 = true; inst.send('say Server restarting in 5 minutes.'); }
      if (mins <= 1 && mins > 0 && !w.w1) { w.w1 = true; inst.send('say Server restarting in 1 minute!'); }
      if (mins <= 0 && mins > -5) {
        store.updateServer(cfg.id, { lastDailyRestart: day });
        inst.send('say Restarting now. Back in a minute!');
        inst.info(`Scheduled daily restart (${t}).`);
        setTimeout(() => scheduledRestart(cfg.id), 3000);
      }
    }
  }
}
setInterval(tick, 20000);

// ---------- Modrinth ----------
const installedMap = cfg => {
  const map = cfg.modrinth || {};
  const folder = path.join(cfg.dir, cfg.kind === 'plugins' ? 'plugins' : 'mods');
  return Object.fromEntries(Object.entries(map).filter(([, v]) => fs.existsSync(path.join(folder, v.file)) || fs.existsSync(path.join(folder, v.file + '.disabled'))));
};
handle('modrinth:search', async (id, opts) => {
  const cfg = cfgOf(id);
  if (cfg.kind === 'none') throw new Error('Vanilla servers can’t use plugins or mods.');
  const r = await modrinth.search(cfg, opts || {});
  const inst = installedMap(cfg);
  r.hits = r.hits.map(h => ({ ...h, installed: !!inst[h.id] }));
  return r;
});
handle('modrinth:install', async (id, projectId, taskId) => {
  const cfg = cfgOf(id);
  const installed = { ...installedMap(cfg) };
  const results = await modrinth.install(cfg, projectId, { installed, log: message => send('task:progress', { taskId, message }) });
  store.updateServer(id, { modrinth: installed });
  return results;
});
handle('modrinth:installed', id => installedMap(cfgOf(id)));

// ---------- 1.2 features (stats, crossplay, worlds, updates, schedules, webhooks, logs) ----------
const setupExtras = require('./extras');
const extras = setupExtras({
  app, handle, store, instances, getInstance, send, notify, startServer, runBackup, mapper, playit, cfgOf, shell, dialog, nativeImage,
  getWin: () => win,
});
handle('app:logError', (where, message) => appLog('renderer', where, message));
handle('app:openLogs', () => { fs.mkdirSync(LOG_DIR, { recursive: true }); return shell.openPath(LOG_DIR); });

// ---------- update check (GitHub Releases) ----------
const updates = require('./updates');
const APP_VERSION = require('../../package.json').version;
const updater = updates.createUpdater({ currentVersion: APP_VERSION, userAgent: require('./net').UA });
handle('app:checkUpdate', async force => {
  if (!force && store.getSettings().checkUpdates === false) return { current: APP_VERSION, available: false, disabled: true };
  return updater.check({ force: !!force });
});
handle('app:openRelease', url => shell.openExternal(typeof url === 'string' && url.startsWith(updates.REPO_URL) ? url : updates.RELEASES_URL));
handle('app:reportIssue', () => shell.openExternal(updates.issueUrl({ version: app.getVersion(), macos: process.getSystemVersion?.() || os.release(), arch: process.arch })));
async function checkUpdatesFromMenu() {
  try {
    const r = await updater.check({ force: true });
    if (r.available) {
      const { response } = await dialog.showMessageBox(win, { type: 'info', message: `Blockyard ${r.latest} is available`, detail: `You have ${r.current}. Download the new version from GitHub, then replace the app in Applications. Your servers aren’t touched.`, buttons: ['Download', 'Later'], defaultId: 0, cancelId: 1 });
      if (response === 0) shell.openExternal(r.url);
    } else {
      await dialog.showMessageBox(win, { type: 'info', message: 'Blockyard is up to date', detail: `You have version ${r.current}.`, buttons: ['OK'] });
    }
  } catch (e) {
    await dialog.showMessageBox(win, { type: 'warning', message: 'Couldn’t check for updates', detail: e.message, buttons: ['OK'] });
  }
}

// ---------- application menu ----------
function menuAction(action) { if (!win) createWindow(); win.show(); send('app:menu', action); }
function buildAppMenu() {
  const tab = (label, key, accel) => ({ label, accelerator: accel, click: () => menuAction(`tab:${key}`) });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ label: 'Blockyard', submenu: [
      { role: 'about' }, { label: 'Check for Updates…', click: checkUpdatesFromMenu }, { type: 'separator' },
      { label: 'Settings…', accelerator: 'Command+,', click: () => menuAction('settings') },
      { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ] }] : []),
    { label: 'File', submenu: [
      { label: 'New Server…', accelerator: 'CmdOrCtrl+N', click: () => menuAction('new') },
      { label: 'New Server from Singleplayer World…', accelerator: 'Shift+CmdOrCtrl+N', click: () => menuAction('new-world') },
      { label: 'Import Server Folder…', accelerator: 'CmdOrCtrl+O', click: () => menuAction('import') },
      { type: 'separator' }, isMac ? { role: 'close' } : { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { label: 'Server', submenu: [
      { label: 'Start', accelerator: 'CmdOrCtrl+Return', click: () => menuAction('start') },
      { label: 'Stop', accelerator: 'CmdOrCtrl+.', click: () => menuAction('stop') },
      { label: 'Restart', accelerator: 'Shift+CmdOrCtrl+R', click: () => menuAction('restart') },
      { label: 'Back Up Now', accelerator: 'CmdOrCtrl+B', click: () => menuAction('backup') },
      { type: 'separator' },
      tab('Console', 'console', 'CmdOrCtrl+1'), tab('Players', 'players', 'CmdOrCtrl+2'), tab('Stats', 'stats', 'CmdOrCtrl+3'),
      tab('Files', 'files', 'CmdOrCtrl+4'), tab('Plugins & Mods', 'addons', 'CmdOrCtrl+5'), tab('Worlds', 'worlds', 'CmdOrCtrl+6'),
      tab('Public Access', 'access', 'CmdOrCtrl+7'), tab('Backups', 'backups', 'CmdOrCtrl+8'), tab('Settings', 'settings', 'CmdOrCtrl+9'),
    ] },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
      ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'toggleDevTools' }])] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [
      { label: 'Show Blockyard Logs', click: () => { fs.mkdirSync(LOG_DIR, { recursive: true }); shell.openPath(LOG_DIR); } },
      { label: 'Report a Problem…', click: () => shell.openExternal(updates.issueUrl({ version: app.getVersion(), macos: process.getSystemVersion?.() || os.release(), arch: process.arch })) },
      { label: 'Blockyard on GitHub', click: () => shell.openExternal(updates.REPO_URL) },
      { type: 'separator' },
      { label: 'Minecraft EULA', click: () => shell.openExternal('https://aka.ms/MinecraftEULA') },
    ] },
  ]));
}
app.setAboutPanelOptions?.({ applicationName: 'Blockyard', applicationVersion: app.getVersion(), copyright: 'Not affiliated with Mojang or Microsoft.' });

// ---------- server icon (server-icon.png, 64×64) ----------
handle('icon:get', id => {
  const p = path.join(cfgOf(id).dir, 'server-icon.png');
  return fs.existsSync(p) ? nativeImage.createFromPath(p).toDataURL() : null;
});
handle('icon:set', async id => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a server icon', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'bmp', 'tiff'] }], properties: ['openFile'] });
  if (r.canceled) return null;
  const img = nativeImage.createFromPath(r.filePaths[0]);
  if (img.isEmpty()) throw new Error('That file couldn’t be read as an image.');
  // Crop to a centred square first so the icon isn't squashed.
  const { width, height } = img.getSize();
  const side = Math.min(width, height);
  const square = img.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side });
  const icon = square.resize({ width: 64, height: 64, quality: 'best' });
  fs.writeFileSync(path.join(cfgOf(id).dir, 'server-icon.png'), icon.toPNG());
  return icon.toDataURL();
});
handle('icon:remove', id => shell.trashItem(path.join(cfgOf(id).dir, 'server-icon.png')).catch(() => {}));

// ---------- menu bar icon ----------
let tray = null;
let trayTimer = null;
const TRAY_DOT = { online: '🟢', starting: '🟡', stopping: '🟡', stopped: '⚪️' };
function showWindow(selectId) {
  const fresh = !win;
  if (fresh) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (selectId) {
    const go = () => send('app:select', selectId);
    if (fresh || win.webContents.isLoading()) win.webContents.once('did-finish-load', () => setTimeout(go, 300)); else go();
  }
}
function buildTrayMenu() {
  const servers = store.listServers();
  const items = servers.map(cfg => {
    const inst = instances.get(cfg.id);
    const st = inst?.state || 'stopped';
    const detail = st === 'online' ? ` · ${inst.players.size} online` : st === 'stopped' ? '' : st === 'starting' ? ' · starting…' : ' · stopping…';
    return {
      label: `${TRAY_DOT[st]}  ${cfg.name}${detail}`,
      submenu: [
        { label: 'Start', enabled: st === 'stopped', click: () => { showWindow(cfg.id); startServer(cfg.id).catch(e => getInstance(cfg.id).info(`Couldn't start: ${e.message}`)); } },
        { label: 'Stop', enabled: st === 'online' || st === 'starting', click: () => getInstance(cfg.id).stop() },
        { label: 'Restart', enabled: st === 'online', click: () => { const i = getInstance(cfg.id); const d = i.waitForExit(); i.stop(); d.then(() => startServer(cfg.id)).catch(() => {}); } },
        { type: 'separator' },
        { label: 'Open in Blockyard', click: () => showWindow(cfg.id) },
      ],
    };
  });
  const running = [...instances.values()].filter(i => i.isRunning()).length;
  return Menu.buildFromTemplate([
    { label: running ? `${running} server${running === 1 ? '' : 's'} running` : 'No servers running', enabled: false },
    { type: 'separator' },
    ...(items.length ? items : [{ label: 'No servers yet', enabled: false }]),
    { type: 'separator' },
    { label: 'Open Blockyard', click: () => showWindow() },
    { label: 'Quit Blockyard', accelerator: 'Command+Q', click: () => app.quit() },
  ]);
}
function updateTray() {
  if (!tray) return;
  clearTimeout(trayTimer);
  trayTimer = setTimeout(() => {
    if (!tray) return;
    const running = [...instances.values()].filter(i => i.isRunning()).length;
    tray.setContextMenu(buildTrayMenu());
    tray.setToolTip(running ? `Blockyard: ${running} running` : 'Blockyard');
    if (isMac) tray.setTitle(running ? String(running) : '');
  }, 150);
}
function createTray() {
  if (tray || store.getSettings().menuBar === false) return;
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'build', 'trayTemplate.png'));
    img.setTemplateImage(true);
    tray = new Tray(img);
    updateTray();
  } catch (e) { console.error('tray', e); tray = null; }
}
function destroyTray() { tray?.destroy(); tray = null; }
handle('tray:set', on => { store.setSettings({ menuBar: !!on }); if (on) createTray(); else destroyTray(); return !!on; });

// ---------- window & lifecycle ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 780, minWidth: 920, minHeight: 580, show: false,
    title: 'Blockyard',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: isMac ? 'sidebar' : undefined,
    visualEffectState: 'active',
    backgroundColor: isMac ? '#00000000' : (nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f5f5f7'),
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.on('closed', () => { win = null; });
}

app.on('second-instance', () => showWindow());

app.whenReady().then(() => {
  buildAppMenu();
  createWindow();
  createTray();
  setTimeout(() => extras.recoverOrphans().catch(e => appLog('warn', 'orphans', e)), 1200);
  for (const cfg of store.listServers()) {
    if (cfg.automation?.startOnLaunch) setTimeout(() => startServer(cfg.id, { auto: true }).catch(e => getInstance(cfg.id).info(`Couldn't start automatically: ${e.message}`)), 1500);
  }
  app.on('activate', () => { if (!win) createWindow(); });
  setInterval(updateTray, 15000); // keep player counts fresh
});

app.on('window-all-closed', () => {
  // On macOS the app (and any running servers) keep going in the Dock.
  if (!isMac) app.quit();
});

app.on('before-quit', e => {
  if (quitting) return;
  const running = [...instances.values()].filter(i => i.isRunning());
  if (!running.length) return;
  e.preventDefault();
  const choice = dialog.showMessageBoxSync(win || undefined, {
    type: 'warning', message: `Stop ${running.length === 1 ? running[0].cfg.name : running.length + ' servers'} and quit?`,
    detail: 'Running servers will be saved and stopped properly first. This can take a few seconds.',
    buttons: ['Stop & Quit', 'Cancel'], defaultId: 0, cancelId: 1,
  });
  if (choice !== 0) return;
  quitting = true;
  Promise.all(running.map(i => { const d = i.waitForExit(); i.stop(); return d; })).then(() => app.quit());
});

// Close router ports and the playit daemon on the way out.
let cleaned = false;
app.on('will-quit', e => {
  if (cleaned) return;
  e.preventDefault();
  cleaned = true;
  extras.flush();
  playit.stop();
  Promise.race([mapper.unmapAll(), new Promise(r => setTimeout(r, 2500))]).finally(() => app.quit());
});
