// Run: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

delete process.env.JAVA_TOOL_OPTIONS;
const FAKE = path.join(__dirname, 'fake');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'by-'));
const { ServerInstance } = require('../src/main/server-instance');
const files = require('../src/main/files');
const providers = require('../src/main/providers');
const installer = require('../src/main/installer');
const java = require('../src/main/java');
java.setManagedRoot(path.join(tmp(), 'java'));

// ---------- fetch mock ----------
const routes = {};
global.fetch = async url => {
  const r = routes[url];
  if (!r) return { ok: false, status: 404, headers: new Map() };
  const buf = Buffer.isBuffer(r) ? r : null;
  return {
    ok: true, status: 200,
    headers: { get: k => (k === 'content-length' && buf ? String(buf.length) : null) },
    json: async () => r, text: async () => (typeof r === 'string' ? r : JSON.stringify(r)),
    body: (async function* () { if (buf) { for (let i = 0; i < buf.length; i += 1000) yield buf.subarray(i, i + 1000); } })(),
  };
};
const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
routes[MANIFEST] = { latest: { release: '1.21.4' }, versions: [
  { id: '26.1.2', type: 'release', url: 'https://m/26.1.2.json' },
  { id: '1.21.4', type: 'release', url: 'https://m/1.21.4.json' },
  { id: '25w10a', type: 'snapshot', url: 'https://m/snap.json' },
  { id: '1.16.5', type: 'release', url: 'https://m/1.16.5.json' },
] };
routes['https://m/1.21.4.json'] = { javaVersion: { majorVersion: 21 }, downloads: { server: { url: 'https://dl/vanilla-1.21.4.jar' } } };
routes['https://m/26.1.2.json'] = { javaVersion: { majorVersion: 25 }, downloads: { server: { url: 'https://dl/vanilla-26.jar' } } };
routes['https://m/1.16.5.json'] = { javaVersion: { majorVersion: 8 }, downloads: { server: { url: 'https://dl/vanilla-1.16.5.jar' } } };
const serverJar = fs.readFileSync(path.join(FAKE, 'server.jar'));
routes['https://dl/vanilla-1.21.4.jar'] = serverJar;

function waitFor(inst, pred, ms = 8000) {
  return new Promise((resolve, reject) => {
    if (pred()) return resolve();
    const t = setTimeout(() => { inst.off('state', check); inst.off('line', check); reject(new Error('timeout; state=' + inst.state + '\n' + inst.log.map(l => l.text).join('\n'))); }, ms);
    function check() { if (pred()) { clearTimeout(t); inst.off('state', check); inst.off('line', check); resolve(); } }
    inst.on('state', check); inst.on('line', check);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let JAVA;

test('finds system java', async () => {
  const list = await java.listJavas(true);
  assert.ok(list.length >= 1, 'no java found');
  JAVA = list[0].path;
  assert.equal(list[0].major, 21);
  assert.equal((await java.find(21)).major, 21);
  assert.equal((await java.find(17)).major, 21, 'Java 17 servers may use newer Java');
  assert.equal(await java.find(8), null, 'Java 8 servers need exactly 8');
  assert.equal(await java.find(25), null);
});

test('server lifecycle: start, online, players, commands, stop', async () => {
  const dir = tmp();
  fs.copyFileSync(path.join(FAKE, 'server.jar'), path.join(dir, 'server.jar'));
  files.writeProperties(dir, { 'server-port': '25601' });
  const inst = new ServerInstance({ id: 'a', name: 'A', dir, memoryMB: 1536, launchArgs: ['-jar', 'server.jar'] });
  const states = [];
  inst.on('state', s => states.push(s.state));
  await inst.start(JAVA, { keepAwake: false });
  await waitFor(inst, () => inst.state === 'online');
  assert.deepEqual(states.slice(0, 2), ['starting', 'online']);
  assert.ok(inst.log.some(l => /Max memory: \d+ MB, args: nogui/.test(l.text)), 'nogui passed and Xmx applied');
  assert.ok(!inst.log.some(l => /\x1b|\r/.test(l.text)), 'ANSI/CR stripped');

  inst.send('chat'); // "<Bob> Steve joined the game" must not count as a join
  await waitFor(inst, () => inst.log.some(l => l.text.includes('<Bob>')));
  assert.equal(inst.players.size, 0);

  inst.send('/join Steve'); // leading slash is tolerated
  await waitFor(inst, () => inst.players.has('Steve'));
  assert.equal(inst.players.get('Steve').uuid, '069a79f4-44e9-4726-a5be-fca90e38aaf5');
  inst.send('join Alex');
  inst.send('list');
  await waitFor(inst, () => inst.maxPlayers === 20);
  assert.deepEqual([...inst.players.keys()].sort(), ['Alex', 'Steve']);
  inst.send('kick Steve griefing');
  await waitFor(inst, () => !inst.players.has('Steve'));
  inst.send('leave Alex');
  await waitFor(inst, () => inst.players.size === 0);

  // a second server on the same port is refused before Java even starts
  const dup = new ServerInstance({ id: 'b', name: 'B', dir, launchArgs: ['-jar', 'server.jar'] });
  await assert.rejects(dup.start(JAVA, { keepAwake: false }), /Port 25601 is already in use/);

  inst.sampleStats();
  await sleep(400);
  assert.ok(inst.stats.memMB > 10, 'ps stats sampled');

  inst.stop();
  assert.equal(inst.state, 'stopping');
  await inst.waitForExit();
  assert.equal(inst.state, 'stopped');
  assert.equal(inst.lastExit, 0);
  assert.ok(inst.log.at(-1).text === 'Server stopped.');
  assert.throws(() => inst.send('list'), /not running/);
});

test('crash and force-kill are reported', async () => {
  const dir = tmp();
  fs.copyFileSync(path.join(FAKE, 'server.jar'), path.join(dir, 'server.jar'));
  files.writeProperties(dir, { 'server-port': '25602' });
  const inst = new ServerInstance({ id: 'c', name: 'C', dir, launchArgs: ['-jar', 'server.jar'] });
  await inst.start(JAVA, { keepAwake: false });
  await waitFor(inst, () => inst.state === 'online');
  inst.send('error');
  await waitFor(inst, () => inst.log.some(l => l.text.includes('RuntimeException')));
  inst.send('crash');
  await inst.waitForExit();
  assert.match(inst.log.at(-1).text, /stopped unexpectedly \(exit 3\)/);

  await inst.start(JAVA, { keepAwake: false });
  await waitFor(inst, () => inst.state === 'online');
  inst.send('hang');
  await sleep(200);
  inst.kill();
  await inst.waitForExit();
  assert.equal(inst.state, 'stopped');
});

test('server.properties round trip keeps comments and escapes', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'server.properties'), '#Minecraft server properties\n#Mon Nov 10\nmotd=A Minecraft Server\nserver-port=25565\npvp=true\n');
  files.writeProperties(dir, { motd: 'Café: mates=fun', pvp: 'false', 'max-players': '8' });
  const txt = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
  assert.match(txt, /^#Mon Nov 10$/m);
  assert.match(txt, /^motd=Caf\\u00e9\\: mates\\=fun$/m);
  const { values } = files.readProperties(dir);
  assert.equal(values.motd, 'Café: mates=fun');
  assert.equal(values.pvp, 'false');
  assert.equal(values['max-players'], '8');
  assert.equal(values['server-port'], '25565');
});

test('files are confined to the server folder; addons toggle', () => {
  const dir = tmp();
  assert.throws(() => files.safe(dir, '../etc'), /outside/);
  assert.throws(() => files.list(dir, '/etc'), /outside/);
  fs.mkdirSync(path.join(dir, 'plugins'));
  fs.writeFileSync(path.join(dir, 'plugins', 'EssentialsX.jar'), 'x');
  const cfg = { dir, kind: 'plugins' };
  assert.deepEqual(files.listAddons(cfg).items.map(i => [i.name, i.enabled]), [['EssentialsX', true]]);
  files.toggleAddon(cfg, 'EssentialsX.jar', false);
  assert.ok(fs.existsSync(path.join(dir, 'plugins', 'EssentialsX.jar.disabled')));
  files.toggleAddon(cfg, 'EssentialsX.jar.disabled', true);
  assert.ok(fs.existsSync(path.join(dir, 'plugins', 'EssentialsX.jar')));
  const src = path.join(tmp(), 'Other.jar'); fs.writeFileSync(src, 'y');
  assert.deepEqual(files.addAddons(cfg, [src, '/tmp/notajar.txt']), ['Other.jar']);
  assert.deepEqual(files.copyIn(dir, 'plugins', [src]), ['Other 2.jar']);
  const ls = files.list(dir, '');
  assert.equal(ls[0].name, 'plugins'); assert.equal(ls[0].dir, true);
});

test('version helpers', () => {
  assert.ok(providers.compareVersions('26.1', '1.21.11') > 0);
  assert.ok(providers.compareVersions('1.21.11', '1.21.9') > 0);
  assert.equal(providers.neoToMc('21.1.77'), '1.21.1');
  assert.equal(providers.neoToMc('21.0.5-beta'), '1.21');
  assert.equal(providers.neoToMc('20.4.237'), '1.20.4');
  assert.equal(providers.neoToMc('26.1.2.76'), '26.1.2');
  assert.equal(providers.neoToMc('26.1.0.19-beta'), '26.1');
  assert.equal(providers.guessJavaMajor('26.2'), 25);
  assert.equal(providers.guessJavaMajor('1.20.4'), 17);
  assert.equal(providers.guessJavaMajor('1.20.5'), 21);
  assert.equal(providers.guessJavaMajor('1.12.2'), 8);
});

test('provider version lists (mocked APIs)', async () => {
  providers._reset();
  routes['https://fill.papermc.io/v3/projects/paper'] = { project: { id: 'paper' }, versions: { '26.2': ['26.2'], '26.1': ['26.1.2', '26.1.1'], '1.21': ['1.21.11', '1.21.11-pre3', '1.21.9', '1.21'] } };
  assert.deepEqual(await providers.SOFTWARE.paper.versions(), ['26.2', '26.1.2', '26.1.1', '1.21.11', '1.21.9', '1.21']);
  routes['https://api.purpurmc.org/v2/purpur'] = { project: 'purpur', versions: ['1.14.1', '1.21.4', '1.21.10', '26.1'] };
  assert.deepEqual(await providers.SOFTWARE.purpur.versions(), ['26.1', '1.21.10', '1.21.4', '1.14.1']);
  assert.deepEqual(await providers.SOFTWARE.vanilla.versions(), ['26.1.2', '1.21.4', '1.16.5']);
  routes['https://meta.fabricmc.net/v2/versions/game'] = [{ version: '26.1', stable: true }, { version: '26.1-rc-1', stable: false }, { version: '1.21.4', stable: true }];
  assert.deepEqual(await providers.SOFTWARE.fabric.versions(), ['26.1', '1.21.4']);
  routes['https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'] = { promos: { '1.7.10-latest': '10.13.4.1614', '1.12.2-recommended': '14.23.5.2859', '1.20.1-latest': '47.4.1', '1.20.1-recommended': '47.4.0', '26.1-latest': '62.0.3' } };
  assert.deepEqual(await providers.SOFTWARE.forge.versions(), ['26.1', '1.20.1', '1.12.2']);
  routes['https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml'] = `<metadata><versioning><versions>
    <version>20.4.237</version><version>21.1.76</version><version>21.1.77</version><version>21.1.100-beta</version>
    <version>26.1.0.18-beta</version><version>26.1.0.19-beta</version><version>26.1.2.75</version><version>26.1.2.76</version>
    <version>26.1.0.0-alpha.2+snapshot-1</version></versions></versioning></metadata>`;
  assert.deepEqual(await providers.SOFTWARE.neoforge.versions(), ['26.1.2', '26.1', '1.21.1', '1.20.4']);
  assert.equal(await providers.javaMajorFor('26.1.2'), 25);
  assert.equal(await providers.javaMajorFor('9.9.9'), 8, 'unknown version falls back to a guess');
});

test('paper install picks the newest stable build', async () => {
  routes['https://fill.papermc.io/v3/projects/paper/versions/1.21.4/builds'] = [
    { id: 230, channel: 'BETA', downloads: { 'server:default': { url: 'https://dl/paper-230.jar' } } },
    { id: 232, channel: 'STABLE', downloads: { 'server:default': { url: 'https://dl/paper-232.jar' } } },
    { id: 231, channel: 'STABLE', downloads: { 'server:default': { url: 'https://dl/paper-231.jar' } } },
  ];
  routes['https://dl/paper-232.jar'] = serverJar;
  const dir = tmp(); const logs = [];
  const r = await providers.SOFTWARE.paper.install({ mcVersion: '1.21.4', dir, log: (m, p) => logs.push([m, p]) });
  assert.deepEqual(r.launchArgs, ['-jar', 'server.jar']);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'server.jar')), serverJar);
  assert.ok(logs.some(([m]) => /build #232/.test(m)));
  assert.ok(logs.some(([, p]) => p === 1), 'progress reaches 100%');
  assert.ok(!fs.existsSync(path.join(dir, 'server.jar.part')));
});

test('createServer end to end (paper) then run it', async () => {
  const parent = tmp(); const logs = [];
  await assert.rejects(installer.createServer({ name: 'X', software: 'paper', mcVersion: '1.21.4', parentDir: parent, eula: false }, () => {}), /EULA/);
  const cfg = await installer.createServer({ name: 'Friends SMP', software: 'paper', mcVersion: '1.21.4', parentDir: parent, port: 25603, memoryMB: 1024, eula: true }, m => logs.push(m));
  assert.equal(cfg.dir, path.join(parent, 'Friends SMP'));
  assert.equal(cfg.javaMajor, 21);
  assert.equal(cfg.kind, 'plugins');
  assert.match(fs.readFileSync(path.join(cfg.dir, 'eula.txt'), 'utf8'), /^eula=true$/m);
  assert.equal(files.readProperties(cfg.dir).values['server-port'], '25603');
  await assert.rejects(installer.createServer({ name: 'Friends SMP', software: 'paper', mcVersion: '1.21.4', parentDir: parent, eula: true }, () => {}), /already exists/);
  const inst = new ServerInstance({ id: 'e', ...cfg });
  await inst.start((await java.find(cfg.javaMajor)).path, { keepAwake: false });
  await waitFor(inst, () => inst.state === 'online');
  assert.ok(inst.log.some(l => /on \*:25603/.test(l.text)));
  inst.stop(); await inst.waitForExit();
});

test('failed create cleans up its folder', async () => {
  const parent = tmp();
  routes['https://fill.papermc.io/v3/projects/paper/versions/1.0/builds'] = [];
  routes[MANIFEST].versions.push({ id: '1.0', type: 'release', url: 'https://m/1.21.4.json' });
  providers._reset();
  await assert.rejects(installer.createServer({ name: 'Broken', software: 'paper', mcVersion: '1.0', parentDir: parent, eula: true }, () => {}), /no builds/);
  assert.ok(!fs.existsSync(path.join(parent, 'Broken')));
});

test('neoforge install runs the installer and launches via the args file', async () => {
  providers._reset();
  routes['https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml'] = '<versions><version>21.1.77</version></versions>';
  routes[MANIFEST].versions.push({ id: '1.21.1', type: 'release', url: 'https://m/1.21.4.json' });
  routes['https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.77/neoforge-21.1.77-installer.jar'] = fs.readFileSync(path.join(FAKE, 'installer.jar'));
  const parent = tmp(); const logs = [];
  const cfg = await installer.createServer({ name: 'Modded', software: 'neoforge', mcVersion: '1.21.1', parentDir: parent, port: 25604, eula: true }, m => logs.push(m));
  assert.deepEqual(cfg.launchArgs, ['@libraries/net/neoforged/neoforge/21.1.77/unix_args.txt']);
  assert.ok(!fs.readdirSync(cfg.dir).some(f => /installer/.test(f)), 'installer removed');
  assert.ok(logs.includes('The server installed successfully'));
  const inst = new ServerInstance({ id: 'n', ...cfg, memoryMB: 1024 });
  await inst.start(JAVA, { keepAwake: false });
  await waitFor(inst, () => inst.state === 'online');
  inst.stop(); await inst.waitForExit();

  // and the import detector recognises the result
  const d = installer.detect(cfg.dir);
  assert.equal(d.software, 'neoforge');
  assert.equal(d.mcVersion, '1.21.1');
  assert.deepEqual(d.launchArgs, cfg.launchArgs);
  assert.equal(d.port, 25604);
});

test('forge run.sh with shim jar', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'run.sh'), '#!/usr/bin/env sh\n# Forge requires a configured set of both JVM and program arguments.\n\njava @user_jvm_args.txt -jar forge-1.20.4-49.0.30-shim.jar "$@"\n');
  assert.deepEqual(providers.forgeLaunchArgs(dir), ['-jar', 'forge-1.20.4-49.0.30-shim.jar']);
  fs.writeFileSync(path.join(dir, 'run.sh'), 'java @user_jvm_args.txt @libraries/net/minecraftforge/forge/1.20.1-47.2.0/unix_args.txt "$@"\n');
  fs.mkdirSync(path.join(dir, 'libraries/net/minecraftforge/forge/1.20.1-47.2.0'), { recursive: true });
  const d = installer.detect(dir);
  assert.equal(d.software, 'forge');
  assert.equal(d.mcVersion, '1.20.1');
});

test('import detection for paper / fabric / vanilla', () => {
  const p = tmp();
  fs.writeFileSync(path.join(p, 'paper-1.21.4-232.jar'), 'x');
  fs.mkdirSync(path.join(p, 'config')); fs.writeFileSync(path.join(p, 'config/paper-global.yml'), '');
  fs.writeFileSync(path.join(p, 'version_history.json'), '{"currentVersion":"1.21.4-232-abc (MC: 1.21.4)"}');
  fs.writeFileSync(path.join(p, 'server.properties'), 'server-port=25570\n');
  let d = installer.detect(p);
  assert.deepEqual([d.software, d.mcVersion, d.port, d.launchArgs.join(' ')], ['paper', '1.21.4', 25570, '-jar paper-1.21.4-232.jar']);

  const f = tmp();
  fs.writeFileSync(path.join(f, 'fabric-server-mc.1.21.4-loader.0.16.10-launcher.1.0.1.jar'), 'x');
  fs.mkdirSync(path.join(f, 'mods'));
  d = installer.detect(f);
  assert.equal(d.software, 'fabric'); assert.equal(d.kind, 'mods');

  const v = tmp();
  fs.writeFileSync(path.join(v, 'minecraft_server.1.16.5.jar'), 'x');
  fs.mkdirSync(path.join(v, 'world'));
  d = installer.detect(v);
  assert.deepEqual([d.software, d.mcVersion, d.warnings.length], ['vanilla', '1.16.5', 0]);

  const empty = tmp();
  d = installer.detect(empty);
  assert.ok(d.warnings.length >= 1);
});
