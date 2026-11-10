// Blockyard 1.2 backend tests: NBT, worlds import/export, Geyser, TPS probes, stats, UDP port mapping.
// Run: node --test test/v12.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

delete process.env.JAVA_TOOL_OPTIONS;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'by12-'));
const nbt = require('../src/main/nbt');
const worlds = require('../src/main/worlds');
const geyser = require('../src/main/geyser');
const files = require('../src/main/files');
const { StatsStore } = require('../src/main/stats');
const { ServerInstance, PROBE_ANSWERS } = require('../src/main/server-instance');
const java = require('../src/main/java');

// ---------- fetch mock ----------
const routes = {};
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(url, opts); // fake router

  const r = typeof routes[url] === 'function' ? routes[url]() : routes[url];
  if (r === undefined) return { ok: false, status: 404, headers: { get: () => null } };
  const buf = Buffer.isBuffer(r) ? r : null;
  return {
    ok: true, status: 200, headers: { get: k => (k === 'content-length' && buf ? String(buf.length) : null) },
    json: async () => r, text: async () => JSON.stringify(r),
    body: (async function* () { if (buf) yield buf; })(),
  };
};

// ---------- helpers to build realistic worlds ----------
const S = (value) => ({ type: nbt.T.String, value });
const I = (value) => ({ type: nbt.T.Int, value });
const B = (value) => ({ type: nbt.T.Byte, value });
const L = (value) => ({ type: nbt.T.Long, value: BigInt(value) });
const C = (entries) => ({ type: nbt.T.Compound, value: new Map(Object.entries(entries)) });
function makeWorld(dir, { name = 'My World', version = '1.21.4', gameType = 1, difficulty = 3, player = true } = {}) {
  fs.mkdirSync(path.join(dir, 'region'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'region', 'r.0.0.mca'), crypto.randomBytes(4096));
  fs.mkdirSync(path.join(dir, 'DIM-1', 'region'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'DIM-1', 'region', 'r.0.0.mca'), 'nether');
  fs.writeFileSync(path.join(dir, 'session.lock'), '☃');
  const data = {
    LevelName: S(name), DataVersion: I(4189), GameType: I(gameType), Difficulty: B(difficulty), hardcore: B(0), allowCommands: B(1),
    LastPlayed: L(1731200000000), Version: C({ Name: S(version), Id: I(4189), Snapshot: B(0) }),
    ServerBrands: { type: nbt.T.List, value: { itemType: nbt.T.String, items: ['vanilla'] } },
  };
  if (player) data.Player = C({ XpLevel: I(42), Dimension: S('minecraft:overworld'), CustomName: S('Steve 🐑') });
  fs.writeFileSync(path.join(dir, 'level.dat'), nbt.write({ name: '', root: new Map([['Data', C(data)]]) }));
}

// ---------- NBT ----------
test('NBT parses the canonical hello-world example', () => {
  // From the NBT spec: TAG_Compound("hello world") { TAG_String("name"): "Bananrama" }
  const bytes = Buffer.from('0a000b68656c6c6f20776f726c640800046e616d65000942616e616e72616d6100', 'hex');
  const { name, root } = nbt.parse(bytes);
  assert.equal(name, 'hello world');
  assert.equal(nbt.get(root, 'name'), 'Bananrama');
});

test('NBT round-trips every tag type, modified UTF-8 included', () => {
  const root = new Map(Object.entries({
    b: B(-5), s: { type: nbt.T.Short, value: -1234 }, i: I(2147483647), l: L('-9007199254740993'),
    f: { type: nbt.T.Float, value: 1.5 }, d: { type: nbt.T.Double, value: Math.PI },
    ba: { type: nbt.T.ByteArray, value: Buffer.from([1, 2, 255]) }, str: S('nul\u0000 and emoji 🐑 and é'),
    list: { type: nbt.T.List, value: { itemType: nbt.T.Int, items: [1, 2, 3] } },
    empty: { type: nbt.T.List, value: { itemType: nbt.T.End, items: [] } },
    ia: { type: nbt.T.IntArray, value: Int32Array.from([-1, 0, 7]) },
    la: { type: nbt.T.LongArray, value: BigInt64Array.from([1n, -2n]) },
    nested: C({ deep: C({ x: S('y') }) }),
  }));
  const out = nbt.write({ name: 'root', root });
  const back = nbt.parse(out);
  assert.equal(back.name, 'root');
  assert.equal(nbt.get(back.root, 'str'), 'nul\u0000 and emoji 🐑 and é');
  assert.equal(nbt.get(back.root, 'l'), -9007199254740993n);
  assert.deepEqual([...nbt.get(back.root, 'ia')], [-1, 0, 7]);
  assert.equal(nbt.get(back.root, 'nested', 'deep', 'x'), 'y');
  assert.deepEqual(nbt.write(back), out, 'second write is byte-identical');
  // Java writes NUL as C0 80 and the sheep as a surrogate pair (6 bytes), never a 4-byte sequence
  const enc = nbt.mutf8Encode('\u0000🐑');
  assert.deepEqual([...enc], [0xc0, 0x80, 0xed, 0xa0, 0xbd, 0xed, 0xb0, 0x91]);
});

// ---------- worlds ----------
test('lists singleplayer saves with level.dat details', () => {
  const saves = tmp();
  makeWorld(path.join(saves, 'Survival'), { name: 'Survival Island', version: '1.21.4', gameType: 0, difficulty: 2 });
  makeWorld(path.join(saves, 'Build'), { name: 'Creative Build', version: '26.1.2', gameType: 1 });
  fs.mkdirSync(path.join(saves, 'not-a-world'));
  const list = worlds.listSaves(saves);
  assert.equal(list.length, 2);
  const s = list.find(w => w.folder === 'Survival');
  assert.deepEqual([s.name, s.version, s.gameMode, s.difficulty, s.cheats, s.modded, s.hasPlayer], ['Survival Island', '1.21.4', 'survival', 'normal', true, false, true]);
});

test('copies a singleplayer world into a server, moving the owner’s player data', () => {
  const saves = tmp(); const server = tmp();
  const src = path.join(saves, 'Mine');
  makeWorld(src, { gameType: 1, difficulty: 3 });
  const before = fs.readFileSync(path.join(src, 'level.dat'));
  const player = { uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5', name: 'Notch' };
  const done = worlds.copySaveToServer({ worldDir: src, serverDir: server, player, makeOp: true });
  assert.ok(done.playerMoved && done.opped);
  assert.ok(fs.existsSync(path.join(server, 'world', 'region', 'r.0.0.mca')));
  assert.ok(fs.existsSync(path.join(server, 'world', 'DIM-1', 'region', 'r.0.0.mca')));
  assert.ok(!fs.existsSync(path.join(server, 'world', 'session.lock')), 'session.lock not copied');
  const pd = nbt.parse(fs.readFileSync(path.join(server, 'world', 'playerdata', `${player.uuid}.dat`)));
  assert.equal(nbt.get(pd.root, 'XpLevel'), 42);
  assert.equal(nbt.get(pd.root, 'CustomName'), 'Steve 🐑');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(server, 'ops.json'))), [{ uuid: player.uuid, name: 'Notch', level: 4, bypassesPlayerLimit: false }]);
  assert.deepEqual(fs.readFileSync(path.join(src, 'level.dat')), before, 'original untouched');
  assert.deepEqual(worlds.propsForWorld(done.info), { 'level-name': 'world', gamemode: 'creative', difficulty: 'hard', hardcore: 'false' });
  assert.throws(() => worlds.copySaveToServer({ worldDir: src, serverDir: server }), /already has a world called "world"/);
  assert.throws(() => worlds.copySaveToServer({ worldDir: src, serverDir: server, targetName: '../evil' }), /can only use/);
});

test('lists server worlds (Paper split dims) and copies one back to singleplayer', () => {
  const server = tmp(); const saves = tmp();
  makeWorld(path.join(server, 'world'), { name: 'world', player: false });
  fs.rmSync(path.join(server, 'world', 'DIM-1'), { recursive: true });
  makeWorld(path.join(server, 'world_nether'), { player: false });
  fs.renameSync(path.join(server, 'world_nether', 'DIM-1'), path.join(server, 'world_nether', 'DIM-1x'));
  fs.mkdirSync(path.join(server, 'world_nether', 'DIM-1', 'region'), { recursive: true });
  fs.writeFileSync(path.join(server, 'world_nether', 'DIM-1', 'region', 'r.1.1.mca'), 'paper nether');
  makeWorld(path.join(server, 'creative'), { player: false });
  fs.writeFileSync(path.join(server, 'server.properties'), 'level-name=world\n');
  const uuid = '11111111-2222-3333-4444-555555555555';
  fs.mkdirSync(path.join(server, 'world', 'playerdata'));
  fs.writeFileSync(path.join(server, 'world', 'playerdata', `${uuid}.dat`), nbt.write({ name: '', root: new Map([['XpLevel', I(7)]]) }));

  const { active, worlds: list } = worlds.listServerWorlds(server);
  assert.equal(active, 'world');
  assert.deepEqual(list.map(w => [w.folder, w.active, w.dims.join(',')]).sort(), [['creative', false, ''], ['world', true, 'world_nether']]);

  const r = worlds.copyServerWorldToSaves({ serverDir: server, folder: 'world', savesDir: saves, newName: 'SMP copy', player: { uuid } });
  assert.equal(r.name, 'SMP copy');
  assert.equal(fs.readFileSync(path.join(r.dest, 'DIM-1', 'region', 'r.1.1.mca'), 'utf8'), 'paper nether', 'Paper nether merged in');
  const lvl = worlds.readLevel(r.dest);
  assert.equal(lvl.name, 'SMP copy');
  assert.equal(lvl.hasPlayer, true, 'server inventory became the singleplayer player');
  const again = worlds.copyServerWorldToSaves({ serverDir: server, folder: 'world', savesDir: saves, newName: 'SMP copy' });
  assert.equal(again.name, 'SMP copy (2)');
});

test('launcher accounts and Mojang username lookup', async () => {
  const mc = tmp();
  fs.writeFileSync(path.join(mc, 'launcher_accounts_microsoft_store.json'), JSON.stringify({ accounts: { a: { minecraftProfile: { id: '069a79f444e94726a5befca90e38aaf5', name: 'Notch' } }, b: { username: 'no profile' } } }));
  assert.deepEqual(worlds.launcherAccounts(mc), [{ uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5', name: 'Notch' }]);
  routes['https://api.mojang.com/users/profiles/minecraft/jeb_'] = { id: '853c80ef3c3749fdaa49938b674adae6', name: 'jeb_' };
  assert.deepEqual(await worlds.lookupPlayer('jeb_'), { uuid: '853c80ef-3c37-49fd-aa49-938b674adae6', name: 'jeb_' });
  await assert.rejects(worlds.lookupPlayer('nobody_here'), /No Minecraft account/);
  await assert.rejects(worlds.lookupPlayer('bad name!'), /valid Minecraft username/);
});

// ---------- Geyser ----------
const OLD_CFG = `# Geyser config\nbedrock:\n  # The IP address that will listen for connections.\n  address: 0.0.0.0\n  port: 19132 # bedrock port\n  clone-remote-port: false\nremote:\n  address: auto\n  port: 25565\n  auth-type: online\nfloodgate-key-file: key.pem\n`;
const NEW_CFG = `bedrock:\n  port: 19132\n  motd1: "Geyser"\njava:\n  address: auto\n  port: 25565\n  # online, offline or floodgate\n  auth-type: online\nadvanced:\n  port: 1\n`;
test('Geyser config patching handles old (remote:) and new (java:) layouts', () => {
  for (const [label, text] of [['old', OLD_CFG], ['new', NEW_CFG]]) {
    const dir = tmp();
    const cfg = { dir, software: 'paper' };
    fs.mkdirSync(path.dirname(geyser.configPath(cfg)), { recursive: true });
    fs.writeFileSync(geyser.configPath(cfg), text);
    const r = geyser.applyConfig(cfg, { port: 19133 });
    const out = fs.readFileSync(geyser.configPath(cfg), 'utf8');
    assert.ok(r.changed, label);
    assert.match(out, /^bedrock:\n(?:.*\n)*?\s+port: 19133/m, `${label}: bedrock port`);
    assert.match(out, /auth-type: floodgate/, `${label}: floodgate auth`);
    assert.doesNotMatch(out, /^ {2}port: 25565\n(?:.*\n)*?bedrock/m);
    assert.match(out, /port: 25565/, `${label}: java port untouched`);
    if (label === 'old') assert.match(out, /port: 19133 # bedrock port/, 'comment kept');
    if (label === 'new') assert.match(out, /advanced:\n {2}port: 1/, 'other sections untouched');
    assert.equal(geyser.readPort(cfg), 19133);
    assert.equal(geyser.applyConfig(cfg, { port: 19133 }).changed, false, 'idempotent');
  }
  assert.equal(geyser.applyConfig({ dir: tmp(), software: 'fabric' }).exists, false);
});

test('Geyser install: Paper gets Geyser (Modrinth) + Floodgate-Spigot (verified), Fabric gets both from Modrinth', async () => {
  const jar = Buffer.from('fake geyser jar');
  const h512 = b => crypto.createHash('sha512').update(b).digest('hex');
  const v = (id, name, deps = []) => [{ id, version_number: id, version_type: 'beta', name, files: [{ primary: true, filename: name, url: `https://cdn/${name}`, hashes: { sha512: h512(jar) } }], dependencies: deps }];
  const MR = 'https://api.modrinth.com/v2/project';
  routes[`${MR}/geyser/version?loaders=%5B%22paper%22%2C%22spigot%22%2C%22bukkit%22%5D&game_versions=%5B%221.21.4%22%5D`] = v('g1', 'Geyser-Spigot.jar');
  routes[`${MR}/geyser`] = { title: 'Geyser' };
  routes['https://cdn/Geyser-Spigot.jar'] = jar;
  const fg = Buffer.from('floodgate spigot');
  routes['https://download.geysermc.org/v2/projects/floodgate/versions/latest/builds/latest'] = { downloads: { spigot: { name: 'floodgate-spigot.jar', sha256: crypto.createHash('sha256').update(fg).digest('hex') } } };
  routes['https://download.geysermc.org/v2/projects/floodgate/versions/latest/builds/latest/downloads/spigot'] = fg;

  const dir = tmp();
  const cfg = { dir, software: 'paper', kind: 'plugins', mcVersion: '1.21.4' };
  const installed = {};
  const r = await geyser.install(cfg, { installed, port: 19134 });
  assert.deepEqual(r.files.sort(), ['Geyser-Spigot.jar', 'floodgate-spigot.jar']);
  assert.deepEqual(geyser.detect(cfg), { geyser: 'Geyser-Spigot.jar', floodgate: 'floodgate-spigot.jar' });
  assert.equal(installed.geyser.file, 'Geyser-Spigot.jar');
  geyser.setEnabled(cfg, false);
  assert.deepEqual(geyser.detect(cfg), { geyser: null, floodgate: null });
  geyser.setEnabled(cfg, true);
  assert.equal(geyser.detect(cfg).geyser, 'Geyser-Spigot.jar');

  // bad Floodgate checksum is refused
  routes['https://download.geysermc.org/v2/projects/floodgate/versions/latest/builds/latest'] = { downloads: { spigot: { name: 'floodgate-spigot.jar', sha256: '0'.repeat(64) } } };
  await assert.rejects(geyser.install({ ...cfg, dir: tmp() }, {}), /checksum/);

  // Fabric: both from Modrinth, Fabric API pulled in as a dependency
  const fl = '%5B%22fabric%22%5D&game_versions=%5B%2226.1.2%22%5D';
  routes[`${MR}/geyser/version?loaders=${fl}`] = v('gf', 'Geyser-Fabric.jar', [{ project_id: 'P7dR8mSH', dependency_type: 'required' }]);
  routes[`${MR}/floodgate/version?loaders=${fl}`] = v('ff', 'Floodgate-Fabric.jar', [{ project_id: 'P7dR8mSH', dependency_type: 'required' }]);
  routes[`${MR}/P7dR8mSH/version?loaders=${fl}`] = v('fa', 'fabric-api.jar');
  routes[`${MR}/P7dR8mSH`] = { title: 'Fabric API' };
  for (const n of ['Geyser-Fabric.jar', 'Floodgate-Fabric.jar', 'fabric-api.jar']) routes[`https://cdn/${n}`] = jar;
  const fdir = tmp();
  const fcfg = { dir: fdir, software: 'fabric', kind: 'mods', mcVersion: '26.1.2' };
  const fr = await geyser.install(fcfg, { installed: {} });
  assert.deepEqual(fr.files.sort(), ['Floodgate-Fabric.jar', 'Geyser-Fabric.jar', 'fabric-api.jar']);
  assert.equal(geyser.configPath(fcfg), path.join(fdir, 'config', 'Geyser-Fabric', 'config.yml'));

  await assert.rejects(geyser.install({ dir: tmp(), software: 'forge', kind: 'mods', mcVersion: '1.20.1' }), /Paper, Purpur, Fabric or NeoForge/);
  routes[`${MR}/geyser/version?loaders=%5B%22paper%22%2C%22spigot%22%2C%22bukkit%22%5D&game_versions=%5B%221.12.2%22%5D`] = [];
  await assert.rejects(geyser.install({ dir: tmp(), software: 'paper', kind: 'plugins', mcVersion: '1.12.2' }), /doesn’t support paper 1.12.2/);
});

// ---------- TPS probes against the fake server ----------
async function startFake(dir, extraArgs = []) {
  fs.copyFileSync(path.join(__dirname, 'fake', 'server.jar'), path.join(dir, 'server.jar'));
  files.writeProperties(dir, { 'server-port': String(26000 + Math.floor(Math.random() * 500)) });
  const inst = new ServerInstance({ id: 'x', name: 'X', dir, launchArgs: [...extraArgs, '-jar', 'server.jar'] });
  const j = (await java.listJavas(true))[0].path;
  await inst.start(j, { keepAwake: false });
  await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('not online')), 8000); inst.on('state', s => { if (s.state === 'online') { clearTimeout(t); res(); } }); });
  return inst;
}
const until = (fn, ms = 4000) => new Promise((res, rej) => { const t0 = Date.now(); const i = setInterval(() => { if (fn()) { clearInterval(i); res(); } else if (Date.now() - t0 > ms) { clearInterval(i); rej(new Error('timeout')); } }, 50); });

test('Paper TPS + MSPT probes are parsed and hidden from the console', async () => {
  const inst = await startFake(tmp());
  const before = inst.log.length;
  const events = [];
  inst.on('metrics', m => events.push(m));
  assert.ok(inst.probe('tps', PROBE_ANSWERS.paper));
  assert.ok(inst.probe('mspt', PROBE_ANSWERS.paper));
  await until(() => inst.metrics.tps != null && inst.metrics.mspt != null).catch(e => { console.log('DBG', JSON.stringify(inst.metrics), inst.log.slice(-6).map(l => l.text)); throw e; });
  assert.equal(inst.metrics.tps, 20);
  assert.equal(inst.metrics.mspt, 3.1);
  assert.equal(inst.log.length, before, 'no probe output in the console');
  inst.send('tps'); // typed by the user: shown, and still updates metrics
  await until(() => inst.log.some(l => /TPS from last/.test(l.text)));
  inst.stop(); await inst.waitForExit();
});

test('vanilla tick query → MSPT/TPS; unknown command disables the probe', async () => {
  const inst = await startFake(tmp());
  inst.probe('tick query', PROBE_ANSWERS.vanilla);
  await until(() => inst.metrics.mspt != null);
  assert.equal(inst.metrics.mspt, 62.5);
  assert.equal(inst.metrics.tps, 16);
  assert.ok(!inst.log.some(l => /Average time per tick|running normally|Percentiles/.test(l.text)));
  inst.stop(); await inst.waitForExit();

  const old = await startFake(tmp(), ['-Dfake.oldvanilla=1']);
  old.probe('tick query', PROBE_ANSWERS.vanilla);
  await until(() => old.unsupported.has('tick query'));
  assert.equal(old.probe('tick query', PROBE_ANSWERS.vanilla), false, 'not retried');
  assert.ok(!old.log.some(l => /Unknown or incomplete/.test(l.text)), 'error hidden');
  old.stop(); await old.waitForExit();
});

// ---------- stats ----------
test('stats store tracks sessions, playtime, peak, uptime and crashes', async () => {
  const dir = tmp();
  const st = new StatsStore(dir);
  st.onStart('s');
  st.onJoin('s', 'Steve', 'u1');
  st.addPoint('s', { tps: 20, players: 1 });
  await new Promise(r => setTimeout(r, 30));
  st.onJoin('s', 'Alex');
  st.addPoint('s', { tps: 19, players: 2 });
  st.onLeave('s', 'Alex');
  const live = st.summary('s', ['Steve']);
  assert.equal(live.peak.count, 2);
  assert.equal(live.players[0].name, 'Steve');
  assert.ok(live.players[0].online && live.players[0].playtimeMs >= 25);
  st.onStop('s', { startedAt: Date.now() - 1000, crashed: true });
  const fresh = new StatsStore(dir).summary('s');
  assert.equal(fresh.crashes, 1);
  assert.equal(fresh.starts, 1);
  assert.ok(fresh.uptimeMs >= 1000);
  assert.ok(fresh.players.find(p => p.name === 'Steve').playtimeMs >= 25, 'persisted');
  assert.equal(fresh.series.length, 0, 'series is in-memory only');
  st.forget('s');
  assert.ok(!fs.existsSync(path.join(dir, 's.json')));
});

// ---------- Bedrock needs UDP port forwarding ----------
test('port mapper opens UDP (Bedrock) alongside TCP (Java) on NAT-PMP and UPnP', async () => {
  const { startRouter } = require('./fake/router');
  const { PortMapper } = require('../src/main/portmap');
  const router = await startRouter();
  const pm = new PortMapper({ gateway: '127.0.0.1', lanIp: '192.168.1.50', pmpPort: router.pmpPort, locations: [router.location], firstTimeout: 100 });
  await pm.map(25565, 'Java');
  const u = await pm.map(19132, 'Bedrock', 'udp');
  assert.equal(u.protocol, 'udp');
  assert.ok(router.state.calls.some(c => c[0] === 'pmp' && c[1] === 1 && c[2] === 19132), 'NAT-PMP op 1 = UDP');
  assert.ok(pm.info(19132, 'udp') && !pm.info(19132), 'tracked separately from TCP');
  await pm.unmapAll();
  assert.equal(pm.info(25565), null);
  assert.equal(pm.info(19132, 'udp'), null);
  router.close();

  const r2 = await startRouter({ pmpEnabled: false });
  const pm2 = new PortMapper({ gateway: '127.0.0.1', lanIp: '192.168.1.50', pmpPort: r2.pmpPort, locations: [r2.location], firstTimeout: 100 });
  const v = await pm2.map(19133, 'Bedrock', 'udp');
  assert.equal(v.via, 'UPnP');
  assert.ok(r2.state.calls.some(c => c[1] === 'AddPortMapping' && c[2] === '19133' && c[5] === 'UDP'), 'UPnP NewProtocol=UDP');
  await pm2.unmap(19133, 'udp');
  assert.ok(r2.state.calls.some(c => c[1] === 'DeletePortMapping' && c[5] === 'UDP'));
  r2.close();
});
