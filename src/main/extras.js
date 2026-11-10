// Blockyard 1.2 main-process features: stats & TPS sampling, Bedrock crossplay (Geyser), worlds
// (singleplayer import/export, switch, reset), version changes, plugin updates, scheduled commands,
// Discord webhooks, log viewer and recovery of servers left running after a crash.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFile } = require('child_process');
const providers = require('./providers');
const java = require('./java');
const files = require('./files');
const geyser = require('./geyser');
const worlds = require('./worlds');
const modrinth = require('./modrinth');
const { StatsStore, SAMPLE_MS } = require('./stats');
const { PROBE_ANSWERS } = require('./server-instance');

module.exports = function setupExtras(ctx) {
  const { app, handle, store, instances, getInstance, send, notify, startServer, runBackup, mapper, playit, cfgOf, shell, dialog, nativeImage, getWin } = ctx;
  const stats = new StatsStore(path.join(app.getPath('userData'), 'stats'));
  const bedrock = new Map(); // id -> { ready, upnp: info|null, error }

  // ---------- per-instance wiring (called from getInstance) ----------
  function attach(inst, id) {
    inst.on('state', snap => {
      if (snap.state === 'starting' && inst._statsPrev !== 'starting') {
        inst._statsStart = Date.now();
        stats.onStart(id);
        bedrock.set(id, { ready: false, upnp: null });
      }
      if (snap.state === 'online' && inst._statsPrev !== 'online') webhook(id, 'start', '🟢 **{name}** is online.');
      inst._statsPrev = snap.state;
    });
    inst.on('player', ev => {
      if (ev.type === 'join') {
        stats.onJoin(id, ev.name, inst.players.get(ev.name)?.uuid);
        webhook(id, 'join', `➕ **${ev.name}** joined {name}.`);
      } else {
        stats.onLeave(id, ev.name);
        webhook(id, 'leave', `➖ **${ev.name}** left {name}.`);
      }
    });
    inst.on('metrics', m => send('server:metrics', { id, metrics: m }));
    inst.on('line', l => {
      if (l.source !== 'server') return;
      if (geyser.READY_RE.test(l.text)) { const b = bedrock.get(id) || {}; b.ready = true; bedrock.set(id, b); pushBedrock(id); }
      else if (geyser.FAIL_RE.test(l.text)) inst.info('Geyser couldn’t open the Bedrock port. Another server may be using it: change the Bedrock port in Public Access.');
    });
    inst.on('exit', (code, expected) => {
      const crashed = !expected && code !== 0;
      stats.onStop(id, { startedAt: inst._statsStart, crashed });
      store.updateServer(id, { lastPid: null });
      webhook(id, crashed ? 'crash' : 'stop', crashed ? `🔴 **{name}** crashed (exit ${code}).` : '⚪️ **{name}** stopped.');
      const b = bedrock.get(id);
      if (b?.upnp) mapper.unmap(b.upnp.port, 'udp').catch(() => {});
      bedrock.set(id, { ready: false, upnp: null });
      pushBedrock(id);
    });
  }

  // Called right before Java starts and right after the process exists.
  function beforeStart(cfg) {
    if (cfg.crossplay?.enabled) {
      try { geyser.applyConfig(cfg, { port: cfg.crossplay.port || geyser.DEFAULT_PORT }); } catch {}
    }
  }
  function afterStart(id, inst) {
    if (inst.proc?.pid) store.updateServer(id, { lastPid: inst.proc.pid });
  }

  // ---------- metrics sampling (every 10 s) ----------
  setInterval(() => {
    for (const [id, inst] of instances) {
      if (inst.state !== 'online') continue;
      const fresh = inst.metrics.at && Date.now() - inst.metrics.at < 45_000;
      stats.addPoint(id, {
        tps: fresh ? inst.metrics.tps : null, mspt: fresh ? inst.metrics.mspt : null,
        cpu: inst.stats.cpu, mem: inst.stats.memMB, players: inst.players.size,
      });
      const sw = inst.cfg.software;
      if (sw === 'paper' || sw === 'purpur') { inst.probe('tps', PROBE_ANSWERS.paper); inst.probe('mspt', PROBE_ANSWERS.paper); }
      else if (!inst.cfg.mcVersion || providers.compareVersions(inst.cfg.mcVersion, '1.20.3') >= 0) inst.probe('tick query', PROBE_ANSWERS.vanilla);
    }
  }, SAMPLE_MS);

  handle('stats:get', id => {
    const inst = instances.get(id);
    const online = inst?.isRunning() ? [...inst.players.keys()] : [];
    let worldBytes = null;
    return { ...stats.summary(id, online), worldBytes, supportsTps: tpsSupport(cfgOf(id)) };
  });
  handle('stats:worldSize', async id => {
    const cfg = cfgOf(id);
    const { worlds: list } = worlds.listServerWorlds(cfg.dir);
    let total = 0;
    for (const w of list) for (const f of [w.folder, ...(w.dims || [])]) total += (await worlds.dirSize(path.join(cfg.dir, f))) || 0;
    return total;
  });
  handle('stats:reset', id => { stats.forget(id); });
  function tpsSupport(cfg) {
    if (cfg.software === 'paper' || cfg.software === 'purpur') return 'full';
    if (!cfg.mcVersion || providers.compareVersions(cfg.mcVersion, '1.20.3') >= 0) return 'mspt';
    return 'none';
  }

  // ---------- Bedrock crossplay ----------
  const portOf = cfg => parseInt(files.readProperties(cfg.dir).values['server-port'] || '25565', 10) || 25565;
  function nextBedrockPort(exceptId) {
    const used = new Set(store.listServers().filter(c => c.id !== exceptId && c.crossplay?.enabled).map(c => c.crossplay.port || geyser.DEFAULT_PORT));
    let p = geyser.DEFAULT_PORT;
    while (used.has(p)) p++;
    return p;
  }
  function bedrockView(id) {
    const cfg = cfgOf(id);
    const cp = cfg.crossplay || {};
    const det = geyser.detect(cfg);
    const b = bedrock.get(id) || {};
    const port = cp.port || geyser.readPort(cfg) || geyser.DEFAULT_PORT;
    const tunnel = playit.tunnelForPort(port);
    const method = (cfg.access || {}).method || 'off';
    let publicAddress = null;
    if (method === 'playit' && tunnel?.address) publicAddress = tunnel.address;
    else if (b.upnp?.externalIP) publicAddress = `${b.upnp.externalIP}:${port}`;
    return {
      supported: geyser.supported(cfg), enabled: !!cp.enabled && !!det.geyser, installed: det, port,
      configExists: fs.existsSync(geyser.configPath(cfg)), ready: !!b.ready, upnp: b.upnp || null, upnpError: b.error || null,
      publicAddress, tunnel: tunnel || null,
    };
  }
  const pushBedrock = id => { try { send('bedrock:state', { id, view: bedrockView(id) }); } catch {} };

  handle('geyser:status', id => bedrockView(id));
  handle('geyser:install', async (id, taskId) => {
    const cfg = cfgOf(id);
    const log = message => send('task:progress', { taskId, message });
    const installed = { ...(cfg.modrinth || {}) };
    const port = cfg.crossplay?.port || nextBedrockPort(id);
    const r = await geyser.install(cfg, { installed, port, log });
    store.updateServer(id, { modrinth: installed, crossplay: { enabled: true, port } });
    if (instances.get(id)?.isRunning()) instances.get(id).info('Bedrock crossplay installed. Restart the server to turn it on.');
    log('Done! Bedrock players can join after the next (re)start.');
    return { ...r, view: bedrockView(id) };
  });
  handle('geyser:setEnabled', (id, on) => {
    const cfg = cfgOf(id);
    geyser.setEnabled(cfg, !!on);
    store.updateServer(id, { crossplay: { ...(cfg.crossplay || {}), enabled: !!on, port: cfg.crossplay?.port || nextBedrockPort(id) } });
    return bedrockView(id);
  });
  handle('geyser:setPort', (id, port) => {
    port = parseInt(port, 10);
    if (!(port >= 1024 && port <= 65535)) throw new Error('Pick a port between 1024 and 65535.');
    const cfg = store.updateServer(id, { crossplay: { ...(cfgOf(id).crossplay || {}), port } });
    geyser.applyConfig(cfg, { port });
    return bedrockView(id);
  });
  handle('geyser:createTunnel', async id => {
    const cfg = cfgOf(id);
    const t = await playit.createTunnel({ name: cfg.name, port: bedrockView(id).port, bedrock: true });
    pushBedrock(id);
    return t;
  });

  /** Server came online: open the Bedrock UDP port too (automatic port forwarding) or make sure a tunnel exists. */
  async function onOnline(id) {
    const cfg = store.getServer(id);
    if (!cfg?.crossplay?.enabled || !geyser.detect(cfg).geyser) return;
    const inst = instances.get(id);
    // Geyser writes its config on first start; patch it now so the next start uses our port/auth.
    const res = geyser.applyConfig(cfg, { port: cfg.crossplay.port || geyser.DEFAULT_PORT });
    if (res.changed) inst?.info('Bedrock settings updated. They take effect after the next restart.');
    const method = (cfg.access || {}).method || 'off';
    const port = cfg.crossplay.port || geyser.DEFAULT_PORT;
    if (method === 'upnp') {
      try {
        const info = await mapper.map(port, `Blockyard ${cfg.name} Bedrock`.slice(0, 40), 'udp');
        bedrock.set(id, { ...(bedrock.get(id) || {}), upnp: info, error: null });
        inst?.info(`Bedrock port ${port} (UDP) opened on your router.`);
      } catch (e) {
        bedrock.set(id, { ...(bedrock.get(id) || {}), upnp: null, error: e.message });
        inst?.info(`Couldn’t open the Bedrock port automatically: ${e.message}`);
      }
    } else if (method === 'playit' && playit.snapshot().agentId && !playit.tunnelForPort(port)) {
      playit.createTunnel({ name: cfg.name, port, bedrock: true }).then(() => inst?.info('playit: Bedrock tunnel created.')).catch(e => inst?.info(`playit: couldn’t create the Bedrock tunnel (${e.message}).`));
    }
    pushBedrock(id);
  }

  // ---------- worlds ----------
  const iconData = file => {
    try { const img = nativeImage.createFromPath(file); return img.isEmpty() ? null : img.resize({ width: 64, height: 64 }).toDataURL(); } catch { return null; }
  };
  handle('worlds:saves', dir => {
    const d = dir || worlds.defaultSavesDir();
    // A world folder itself (has level.dat) or a saves folder full of worlds.
    const list = fs.existsSync(path.join(d, 'level.dat')) ? worlds.listSaves(path.dirname(d)).filter(w => w.dir === d) : worlds.listSaves(d);
    return list.map(w => ({ ...w, icon: w.icon ? iconData(w.icon) : null }));
  });
  handle('worlds:savesDir', () => ({ default: worlds.defaultSavesDir(), exists: fs.existsSync(worlds.defaultSavesDir()) }));
  handle('worlds:accounts', () => worlds.launcherAccounts());
  handle('worlds:lookup', name => worlds.lookupPlayer(name));
  handle('worlds:list', async id => {
    const cfg = cfgOf(id);
    const r = worlds.listServerWorlds(cfg.dir);
    for (const w of r.worlds) {
      if (w.missing) continue;
      let size = 0;
      for (const f of [w.folder, ...w.dims]) size += (await worlds.dirSize(path.join(cfg.dir, f))) || 0;
      w.size = size;
    }
    return r;
  });
  handle('worlds:importSave', (id, opts) => {
    const cfg = cfgOf(id);
    const inst = instances.get(id);
    if (opts.setActive && inst?.isRunning()) throw new Error('Stop the server first: switching worlds needs a restart anyway.');
    const done = worlds.copySaveToServer({ worldDir: opts.worldDir, serverDir: cfg.dir, targetName: opts.targetName || 'world', player: opts.player, makeOp: !!opts.makeOp });
    if (opts.setActive) {
      const props = opts.applySettings === false ? { 'level-name': opts.targetName || 'world' } : worlds.propsForWorld(done.info, opts.targetName || 'world');
      files.writeProperties(cfg.dir, props);
    }
    const iconSrc = path.join(opts.worldDir, 'icon.png');
    const iconDst = path.join(cfg.dir, 'server-icon.png');
    if (opts.copyIcon !== false && fs.existsSync(iconSrc) && !fs.existsSync(iconDst)) {
      try { fs.writeFileSync(iconDst, nativeImage.createFromPath(iconSrc).resize({ width: 64, height: 64, quality: 'best' }).toPNG()); } catch {}
    }
    return { ...done, dest: path.basename(done.dest) };
  });
  handle('worlds:setActive', (id, folder) => {
    const cfg = cfgOf(id);
    if (!fs.existsSync(path.join(cfg.dir, folder, 'level.dat'))) throw new Error('That world folder is missing.');
    files.writeProperties(cfg.dir, { 'level-name': folder });
    return { restartNeeded: !!instances.get(id)?.isRunning() };
  });
  handle('worlds:reset', async (id, folder, { seed } = {}) => {
    const cfg = cfgOf(id);
    if (instances.get(id)?.isRunning()) throw new Error('Stop the server before resetting a world.');
    await runBackup(id, 'manual', 'world').catch(e => { if (!/no world folder/i.test(e.message)) throw e; });
    for (const f of [folder, `${folder}_nether`, `${folder}_the_end`]) {
      const p = files.safe(cfg.dir, f);
      if (fs.existsSync(p)) await shell.trashItem(p);
    }
    files.writeProperties(cfg.dir, { 'level-seed': seed == null ? '' : String(seed) });
    return { ok: true };
  });
  handle('worlds:trash', async (id, folder) => {
    const cfg = cfgOf(id);
    const active = files.readProperties(cfg.dir).values['level-name'] || 'world';
    if (folder === active) throw new Error('That’s the active world. Switch to another world first.');
    for (const f of [folder, `${folder}_nether`, `${folder}_the_end`]) {
      const p = files.safe(cfg.dir, f);
      if (fs.existsSync(p)) await shell.trashItem(p);
    }
  });
  handle('worlds:exportToSaves', async (id, folder, opts = {}) => {
    const cfg = cfgOf(id);
    const inst = instances.get(id);
    const live = inst?.state === 'online';
    if (live) {
      inst.send('save-off');
      const saved = inst.waitForLine(/Saved the game|Saved the world|All dimensions are saved/i, 60000);
      inst.send('save-all flush');
      try { await saved; } catch {}
    }
    try {
      return worlds.copyServerWorldToSaves({ serverDir: cfg.dir, folder, newName: opts.newName, player: opts.player });
    } finally { if (live && inst.isRunning()) inst.send('save-on'); }
  });
  handle('worlds:openSaves', () => { const d = worlds.defaultSavesDir(); fs.mkdirSync(d, { recursive: true }); return shell.openPath(d); });

  // ---------- change Minecraft version ----------
  handle('server:changeVersion', async (id, mcVersion, taskId) => {
    const cfg = cfgOf(id);
    const log = (message, pct) => send('task:progress', { taskId, message, pct });
    if (instances.get(id)?.isRunning()) throw new Error('Stop the server first.');
    if (cfg.mcVersion && providers.compareVersions(mcVersion, cfg.mcVersion) < 0) {
      throw new Error(`Minecraft can’t downgrade a world (${cfg.mcVersion} → ${mcVersion}); it would corrupt it. Restore an older backup instead, or create a new server.`);
    }
    const sw = providers.SOFTWARE[cfg.software];
    if (!sw) throw new Error('Unknown server software.');
    log('Backing up the world first…');
    await runBackup(id, 'manual', 'world').catch(e => { if (!/no world folder/i.test(e.message)) throw e; });
    const javaMajor = await providers.javaMajorFor(mcVersion);
    let javaPath = null;
    const getJava = async () => (javaPath ||= await java.ensure(javaMajor, log));
    await getJava();
    log(`Installing ${sw.label} ${mcVersion}…`);
    const { launchArgs } = await sw.install({ mcVersion, dir: cfg.dir, log, getJava });
    const updated = store.updateServer(id, { mcVersion, javaMajor, launchArgs, javaPath: cfg.javaPath && fs.existsSync(cfg.javaPath) && javaMajor === cfg.javaMajor ? cfg.javaPath : '' });
    if (instances.has(id)) instances.get(id).cfg = updated;
    log(`Now on ${sw.label} ${mcVersion}. Check Plugins/Mods for updates before starting.`, 1);
    return updated;
  });

  // ---------- plugin/mod updates ----------
  const installedMap = cfg => {
    const folder = path.join(cfg.dir, cfg.kind === 'plugins' ? 'plugins' : 'mods');
    return Object.fromEntries(Object.entries(cfg.modrinth || {}).filter(([, v]) => fs.existsSync(path.join(folder, v.file)) || fs.existsSync(path.join(folder, v.file + '.disabled'))));
  };
  handle('modrinth:checkUpdates', async id => {
    const cfg = cfgOf(id);
    const out = [];
    for (const [pid, info] of Object.entries(installedMap(cfg))) {
      try {
        const v = await modrinth.bestVersion(cfg, pid);
        if (v && v.id !== info.versionId) out.push({ projectId: pid, title: info.title || pid, current: info.version, latest: v.version_number });
      } catch {}
    }
    return out;
  });
  handle('modrinth:updateAll', async (id, projectIds, taskId) => {
    const cfg = cfgOf(id);
    const installed = { ...installedMap(cfg) };
    const done = [];
    for (const pid of projectIds) {
      send('task:progress', { taskId, message: `Updating ${installed[pid]?.title || pid}…` });
      try { done.push(...await modrinth.install(cfg, pid, { installed, log: message => send('task:progress', { taskId, message }) })); } catch (e) { send('task:progress', { taskId, message: `Skipped: ${e.message}` }); }
    }
    store.updateServer(id, { modrinth: installed });
    return done;
  });

  // ---------- scheduled commands ----------
  const lastRun = new Map();
  function tick(now = Date.now()) {
    for (const cfg of store.listServers()) {
      const inst = instances.get(cfg.id);
      if (!inst || inst.state !== 'online') continue;
      for (const sch of cfg.schedules || []) {
        if (!sch.enabled || !sch.command || !(sch.every > 0)) continue;
        const key = `${cfg.id}:${sch.id}`;
        const last = Math.max(lastRun.get(key) || 0, inst.startedAt || 0);
        if (now - last >= sch.every * 60_000) {
          lastRun.set(key, now);
          try { inst.send(sch.command); } catch {}
        }
      }
    }
  }
  setInterval(tick, 15_000);

  // ---------- Discord webhooks ----------
  const WEBHOOK_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;
  async function postWebhook(url, content) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, username: 'Blockyard', allowed_mentions: { parse: [] } }) });
    if (!r.ok && r.status !== 204) throw new Error(`Discord answered HTTP ${r.status}. Check the webhook URL.`);
  }
  function webhook(id, event, template) {
    const cfg = store.getServer(id);
    const w = cfg?.webhook;
    if (!w?.url || !WEBHOOK_RE.test(w.url) || w.events?.[event] === false) return;
    if ((event === 'join' || event === 'leave') && !w.events?.[event]) return; // player events are opt-in
    postWebhook(w.url, template.replace('{name}', cfg.name.replace(/[*_`~|]/g, ''))).catch(() => {});
  }
  handle('webhook:test', async url => {
    if (!WEBHOOK_RE.test(String(url).trim())) throw new Error('That doesn’t look like a Discord webhook URL (Server Settings → Integrations → Webhooks → Copy Webhook URL).');
    await postWebhook(String(url).trim(), '👋 Blockyard is connected. Server notifications will appear here.');
  });

  // ---------- logs & crash reports ----------
  handle('logs:list', id => {
    const cfg = cfgOf(id);
    const out = [];
    for (const [folder, re, kind] of [['logs', /\.(log|log\.gz)$/i, 'log'], ['crash-reports', /\.txt$/i, 'crash']]) {
      let entries = [];
      try { entries = fs.readdirSync(path.join(cfg.dir, folder)); } catch {}
      for (const f of entries) {
        if (!re.test(f)) continue;
        const st = fs.statSync(path.join(cfg.dir, folder, f));
        out.push({ rel: `${folder}/${f}`, name: f, kind, size: st.size, time: st.mtimeMs });
      }
    }
    return out.sort((a, b) => (b.name === 'latest.log') - (a.name === 'latest.log') || b.time - a.time);
  });
  handle('logs:read', (id, rel) => {
    const p = files.safe(cfgOf(id).dir, rel);
    if (!/^(logs|crash-reports)\//.test(rel)) throw new Error('Only log files can be opened here.');
    let buf = fs.readFileSync(p);
    if (/\.gz$/i.test(p)) buf = zlib.gunzipSync(buf);
    const max = 1.5 * 1024 * 1024;
    const text = buf.length > max ? '…(start of file cut, showing the last 1.5 MB)…\n' + buf.subarray(buf.length - max).toString('utf8') : buf.toString('utf8');
    return text.replace(/\x1b\[[0-9;]*m/g, '');
  });

  // ---------- servers left running after Blockyard quit unexpectedly ----------
  function pidInfo(pid) {
    return new Promise(resolve => execFile('ps', ['-o', 'command=', '-p', String(pid)], (err, out) => resolve(err ? null : String(out).trim())));
  }
  async function recoverOrphans() {
    for (const cfg of store.listServers()) {
      if (!cfg.lastPid) continue;
      let alive = false;
      try { process.kill(cfg.lastPid, 0); alive = true; } catch {}
      const cmd = alive ? await pidInfo(cfg.lastPid) : null;
      const ours = cmd && /java/.test(cmd) && (cfg.launchArgs || []).filter(a => !a.startsWith('-') && a.length > 3).some(a => cmd.includes(a));
      if (!ours) { store.updateServer(cfg.id, { lastPid: null }); continue; }
      const r = await dialog.showMessageBox(getWin() || undefined, {
        type: 'warning', message: `${cfg.name} is still running in the background`,
        detail: 'Blockyard closed unexpectedly while this server was running, so Blockyard can’t show its console. Stop it safely now (the world is saved first), then start it again from Blockyard.',
        buttons: ['Stop Server Safely', 'Leave It Running'], defaultId: 0, cancelId: 1,
      });
      if (r.response !== 0) continue;
      try { process.kill(cfg.lastPid, 'SIGTERM'); } catch {} // Minecraft saves and shuts down on SIGTERM
      for (let i = 0; i < 60; i++) {
        await new Promise(res => setTimeout(res, 1000));
        try { process.kill(cfg.lastPid, 0); } catch { break; }
        if (i === 59) { try { process.kill(cfg.lastPid, 'SIGKILL'); } catch {} }
      }
      store.updateServer(cfg.id, { lastPid: null });
    }
  }

  return { attach, beforeStart, afterStart, onOnline, recoverOrphans, stats, bedrockView, flush: () => stats.flushAll() };
};
