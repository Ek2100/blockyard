// UI run-through of the 1.2 features with fakes: wizard (singleplayer world → Paper + Bedrock), Stats,
// simple Public Access, crossplay, Worlds, plugin updates, schedules/Discord, log files.
// xvfb-run -a npx electron --no-sandbox test/ui-v12.js
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { startRouter } = require('./fake/router');
const nbt = require('../src/main/nbt');

const OUT = path.join(__dirname, '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'by-v12-'));
app.setPath('userData', ud);
const home = path.join(ud, 'home');
process.env.HOME = home; // worlds.js looks for ~/.minecraft/saves

// ---------- singleplayer saves + launcher account ----------
const S = v => ({ type: nbt.T.String, value: v }), I = v => ({ type: nbt.T.Int, value: v }), B = v => ({ type: nbt.T.Byte, value: v });
const C = o => ({ type: nbt.T.Compound, value: new Map(Object.entries(o)) });
function makeWorld(dir, name, version, gameType, extra = {}) {
  fs.mkdirSync(path.join(dir, 'region'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'region/r.0.0.mca'), crypto.randomBytes(300000));
  const data = { LevelName: S(name), GameType: I(gameType), Difficulty: B(2), hardcore: B(0), allowCommands: B(1), LastPlayed: { type: nbt.T.Long, value: BigInt(Date.now() - 3 * 86400e3) }, Version: C({ Name: S(version) }), Player: C({ XpLevel: I(30) }), ...extra };
  fs.writeFileSync(path.join(dir, 'level.dat'), nbt.write({ name: '', root: new Map([['Data', C(data)]]) }));
}
const saves = path.join(home, '.minecraft', 'saves');
makeWorld(path.join(saves, 'Survival Island'), 'Survival Island', '1.21.4', 0);
makeWorld(path.join(saves, 'Creative Plots'), 'Creative Plots', '1.21.4', 1, { LastPlayed: { type: nbt.T.Long, value: BigInt(Date.now() - 40 * 86400e3) } });
fs.writeFileSync(path.join(home, '.minecraft', 'launcher_accounts_microsoft_store.json'), JSON.stringify({ accounts: { x: { minecraftProfile: { id: '069a79f444e94726a5befca90e38aaf5', name: 'Steve' } } } }));

// ---------- an existing running-capable server ----------
const dir = path.join(ud, 'srv', 'Friends SMP');
fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
makeWorld(path.join(dir, 'world'), 'world', '1.21.4', 0);
makeWorld(path.join(dir, 'world_nether'), 'world', '1.21.4', 0);
makeWorld(path.join(dir, 'lobby'), 'Lobby', '1.21.4', 2);
fs.copyFileSync(path.join(__dirname, 'fake/server.jar'), path.join(dir, 'server.jar'));
fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
fs.writeFileSync(path.join(dir, 'server.properties'), 'motd=Friends SMP\nserver-port=25641\nlevel-name=world\n');
fs.writeFileSync(path.join(dir, 'plugins/EssentialsX-2.20.1.jar'), 'old');
fs.mkdirSync(path.join(dir, 'logs')); fs.mkdirSync(path.join(dir, 'crash-reports'));
fs.writeFileSync(path.join(dir, 'logs/latest.log'), '[12:00:00] [Server thread/INFO]: Starting minecraft server version 1.21.4\n[12:00:03] [Server thread/INFO]: Done (3.1s)!\n[12:05:00] [Server thread/INFO]: Steve joined the game\n');
fs.writeFileSync(path.join(dir, 'logs/2026-11-09-1.log.gz'), zlib.gzipSync('[09:00:00] [Server thread/INFO]: Yesterday’s log\n[09:01:00] [Server thread/WARN]: Can\'t keep up! Is the server overloaded?\n'));
fs.writeFileSync(path.join(dir, 'crash-reports/crash-2026-11-08_20.10.00-server.txt'), '---- Minecraft Crash Report ----\n// Shall we play a game?\n\nDescription: Ticking entity\n');
const javaPath = execSync('readlink -f $(which java)').toString().trim();
fs.writeFileSync(path.join(ud, 'servers.json'), JSON.stringify({ servers: [
  { id: 's1', name: 'Friends SMP', dir, software: 'paper', kind: 'plugins', mcVersion: '1.21.4', javaMajor: 21, memoryMB: 2048, launchArgs: ['-jar', 'server.jar'], jvmArgs: '', javaPath, access: { method: 'upnp', auto: true },
    modrinth: { a: { file: 'EssentialsX-2.20.1.jar', versionId: 'ev1', version: '2.20.1', title: 'EssentialsX' } },
    schedules: [{ id: 'x1', every: 30, command: 'say Vote for us!', enabled: true }] },
], settings: { keepAwake: true, defaultParent: path.join(home, 'Minecraft Servers') } }));

// ---------- network mocks ----------
const jar = fs.readFileSync(path.join(__dirname, 'fake/server.jar'));
const fg = Buffer.from('floodgate');
const h512 = b => crypto.createHash('sha512').update(b).digest('hex');
const mrVersion = (id, num, file, body = jar) => [{ id, version_type: 'release', version_number: num, files: [{ primary: true, filename: file, url: `https://cdn/${file}`, hashes: { sha512: h512(body) } }], dependencies: [] }];
const routes = {
  'https://api.ipify.org?format=json': { ip: '203.0.113.7' },
  'https://api.mcsrvstat.us/3/203.0.113.7%3A25641': { online: true, version: '1.21.4' },
  'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json': { versions: [{ id: '26.1.2', type: 'release', url: 'https://m/26.json' }, { id: '1.21.4', type: 'release', url: 'https://m/1.21.4.json' }] },
  'https://m/1.21.4.json': { javaVersion: { majorVersion: 21 } },
  'https://fill.papermc.io/v3/projects/paper': { versions: { '26.1': ['26.1.2'], '1.21': ['1.21.4', '1.21.3'] } },
  'https://fill.papermc.io/v3/projects/paper/versions/1.21.4/builds': [{ id: 232, channel: 'STABLE', downloads: { 'server:default': { url: 'https://cdn/paper.jar' } } }],
  'https://cdn/paper.jar': jar,
  'https://api.modrinth.com/v2/project/a/version': mrVersion('ev2', '2.21.0', 'EssentialsX-2.21.0.jar', Buffer.from('new')),
  'https://cdn/EssentialsX-2.21.0.jar': Buffer.from('new'),
  'https://api.modrinth.com/v2/project/a': { title: 'EssentialsX' },
  'https://api.modrinth.com/v2/project/geyser/version': mrVersion('g1', '2.10.1', 'Geyser-Spigot.jar'),
  'https://api.modrinth.com/v2/project/geyser': { title: 'Geyser' },
  'https://cdn/Geyser-Spigot.jar': jar,
  'https://download.geysermc.org/v2/projects/floodgate/versions/latest/builds/latest': { downloads: { spigot: { name: 'floodgate-spigot.jar', sha256: crypto.createHash('sha256').update(fg).digest('hex') } } },
  'https://download.geysermc.org/v2/projects/floodgate/versions/latest/builds/latest/downloads/spigot': fg,
};
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  let r = routes[url] ?? routes[url.split('?')[0]];
  if (typeof r === 'function') r = r(url, opts);
  if (r === undefined) { console.log('UNMOCKED', url); return { ok: false, status: 404, headers: { get: () => null }, text: async () => '{}', json: async () => ({}) }; }
  const buf = Buffer.isBuffer(r) ? r : null;
  return { ok: true, status: 200, headers: { get: k => (k === 'content-length' && buf ? String(buf.length) : null) }, json: async () => r, text: async () => JSON.stringify(r), body: (async function* () { if (buf) yield buf; })() };
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
startRouter({ externalIP: '203.0.113.7' }).then(router => {
  process.env.BLOCKYARD_PORTMAP_OPTS = JSON.stringify({ gateway: '127.0.0.1', lanIp: '192.168.1.42', pmpPort: router.pmpPort, locations: [router.location], firstTimeout: 100 });
  require('../src/main/main.js');
  app.on('browser-window-created', (_e, win) => {
    win.webContents.on('console-message', e => { if ((e.level ?? '') === 'error' || /error/i.test(e.message)) console.log('[renderer]', e.level ?? '', e.message ?? e); });
    win.webContents.once('did-finish-load', async () => {
      const js = code => win.webContents.executeJavaScript(code);
      const shot = async name => { await sleep(600); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); console.log('shot', name); };
      const tab = t => js(`[...document.querySelectorAll('.tab')].find(x => x.textContent === ${JSON.stringify(t)}).click()`);
      const clickText = (t, sel = 'button') => js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => x.textContent.trim() === ${JSON.stringify(t)}); if (!b) throw new Error('no element ' + ${JSON.stringify(t)}); b.click(); })()`);
      const waitFor = async (cond, ms = 15000) => { for (let i = 0; i < ms / 100; i++) { if (await js(cond)) return true; await sleep(100); } throw new Error('timeout waiting for ' + cond); };
      try {
        win.setSize(1280, 860);
        await sleep(1200);
        // ---- wizard: singleplayer world → Paper → friends anywhere + Bedrock ----
        await js(`document.getElementById('btn-new').click()`);
        await waitFor(`!!document.querySelector('.choice.big')`);
        await shot('v01-wizard-start');
        await js(`document.querySelectorAll('.choice.big')[1].click()`);
        await waitFor(`document.querySelectorAll('.world-row').length === 2`);
        await js(`document.querySelector('.world-row').click()`);
        await waitFor(`!!document.querySelector('.world-opts select')`);
        await shot('v02-wizard-world');
        await clickText('Next');
        await waitFor(`!!document.querySelector('.goal.sel') && !document.querySelector('.wizard select').disabled`);
        console.log('versions offered:', await js(`[...document.querySelector('.wizard select').options].map(o => o.textContent).join(' | ')`));
        await shot('v03-wizard-type');
        await clickText('Next');
        await waitFor(`!!document.querySelector('.bedrock-opt')`);
        await js(`(() => { const b = document.querySelector('.bedrock-opt input'); b.checked = true; b.dispatchEvent(new Event('change')); const e = document.querySelector('.eula input'); e.checked = true; e.dispatchEvent(new Event('change')); })()`);
        await shot('v04-wizard-play');
        await clickText('Create Server');
        await waitFor(`[...document.querySelectorAll('.modal button')].some(b => /Start Server|Back/.test(b.textContent))`, 60000);
        await shot('v05-wizard-done');
        const created = await js(`window.blockyard['servers:list']().then(l => l.find(x => x.id !== 's1'))`);
        const cw = await js(`window.blockyard['worlds:list'](${JSON.stringify(created.id)})`);
        const props = await js(`window.blockyard['props:get'](${JSON.stringify(created.id)})`);
        const gs = await js(`window.blockyard['geyser:status'](${JSON.stringify(created.id)})`);
        console.log('CREATED', JSON.stringify({ name: created.name, sw: created.software, ver: created.mcVersion, access: created.access, crossplay: created.crossplay, worlds: cw.worlds.map(w => w.folder), gamemode: props.values.gamemode, level: props.values['level-name'], geyser: gs.installed }));
        console.log('playerdata copied:', fs.existsSync(path.join(created.dir, 'world/playerdata/069a79f4-44e9-4726-a5be-fca90e38aaf5.dat')), 'op:', fs.readFileSync(path.join(created.dir, 'ops.json'), 'utf8').includes('Steve'));
        await clickText('Close');
        await sleep(400);

        // ---- the existing server: run it and collect metrics ----
        await js(`[...document.querySelectorAll('.srv')].find(x => x.textContent.includes('Friends SMP')).click()`);
        await sleep(500);
        await js(`document.querySelector('.actions .btn.primary').click()`);
        await waitFor(`!!document.querySelector('.pill.online')`);
        for (const c of ['join Steve', 'join Alex', 'join .PhonePlayer']) { await js(`window.blockyard['server:command']('s1', ${JSON.stringify(c)})`); await sleep(150); }
        console.log('waiting for metric samples…');
        await sleep(32000);
        await tab('Stats');
        await waitFor(`!!document.querySelector('.chart-svg path.line')`);
        await js(`(() => { const r = document.querySelector('.chart-svg rect'); const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('mousemove', { clientX: b.right - 30, clientY: b.top + 40, bubbles: true })); })()`);
        await shot('v06-stats');
        await tab('Console'); await shot('v07-console');

        await tab('Public Access');
        await waitFor(`[...document.querySelectorAll('.check-row.done')].length >= 3`, 20000);
        await shot('v08-access');
        await clickText('Set Up Crossplay');
        await waitFor(`!document.querySelector('.modal') && !!document.querySelector('.bedrock .switch')`, 20000);
        await sleep(400);
        await js(`document.querySelector('.bedrock').scrollIntoView()`);
        await shot('v09-bedrock');

        await tab('Worlds'); await waitFor(`!!document.querySelector('.version-card')`); await shot('v10-worlds');
        await tab('Plugins'); await clickText('Check for Updates'); await waitFor(`/update available|up to date/.test(document.querySelector('.updates-bar').textContent)`); await shot('v11-updates');
        await tab('Settings'); await sleep(400); await js(`document.getElementById('body').scrollTop = 99999`); await js(`[...document.querySelectorAll('h2')].find(x => x.textContent === 'Scheduled commands').scrollIntoView()`); await shot('v12-settings');
        await tab('Console'); await clickText('log files'); await waitFor(`/Starting minecraft/.test(document.querySelector('.log-view')?.textContent || '')`); await shot('v13-logs');
        await js(`document.querySelector('.backdrop').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
        await js(`window.blockyard['server:stop']('s1')`);
        await waitFor(`!document.querySelector('.pill.online')`, 20000);
        await sleep(800);
        const st = await js(`window.blockyard['stats:get']('s1')`);
        console.log('STATS', JSON.stringify({ points: st.series.length, tps: st.series.map(p => p.tps).filter(x => x != null).slice(-1)[0], mspt: st.series.map(p => p.mspt).filter(x => x != null).slice(-1)[0], players: st.players.map(p => p.name), peak: st.peak.count, starts: st.starts }));
        router.close();
        app.exit(0);
      } catch (e) { console.error('HARNESS ERROR', e.message); await shot('vERR'); app.exit(1); }
    });
  });
});
