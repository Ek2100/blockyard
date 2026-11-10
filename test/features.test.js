// Run: node --test test/features.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

delete process.env.JAVA_TOOL_OPTIONS;
const FAKE = path.join(__dirname, 'fake');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'byf-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// fetch: local http goes to the real network stack (fake router); everything else is mocked.
const realFetch = global.fetch;
const routes = {};
const calls = [];
global.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  calls.push({ url, opts });
  let r = routes[url] ?? routes[url.split('?')[0]];
  if (typeof r === 'function') r = await r(url, opts);
  if (r === undefined) return { ok: false, status: 404, headers: { get: () => null }, text: async () => '{}', json: async () => ({}) };
  const buf = Buffer.isBuffer(r) ? r : null;
  return {
    ok: true, status: 200,
    headers: { get: k => (k === 'content-length' && buf ? String(buf.length) : null) },
    json: async () => r, text: async () => (typeof r === 'string' ? r : JSON.stringify(r)),
    body: (async function* () { if (buf) yield buf; })(),
  };
};

const { PortMapper, testReachable, isCgnat, isPrivate } = require('../src/main/portmap');
const { startRouter } = require('./fake/router');
const { Playit } = require('../src/main/playit');
const { ServerInstance } = require('../src/main/server-instance');
const backups = require('../src/main/backups');
const modrinth = require('../src/main/modrinth');
const files = require('../src/main/files');

// ---------- port forwarding ----------
test('address classification', () => {
  assert.ok(isCgnat('100.72.1.9')); assert.ok(!isCgnat('101.0.0.1'));
  assert.ok(isPrivate('192.168.1.1') && isPrivate('10.2.3.4') && isPrivate('172.20.0.1') && !isPrivate('172.32.0.1') && !isPrivate('8.8.8.8'));
});

test('NAT-PMP mapping, renewal info and unmap', async () => {
  const router = await startRouter();
  const pm = new PortMapper({ gateway: '127.0.0.1', lanIp: '192.168.1.50', pmpPort: router.pmpPort, locations: [router.location], firstTimeout: 100 });
  const info = await pm.map(25565);
  assert.equal(info.via, 'NAT-PMP');
  assert.equal(info.externalIP, '203.0.113.7');
  assert.equal(info.externalPort, 25565);
  assert.equal(info.lifetime, 3600);
  assert.deepEqual(router.state.pmpMaps.get(25565), { external: 25565, life: 3600 });
  await pm.unmap(25565);
  assert.equal(router.state.pmpMaps.size, 0);
  assert.equal(pm.info(25565), null);
  router.close();
});

test('falls back to UPnP when NAT-PMP is off; handles permanent-only routers', async () => {
  const router = await startRouter({ pmpEnabled: false, upnpPermanentOnly: true });
  const pm = new PortMapper({ gateway: '127.0.0.1', lanIp: '192.168.1.50', pmpPort: router.pmpPort, locations: [router.location], firstTimeout: 100 });
  const info = await pm.map(25570, 'Blockyard Test');
  assert.equal(info.via, 'UPnP');
  assert.equal(info.lifetime, 0, 'retried as a permanent mapping after error 725');
  assert.equal(info.externalIP, '203.0.113.7');
  assert.deepEqual(router.state.upnpMaps.get(25570), { client: '192.168.1.50', lease: 0 });
  await pm.unmapAll();
  assert.equal(router.state.upnpMaps.size, 0);
  router.close();
});

test('UPnP conflicts: leftover rule for us is replaced, another device is reported', async () => {
  const router = await startRouter({ pmpEnabled: false, conflicts: { 25580: '192.168.1.50', 25581: '192.168.1.99' } });
  const pm = new PortMapper({ gateway: '127.0.0.1', lanIp: '192.168.1.50', pmpPort: router.pmpPort, locations: [router.location], firstTimeout: 100 });
  const ok = await pm.map(25580);
  assert.equal(ok.via, 'UPnP');
  assert.equal(router.state.upnpMaps.get(25580).client, '192.168.1.50');
  await assert.rejects(pm.map(25581), /already forwarded to another device \(192\.168\.1\.99\)/);
  await pm.unmapAll();
  router.close();
});

test('router with nothing enabled gives a helpful error', async () => {
  const router = await startRouter({ pmpEnabled: false, upnpEnabled: false });
  const pm = new PortMapper({ gateway: '127.0.0.1', lanIp: '192.168.1.50', pmpPort: router.pmpPort, locations: [router.location], firstTimeout: 100 });
  await assert.rejects(pm.map(25565), /Turn on UPnP .* playit\.gg .*NAT-PMP: not authorized.*UPnP: the router refused/s);
  router.close();
});

test('diagnose detects CGNAT and double NAT', async () => {
  routes['https://api.ipify.org?format=json'] = { ip: '198.51.100.20' };
  let router = await startRouter({ externalIP: '100.70.3.4' });
  let pm = new PortMapper({ gateway: '127.0.0.1', lanIp: '192.168.1.50', pmpPort: router.pmpPort, locations: [router.location], firstTimeout: 100 });
  let d = await pm.diagnose();
  assert.deepEqual([d.publicIP, d.routerIP, d.natpmp, d.upnp, d.nat], ['198.51.100.20', '100.70.3.4', true, true, 'cgnat']);
  router.close();
  router = await startRouter({ externalIP: '192.168.0.2', pmpEnabled: false });
  pm = new PortMapper({ gateway: '127.0.0.1', lanIp: '192.168.1.50', pmpPort: router.pmpPort, locations: [router.location], firstTimeout: 100 });
  d = await pm.diagnose();
  assert.deepEqual([d.natpmp, d.upnp, d.nat], [false, true, 'double']);
  router.close();
  router = await startRouter({ externalIP: '198.51.100.20' });
  pm = new PortMapper({ gateway: '127.0.0.1', lanIp: '192.168.1.50', pmpPort: router.pmpPort, locations: [router.location], firstTimeout: 100 });
  assert.equal((await pm.diagnose()).nat, 'ok');
  router.close();
});

test('reachability test via mcsrvstat, falls back to mcstatus.io', async () => {
  routes['https://api.mcsrvstat.us/3/198.51.100.20%3A25570'] = { online: true, players: { online: 1, max: 20 }, version: '1.21.4' };
  let r = await testReachable('198.51.100.20', 25570);
  assert.deepEqual([r.online, r.via, r.target], [true, 'mcsrvstat.us', '198.51.100.20:25570']);
  routes['https://api.mcstatus.io/v2/status/java/x.joinmc.link'] = { online: false };
  r = await testReachable('x.joinmc.link', 25565);
  assert.deepEqual([r.online, r.via], [false, 'mcstatus.io']);
});

// ---------- playit ----------
test('playit: install, start, link account, create tunnel, stop', async () => {
  const dir = tmp();
  // Build a tarball shaped like playit-macos-universal.tar.gz
  const stage = path.join(tmp(), 'playit-macos-universal');
  fs.mkdirSync(stage);
  fs.copyFileSync(path.join(FAKE, 'fake-playitd.js'), path.join(stage, 'playitd'));
  fs.writeFileSync(path.join(stage, 'playit'), '#!/bin/sh\necho cli\n');
  const tgz = path.join(path.dirname(stage), 'p.tgz');
  execFileSync('tar', ['-czf', tgz, '-C', path.dirname(stage), 'playit-macos-universal']);
  routes['https://dl/playit.tgz'] = fs.readFileSync(tgz);

  const p = new Playit(dir, { downloadUrl: 'https://dl/playit.tgz', socketPath: path.join(dir, 's.sock') });
  const events = [];
  p.on('state', s => events.push(s));
  assert.equal(p.installed(), false);
  await assert.rejects(p.start(), /Install the playit agent/);
  const prog = [];
  await p.install((m, pct) => prog.push([m, pct]));
  assert.ok(p.installed());
  assert.ok(fs.statSync(path.join(dir, 'bin/playitd')).mode & 0o111, 'executable');
  assert.ok(prog.some(([, pct]) => pct === 1));

  await p.start();
  let s = p.snapshot();
  assert.equal(s.daemon, 'running');
  assert.equal(s.needsLink, true);

  // claim flow against the mocked playit API
  let setupCalls = 0, exchangeCalls = 0;
  routes['https://api.playit.gg/claim/setup'] = (_u, o) => {
    const body = JSON.parse(o.body);
    assert.match(body.code, /^[0-9a-f]{10}$/);
    assert.equal(body.agent_type, 'assignable');
    return { status: 'success', data: ['WaitingForUserVisit', 'WaitingForUser', 'UserAccepted'][Math.min(2, setupCalls++)] };
  };
  routes['https://api.playit.gg/claim/exchange'] = () => (exchangeCalls++ ? { status: 'success', data: { secret_key: 'ab'.repeat(32) } } : { status: 'fail', data: 'NotAccepted' });
  let opened = null;
  await p.link(url => { opened = url; }, { pollMs: 20 });
  assert.match(opened, /^https:\/\/playit\.gg\/claim\/[0-9a-f]{10}$/);
  assert.equal(p.secret(), 'ab'.repeat(32));
  for (let i = 0; i < 50 && !p.snapshot().agentId; i++) await sleep(20);
  s = p.snapshot();
  assert.equal(s.needsLink, false);
  assert.equal(s.agentId, '11111111-2222-3333-4444-555555555555');
  assert.equal(s.accountStatus, 'guest');
  assert.equal(s.claim.status, 'done');
  assert.ok(events.some(e => e.claim?.status === 'waiting_for_approval'), 'claim progress was reported');

  // tunnel creation: verify the request, then make the fake daemon report the tunnel
  routes['https://api.playit.gg/tunnels/create'] = (_u, o) => {
    assert.equal(o.headers.Authorization, `Agent-Key ${'ab'.repeat(32)}`);
    const b = JSON.parse(o.body);
    assert.equal(b.tunnel_type, 'minecraft-java');
    assert.equal(b.port_type, 'tcp');
    assert.deepEqual(b.origin, { type: 'agent', data: { agent_id: '11111111-2222-3333-4444-555555555555', local_ip: '127.0.0.1', local_port: 25570 } });
    setTimeout(() => fs.writeFileSync(path.join(dir, 'tunnels.json'), JSON.stringify([{ id: 't1', display_address: 'friendly-cat.joinmc.link', destination: '127.0.0.1:25570', is_disabled: false, disabled_reason: null }])), 150);
    return { status: 'success', data: { id: 't1' } };
  };
  const t = await p.createTunnel({ name: 'Friends SMP ☃', port: 25570 });
  assert.equal(t.address, 'friendly-cat.joinmc.link');
  assert.equal(p.tunnelForPort(25570).id, 't1');
  assert.equal(p.tunnelForPort(25571), null);
  // creating again is a no-op
  routes['https://api.playit.gg/tunnels/create'] = () => { throw new Error('should not be called'); };
  assert.equal((await p.createTunnel({ name: 'x', port: 25570 })).id, 't1');

  // API errors are explained
  routes['https://api.playit.gg/tunnels/create'] = { status: 'fail', data: 'RequiresVerifiedAccount' };
  await assert.rejects(p.createTunnel({ name: 'x', port: 25599 }), /verify your email/);

  p.stop();
  await p.waitForExit();
  assert.equal(p.snapshot().daemon, 'stopped');
  assert.equal(p.snapshot().error, null, 'a requested stop is not an error');
});

test('playit: declined link is reported', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.copyFileSync(path.join(FAKE, 'fake-playitd.js'), path.join(dir, 'bin/playitd'));
  fs.chmodSync(path.join(dir, 'bin/playitd'), 0o755);
  const p = new Playit(dir, { socketPath: path.join(dir, 's.sock') });
  routes['https://api.playit.gg/claim/setup'] = { status: 'success', data: 'UserRejected' };
  await assert.rejects(p.link(() => {}, { pollMs: 10 }), /declined/);
  assert.equal(p.snapshot().claim.status, 'failed');
  p.stop(); await p.waitForExit();
});

// ---------- backups ----------
let JAVA;
test('backups: live world backup with save-off/save-all, prune, restore', async () => {
  JAVA = execFileSync('sh', ['-c', 'readlink -f $(which java)']).toString().trim();
  const dir = tmp();
  fs.copyFileSync(path.join(FAKE, 'server.jar'), path.join(dir, 'server.jar'));
  files.writeProperties(dir, { 'server-port': '25621', 'level-name': 'world' });
  fs.mkdirSync(path.join(dir, 'world/region'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'world_nether'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'world/level.dat'), 'v1');
  fs.writeFileSync(path.join(dir, 'world/session.lock'), 'lock');
  fs.writeFileSync(path.join(dir, 'world_nether/n.dat'), 'nether');
  fs.writeFileSync(path.join(dir, 'ops.json'), '[]');
  const cfg = { id: 'b', name: 'B', dir, launchArgs: ['-jar', 'server.jar'] };

  await assert.rejects(backups.create({ ...cfg, dir: tmp() }), /no world folder/);

  const inst = new ServerInstance(cfg);
  await inst.start(JAVA, { keepAwake: false });
  for (let i = 0; i < 100 && inst.state !== 'online'; i++) await sleep(50);
  const b = await backups.create(cfg, { inst, reason: 'manual' });
  const cmds = inst.log.filter(l => l.source === 'cmd').map(l => l.text);
  assert.deepEqual(cmds, ['save-off', 'save-all flush', 'save-on']);
  assert.match(b.file, /^world-\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d-manual\.zip$/);
  assert.equal(b.label, 'Manual');
  const listing = execFileSync('unzip', ['-Z1', path.join(dir, 'backups', b.file)]).toString();
  assert.match(listing, /world\/level\.dat/); assert.match(listing, /world_nether\/n\.dat/); assert.match(listing, /ops\.json/);
  assert.doesNotMatch(listing, /session\.lock|server\.jar/);
  inst.stop(); await inst.waitForExit();

  // full backup skips logs/libraries/backups
  fs.mkdirSync(path.join(dir, 'logs')); fs.writeFileSync(path.join(dir, 'logs/latest.log'), 'x');
  const full = await backups.create(cfg, { scope: 'full', reason: 'manual' });
  const fl = execFileSync('unzip', ['-Z1', path.join(dir, 'backups', full.file)]).toString();
  assert.match(fl, /server\.jar/); assert.doesNotMatch(fl, /logs\/|backups\//);

  // prune keeps the newest N scheduled backups only
  for (let i = 0; i < 3; i++) { await sleep(1100); await backups.create(cfg, { reason: 'auto' }); }
  const removed = backups.prune(cfg, 2);
  assert.equal(removed.length, 1);
  assert.equal(backups.list(cfg).filter(x => x.label === 'Scheduled').length, 2);
  assert.equal(backups.list(cfg).filter(x => x.label === 'Manual').length, 2);

  // restore replaces the world and keeps a safety copy
  fs.writeFileSync(path.join(dir, 'world/level.dat'), 'v2-griefed');
  fs.writeFileSync(path.join(dir, 'world/region/new.mca'), 'new');
  await sleep(1100);
  await backups.restore(cfg, b.file);
  assert.equal(fs.readFileSync(path.join(dir, 'world/level.dat'), 'utf8'), 'v1');
  assert.ok(!fs.existsSync(path.join(dir, 'world/region/new.mca')), 'world folder was replaced, not merged');
  assert.ok(backups.list(cfg).some(x => x.label === 'Before restore'));
});

test('server emits join/leave events and waitForLine works', async () => {
  const dir = tmp();
  fs.copyFileSync(path.join(FAKE, 'server.jar'), path.join(dir, 'server.jar'));
  files.writeProperties(dir, { 'server-port': '25622' });
  const inst = new ServerInstance({ id: 'p', name: 'P', dir, launchArgs: ['-jar', 'server.jar'] });
  const evs = [];
  inst.on('player', e => evs.push(`${e.type}:${e.name}`));
  await inst.start(JAVA, { keepAwake: false });
  await inst.waitForLine(/Done \(/, 8000);
  inst.send('join Steve'); inst.send('leave Steve');
  await inst.waitForLine(/Steve left the game/, 5000);
  assert.deepEqual(evs, ['join:Steve', 'leave:Steve']);
  await assert.rejects(inst.waitForLine(/never/, 200), /timeout/);
  inst.stop(); await inst.waitForExit();
});

// ---------- Modrinth ----------
test('modrinth search uses loader/version facets and install resolves deps + checks sha512', async () => {
  const cfg = { dir: tmp(), kind: 'plugins', software: 'paper', mcVersion: '1.21.4' };
  routes['https://api.modrinth.com/v2/search'] = url => {
    const q = new URL(url).searchParams;
    assert.deepEqual(JSON.parse(q.get('facets')), [['categories:paper', 'categories:spigot', 'categories:bukkit'], ['project_type:plugin'], ['versions:1.21.4']]);
    assert.equal(q.get('query'), 'essentials');
    return { total_hits: 1, hits: [{ project_id: 'ESS', slug: 'essentialsx', title: 'EssentialsX', description: 'd', icon_url: 'https://cdn.modrinth.com/x.png', downloads: 5, author: 'a', display_categories: ['utility'] }] };
  };
  const s = await modrinth.search(cfg, { query: 'essentials' });
  assert.equal(s.hits[0].id, 'ESS');

  const jarA = Buffer.from('plugin-a'); const jarDep = Buffer.from('dep-lib');
  const sha = b => crypto.createHash('sha512').update(b).digest('hex');
  routes['https://api.modrinth.com/v2/project/ESS/version'] = url => {
    const q = new URL(url).searchParams;
    assert.deepEqual(JSON.parse(q.get('loaders')), ['paper', 'spigot', 'bukkit']);
    assert.deepEqual(JSON.parse(q.get('game_versions')), ['1.21.4']);
    return [
      { id: 'v-beta', version_type: 'beta', version_number: '3.0-b', files: [] },
      { id: 'v2', version_type: 'release', version_number: '2.21.0', name: 'EssentialsX 2.21.0', files: [{ primary: true, filename: 'EssentialsX-2.21.0.jar', url: 'https://cdn/ess.jar', hashes: { sha512: sha(jarA) } }], dependencies: [{ dependency_type: 'required', project_id: 'VAULT' }, { dependency_type: 'optional', project_id: 'NOPE' }] },
    ];
  };
  routes['https://cdn/ess.jar'] = jarA;
  routes['https://api.modrinth.com/v2/project/VAULT'] = { title: 'Vault' };
  routes['https://api.modrinth.com/v2/project/VAULT/version'] = [{ id: 'vv', version_type: 'release', version_number: '1.7', files: [{ primary: true, filename: 'Vault.jar', url: 'https://cdn/vault.jar', hashes: { sha512: sha(jarDep) } }], dependencies: [{ dependency_type: 'required', project_id: 'ESS' }] }];
  routes['https://cdn/vault.jar'] = jarDep;
  const installed = {};
  const logs = [];
  const res = await modrinth.install(cfg, 'ESS', { installed, log: m => logs.push(m) });
  assert.deepEqual(res.map(r => r.file), ['EssentialsX-2.21.0.jar', 'Vault.jar']);
  assert.ok(fs.existsSync(path.join(cfg.dir, 'plugins/EssentialsX-2.21.0.jar')));
  assert.ok(fs.existsSync(path.join(cfg.dir, 'plugins/Vault.jar')));
  assert.equal(installed.VAULT.title, 'Vault');
  assert.ok(logs.some(l => /required dependency Vault/.test(l)));

  // reinstalling the same version is a no-op; a corrupted download is rejected
  const before = calls.length;
  await modrinth.install(cfg, 'ESS', { installed });
  assert.ok(!calls.slice(before).some(c => c.url === 'https://cdn/ess.jar'), 'no re-download');
  routes['https://api.modrinth.com/v2/project/BAD/version'] = [{ id: 'b', version_type: 'release', files: [{ filename: 'Bad.jar', url: 'https://cdn/bad.jar', hashes: { sha512: 'deadbeef' } }] }];
  routes['https://cdn/bad.jar'] = Buffer.from('tampered');
  await assert.rejects(modrinth.install(cfg, 'BAD', { installed: {} }), /checksum/);
  assert.ok(!fs.existsSync(path.join(cfg.dir, 'plugins/Bad.jar')));

  // no compatible version
  routes['https://api.modrinth.com/v2/project/OLD/version'] = [];
  await assert.rejects(modrinth.install(cfg, 'OLD', { installed: {} }), /No version of this plugin supports paper 1\.21\.4/);

  // mods use the loader + server_side facets
  const mcfg = { dir: tmp(), kind: 'mods', software: 'fabric', mcVersion: '26.1' };
  routes['https://api.modrinth.com/v2/search'] = url => {
    assert.deepEqual(JSON.parse(new URL(url).searchParams.get('facets')), [['categories:fabric'], ['project_type:mod'], ['versions:26.1'], ['server_side:required', 'server_side:optional']]);
    return { total_hits: 0, hits: [] };
  };
  assert.equal((await modrinth.search(mcfg, {})).total, 0);
});
