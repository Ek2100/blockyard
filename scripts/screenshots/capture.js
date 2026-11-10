// Takes the README screenshots with a demo server and made-up data. Nothing is downloaded:
// every web request is answered locally, and player heads / plugin icons are generated pixel art.
//
//   xvfb-run -a -s "-screen 0 3000x2200x24" npx electron --no-sandbox scripts/screenshots/capture.js
//   SHOT_THEME=dark xvfb-run ... (same)       → dark-mode shots
//
// Output: docs/screenshots/*.png at 2x (2560×1600).
const { app, nativeTheme, nativeImage, protocol, net } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const DARK = process.env.SHOT_THEME === 'dark';
const OUT = path.join(ROOT, 'docs', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });
app.commandLine.appendSwitch('force-device-scale-factor', '2');
nativeTheme.themeSource = DARK ? 'dark' : 'light';
process.env.BLOCKYARD_TEST = '1';
// A typical home network address instead of this machine's real one.
os.networkInterfaces = () => ({ en0: [{ family: 'IPv4', internal: false, address: '192.168.1.42' }], lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] });

const { startRouter } = require(path.join(ROOT, 'test/fake/router'));
const nbt = require(path.join(ROOT, 'src/main/nbt'));
const { StatsStore } = require(path.join(ROOT, 'src/main/stats'));

const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'by-shots-'));
app.setPath('userData', ud);
const home = path.join(ud, 'home');
process.env.HOME = home;

// ---------- demo server jar ----------
const build = path.join(ud, 'build');
fs.mkdirSync(build);
execSync(`javac -d "${build}" "${path.join(__dirname, 'DemoServer.java')}"`);
const demoJar = path.join(ud, 'demo-server.jar');
execSync(`jar cfe "${demoJar}" DemoServer -C "${build}" .`);
const javaPath = execSync('readlink -f "$(which java)"').toString().trim();

// ---------- worlds ----------
const S = v => ({ type: nbt.T.String, value: v }), I = v => ({ type: nbt.T.Int, value: v }), B = v => ({ type: nbt.T.Byte, value: v });
const C = o => ({ type: nbt.T.Compound, value: new Map(Object.entries(o)) });
const L = v => ({ type: nbt.T.Long, value: BigInt(v) });
function makeWorld(dir, name, gameType, { bytes = 400000, daysAgo = 1, version = '1.21.4' } = {}) {
  fs.mkdirSync(path.join(dir, 'region'), { recursive: true });
  // Sparse files: report a realistic size without using the disk space.
  for (let i = 0; i < 8; i++) { const f = path.join(dir, `region/r.${i}.0.mca`); fs.writeFileSync(f, ''); fs.truncateSync(f, Math.round(bytes / 8)); }
  const data = { LevelName: S(name), GameType: I(gameType), Difficulty: B(2), hardcore: B(0), allowCommands: B(1), LastPlayed: L(Date.now() - daysAgo * 86400e3), Version: C({ Name: S(version) }), Player: C({ XpLevel: I(30) }) };
  fs.writeFileSync(path.join(dir, 'level.dat'), nbt.write({ name: '', root: new Map([['Data', C(data)]]) }));
}
const saves = path.join(home, '.minecraft', 'saves');
makeWorld(path.join(saves, 'Survival Island'), 'Survival Island', 0, { bytes: 412e6, daysAgo: 0.2 });
makeWorld(path.join(saves, 'Creative Plots'), 'Creative Plots', 1, { bytes: 96e6, daysAgo: 9 });
makeWorld(path.join(saves, 'Hardcore Attempt 3'), 'Hardcore Attempt 3', 0, { bytes: 38e6, daysAgo: 31 });
fs.writeFileSync(path.join(home, '.minecraft', 'launcher_accounts_microsoft_store.json'), JSON.stringify({ accounts: { x: { minecraftProfile: { id: '3f1c2a7b9d0e4c5fa1b2c3d4e5f60718', name: 'Juniper' } } } }));

// ---------- servers ----------
const srvRoot = path.join(home, 'Minecraft Servers');
const dir = path.join(srvRoot, 'Friends SMP');
fs.mkdirSync(path.join(dir, 'plugins', 'Geyser-Spigot'), { recursive: true });
makeWorld(path.join(dir, 'world'), 'world', 0, { bytes: 1.21e9 });
makeWorld(path.join(dir, 'world_nether'), 'world', 0, { bytes: 184e6 });
makeWorld(path.join(dir, 'world_the_end'), 'world', 0, { bytes: 61e6 });
makeWorld(path.join(dir, 'spawn_lobby'), 'Lobby', 2, { bytes: 23e6 });
fs.copyFileSync(demoJar, path.join(dir, 'server.jar'));
fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
fs.writeFileSync(path.join(dir, 'server.properties'), 'motd=Friends SMP \\u00A7a\\u2022 survival with friends\nserver-port=25565\nlevel-name=world\nmax-players=20\ndifficulty=normal\ngamemode=survival\nview-distance=10\nsimulation-distance=10\nspawn-protection=16\nwhite-list=false\npvp=true\nonline-mode=true\n');
fs.writeFileSync(path.join(dir, 'ops.json'), JSON.stringify([{ uuid: '3f1c2a7b-9d0e-4c5f-a1b2-c3d4e5f60718', name: 'Juniper', level: 4, bypassesPlayerLimit: false }]));
fs.writeFileSync(path.join(dir, 'plugins/Geyser-Spigot/config.yml'), 'bedrock:\n  address: 0.0.0.0\n  port: 19132\nremote:\n  auth-type: floodgate\n');
const plugins = { 'LuckPerms-Bukkit-5.4.145.jar': 1.4e6, 'EssentialsX-2.21.0.jar': 1.1e6, 'EssentialsXChat-2.21.0.jar': 9e4, 'CoreProtect-23.0.jar': 9.6e5, 'Chunky-Bukkit-1.4.28.jar': 3.1e5, 'Geyser-Spigot.jar': 1.9e7, 'floodgate-spigot.jar': 3.6e6, 'squaremap-paper-1.3.4.jar': 1.2e6, 'TAB-5.0.1.jar.disabled': 2.2e6 };
for (const [f, n] of Object.entries(plugins)) fs.writeFileSync(path.join(dir, 'plugins', f), Buffer.alloc(n));
const chat = '@Async_Chat_Thread_-_#2';
fs.writeFileSync(path.join(dir, 'demo-script.txt'), [
  '600 join Juniper 3f1c2a7b-9d0e-4c5f-a1b2-c3d4e5f60718',
  '500 join mossycobble 8a7d6c5b-4e3f-4a2b-9c1d-0e1f2a3b4c5d',
  `400 echo INFO ${chat} <Juniper> evening! the base is finally lit up`,
  '500 echo INFO [floodgate] Floodgate player logged in as .TabletTom joined (UUID: 00000000-0000-0000-0009-01f2a3b4c5d6)',
  '100 join .TabletTom 00000000-0000-0000-0009-01f2a3b4c5d6',
  `400 echo INFO ${chat} <mossycobble> anyone up for the end raid later?`,
  '300 echo INFO mossycobble has made the advancement [Monster Hunter]',
  '400 join RedstoneKai c0ffee12-3456-4789-abcd-ef0123456789',
  `400 echo INFO ${chat} <.TabletTom> yes!! playing on my ipad`,
  "400 echo WARN Can't keep up! Is the server overloaded? Running 2041ms or 40 ticks behind",
  '300 echo INFO [Chunky] Task running for world. Processed: 61.32% (11,240 chunks), ETA: 0:04:18, Rate: 43.6 cps',
  '400 say Back up your builds! Restart at 4am.',
  `400 echo INFO ${chat} <RedstoneKai> the item sorter works now`,
  `300 echo INFO ${chat} <Juniper> nice, kai`,
  '300 save-all',
].join('\n'));
fs.mkdirSync(path.join(dir, 'logs'));
fs.writeFileSync(path.join(dir, 'logs/latest.log'), '');

function plainServer(name, extra) {
  const d = path.join(srvRoot, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'server.properties'), 'server-port=25566\n');
  return { dir: d, launchArgs: ['-jar', 'server.jar'], jvmArgs: '', javaPath, memoryMB: 4096, ...extra };
}
fs.writeFileSync(path.join(ud, 'servers.json'), JSON.stringify({ servers: [
  { id: 's1', name: 'Friends SMP', dir, software: 'paper', kind: 'plugins', mcVersion: '1.21.4', javaMajor: 21, memoryMB: 6144, launchArgs: ['-jar', 'server.jar'], jvmArgs: '', javaPath, onboarded: true,
    access: { method: 'upnp', auto: true }, crossplay: { enabled: true, port: 19132 }, optimizedFlags: false, autoRestart: false,
    schedules: [{ id: 'x1', every: 60, command: 'say Back up your builds! Restart at 4am.', enabled: true }] },
  { id: 's2', name: 'Creative Build', software: 'fabric', kind: 'mods', mcVersion: '1.21.4', javaMajor: 21, onboarded: true, ...plainServer('Creative Build') },
  { id: 's3', name: 'Modded Weekend', software: 'neoforge', kind: 'mods', mcVersion: '1.21.1', javaMajor: 21, onboarded: true, ...plainServer('Modded Weekend') },
], settings: { keepAwake: true, defaultParent: srvRoot, checkUpdates: false } }));

// ---------- stats: a believable evening of history ----------
const people = [
  ['Juniper', '3f1c2a7b-9d0e-4c5f-a1b2-c3d4e5f60718'], ['mossycobble', '8a7d6c5b-4e3f-4a2b-9c1d-0e1f2a3b4c5d'],
  ['RedstoneKai', 'c0ffee12-3456-4789-abcd-ef0123456789'], ['.TabletTom', '00000000-0000-0000-0009-01f2a3b4c5d6'],
  ['pixelfern', '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e'], ['Oakley_', '9e8d7c6b-5a49-4382-9716-a5b4c3d2e1f0'],
  ['lanternfly', '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'],
];
const now = Date.now();
const H = 3600e3;
const rec = { players: {}, peak: { count: 7, at: now - 26 * H }, starts: 64, crashes: 1, uptimeMs: 412 * H };
const hours = [61, 47, 39, 22, 18, 9, 4];
people.forEach(([name, uuid], i) => { rec.players[name] = { name, uuid, firstSeen: now - (60 - i * 7) * 86400e3, lastSeen: now - (i + 1) * 5 * H, playtimeMs: hours[i] * H + i * 1.3e6, sessions: 120 - i * 15 }; });
fs.mkdirSync(path.join(ud, 'stats'), { recursive: true });
fs.writeFileSync(path.join(ud, 'stats', 's1.json'), JSON.stringify(rec));

// Smooth noise so the charts look like a real evening rather than random static.
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const series = [];
let mspt = 11, cpu = 18, mem = 2900;
for (let t = now - 6 * H; t <= now; t += 10e3) {
  const hAgo = (now - t) / H;
  const players = hAgo > 5 ? 1 : hAgo > 4 ? 2 : hAgo > 2.6 ? 3 : hAgo > 1.4 ? 5 : hAgo > 0.5 ? 4 : 4;
  const spike = Math.abs(hAgo - 0.42) < 0.035 ? 58 : Math.abs(hAgo - 3.2) < 0.03 ? 40 : 0; // chunk generation bursts
  mspt += ((8 + players * 1.4 + spike) - mspt) * 0.25 + (rnd() - 0.5) * 2.2;
  cpu += ((10 + players * 4 + spike * 0.85) - cpu) * 0.3 + (rnd() - 0.5) * 3;
  mem += ((2600 + players * 260) - mem) * 0.02 + (rnd() - 0.5) * 60;
  const m = Math.max(4, mspt);
  series.push({ t, tps: +Math.min(20, 1000 / Math.max(50, m)).toFixed(2), mspt: +m.toFixed(1), cpu: Math.max(2, Math.round(cpu)), mem: Math.round(mem), players });
}
// The demo worlds are sparse files; report their apparent size like a real world on disk would.
const worldsMod = require(path.join(ROOT, 'src/main/worlds'));
worldsMod.dirSize = async d => { let t = 0; const walk = x => { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const f = path.join(x, e.name); if (e.isDirectory()) walk(f); else t += fs.statSync(f).size; } }; try { walk(d); } catch {} return t; };

// Live CPU / memory tiles: show what a real 4-player Paper server uses, not the tiny demo process.
const { ServerInstance } = require(path.join(ROOT, 'src/main/server-instance'));
ServerInstance.prototype.sampleStats = function () {
  if (!this.proc?.pid) return;
  this.stats = { cpu: Math.round(21 + rnd() * 8), memMB: Math.round(3680 + rnd() * 120) };
  this.emit('stats', this.stats);
};
StatsStore.prototype.getSeries = function (id, sinceMs = 6 * H) {
  if (id !== 's1') return [];
  const shift = Date.now() - now;
  return series.map(p => ({ ...p, t: p.t + shift })).filter(p => p.t >= Date.now() - sinceMs);
};

// ---------- pixel art for player heads and plugin icons ----------
function hash(s) { return crypto.createHash('md5').update(s).digest(); }
function pixelPng(key, size, kind) {
  const hsh = hash(key);
  const n = 8, cell = size / n;
  const buf = Buffer.alloc(size * size * 4);
  const hue = hsh[0] / 255 * 360;
  const hsl = (hh, s, l) => {
    const k = x => (x + hh / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = x => l - a * Math.max(-1, Math.min(k(x) - 3, Math.min(9 - k(x), 1)));
    return [f(0), f(8), f(4)].map(v => Math.round(v * 255));
  };
  const grid = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let c;
    if (kind === 'head') {
      const skin = hsl(20 + hsh[1] % 20, 0.45, 0.55 + (hsh[2] % 20) / 100);
      const hair = hsl(hue, 0.35, 0.25 + (hsh[3] % 25) / 100);
      c = skin;
      if (y < 2 || (y === 2 && (x === 0 || x === 7))) c = hair;
      if (y === 4 && (x === 1 || x === 6)) c = [250, 250, 250];
      if (y === 4 && (x === 2 || x === 5)) c = hsl(hue + 180, 0.6, 0.35);
      if (y === 6 && x >= 3 && x <= 4) c = skin.map(v => v * 0.7 | 0);
      if (rnd() < 0.08) c = c.map(v => Math.min(255, v + 12));
    } else {
      const bit = hsh[(y * 4 + Math.min(x, 7 - x)) % 16] & (1 << ((x + y) % 8));
      const edge = x === 0 || y === 0 || x === n - 1 || y === n - 1;
      c = edge ? hsl(hue, 0.55, 0.38) : bit ? hsl(hue + 25, 0.65, 0.6) : hsl(hue, 0.55, 0.47);
    }
    grid.push(c);
  }
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    const [r, g, b] = grid[Math.floor(py / cell) * n + Math.floor(px / cell)];
    const o = (py * size + px) * 4;
    buf[o] = b; buf[o + 1] = g; buf[o + 2] = r; buf[o + 3] = 255;
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size }).toPNG();
}

// ---------- canned web answers ----------
const mr = (id, title, author, description, downloads, cats) => ({ project_id: id, slug: id, title, author, description, downloads, display_categories: cats, icon_url: `https://cdn.modrinth.com/demo/${id}.png` });
const routes = {
  'https://api.ipify.org?format=json': { ip: '203.0.113.7' },
  'https://api.mcsrvstat.us/3/203.0.113.7%3A25565': { online: true, version: '1.21.4' },
  'https://api.mcstatus.io/v2/status/java/203.0.113.7': { online: true, players: { online: 4, max: 20 }, version: { name_clean: 'Paper 1.21.4' } },
  'https://api.mcstatus.io/v2/status/java/203.0.113.7%3A25565': { online: true, players: { online: 4, max: 20 }, version: { name_clean: 'Paper 1.21.4' } },
  'https://api.mcsrvstat.us/bedrock/3/203.0.113.7%3A19132': { online: true },
  'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json': { versions: [{ id: '1.21.10', type: 'release', url: 'https://m/x.json' }, { id: '1.21.4', type: 'release', url: 'https://m/x.json' }, { id: '1.20.6', type: 'release', url: 'https://m/x.json' }] },
  'https://m/x.json': { javaVersion: { majorVersion: 21 } },
  'https://fill.papermc.io/v3/projects/paper': { versions: { '1.21': ['1.21.10', '1.21.4'], '1.20': ['1.20.6'] } },
  'https://api.modrinth.com/v2/search': { total_hits: 6, hits: [
    mr('essx', 'EssentialsX', 'EssentialsX', 'Homes, warps, kits, an economy and over a hundred everyday commands.', 4.1e6, ['utility', 'management']),
    mr('lp', 'LuckPerms', 'Luck', 'Permissions and ranks for players, with a web editor.', 3.6e6, ['management']),
    mr('chunky', 'Chunky', 'pop4959', 'Generates the world ahead of time so exploring stays smooth.', 1.9e6, ['optimization']),
    mr('sqm', 'squaremap', 'jpenilla', 'A fast, minimal live web map of your worlds.', 6.2e5, ['utility']),
    mr('cp', 'CoreProtect', 'Intelli', 'Logs block changes so you can look up and roll back griefing.', 1.2e6, ['management', 'utility']),
    mr('vt', 'ViaVersion', 'ViaVersion', 'Lets players on newer game versions join older servers.', 2.8e6, ['utility']),
  ] },
};
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  const r = routes[url] ?? routes[url.split('?')[0]];
  if (r === undefined) return { ok: false, status: 404, headers: { get: () => null }, text: async () => '{}', json: async () => ({}) };
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => r, text: async () => JSON.stringify(r), body: (async function* () {})() };
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(() => {
  protocol.handle('https', req => {
    const u = new URL(req.url);
    if (u.hostname === 'mc-heads.net') return new Response(pixelPng(decodeURIComponent(u.pathname.split('/')[2] || 'x'), 64, 'head'), { headers: { 'content-type': 'image/png' } });
    if (u.hostname === 'cdn.modrinth.com') return new Response(pixelPng(u.pathname, 96, 'icon'), { headers: { 'content-type': 'image/png' } });
    return net.fetch(req, { bypassCustomProtocolHandlers: true });
  });
});

startRouter({ externalIP: '203.0.113.7' }).then(router => {
  process.env.BLOCKYARD_PORTMAP_OPTS = JSON.stringify({ gateway: '127.0.0.1', lanIp: '192.168.1.42', pmpPort: router.pmpPort, locations: [router.location], firstTimeout: 100 });
  require(path.join(ROOT, 'src/main/main.js'));
  app.on('browser-window-created', (_e, win) => {
    win.webContents.once('did-finish-load', async () => {
      const js = code => win.webContents.executeJavaScript(code);
      const P = DARK ? 'dark-' : '';
      const shot = async (name, { keepPointer = false } = {}) => {
        if (!keepPointer) win.webContents.sendInputEvent({ type: 'mouseMove', x: 4, y: 790 });
        await sleep(700);
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(OUT, P + name + '.png'), img.toPNG());
        console.log('shot', P + name, img.getSize());
      };
      const tab = t => js(`[...document.querySelectorAll('.tab')].find(x => x.textContent === ${JSON.stringify(t)}).click()`);
      const clickText = (t, sel = 'button') => js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => x.textContent.trim() === ${JSON.stringify(t)}); if (!b) throw new Error('no element ' + ${JSON.stringify(t)}); b.click(); })()`);
      const waitFor = async (cond, ms = 20000) => { for (let i = 0; i < ms / 100; i++) { if (await js(cond)) return; await sleep(100); } throw new Error('timeout waiting for ' + cond); };
      const clearToasts = () => js(`document.querySelectorAll('#toasts > *').forEach(t => t.remove())`);
      try {
        win.setContentSize(1280, 800);
        await sleep(1500);
        await js(`[...document.querySelectorAll('.srv')].find(x => x.textContent.includes('Friends SMP')).click()`);
        await sleep(500);
        await js(`document.querySelector('.actions .btn.primary').click()`);
        await waitFor(`!!document.querySelector('.pill.online')`);
        await sleep(400);
        await sleep(14000); // the demo server plays its scripted session; TPS / CPU tiles fill in
        await clearToasts();

        if (!DARK) {
          await tab('Console'); await shot('01-console');
          await tab('Players'); await sleep(800); await shot('02-players');
        }
        await tab('Stats');
        await waitFor(`!!document.querySelector('.chart-svg path.line')`);
        await js(`(() => { const r = document.querySelector('.chart-svg rect'); const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('mousemove', { clientX: b.left + b.width * 0.74, clientY: b.top + 40, bubbles: true })); })()`);
        await shot('03-stats', { keepPointer: true });
        if (DARK) {
          await tab('Console'); await shot('01-console');
        } else {
          await tab('Plugins');
          await clickText('Browse Modrinth');
          await waitFor(`document.querySelectorAll('.mr-hit, .card img').length >= 3`).catch(() => {});
          await sleep(1200); await clearToasts();
          await shot('04-plugins');

          await tab('Public Access');
          await waitFor(`[...document.querySelectorAll('.check-row.done')].length >= 3`, 25000).catch(() => console.log('access checks not all done'));
          await sleep(800); await clearToasts();
          await shot('05-public-access');
          await js(`document.querySelector('.bedrock')?.scrollIntoView({ block: 'center' })`);
          await shot('06-crossplay');

          await tab('Worlds'); await sleep(900); await shot('07-worlds');

          await js(`document.getElementById('btn-new').click()`);
          await waitFor(`!!document.querySelector('.choice.big')`);
          await shot('08-new-server');
          await js(`document.querySelectorAll('.choice.big')[1].click()`);
          await waitFor(`document.querySelectorAll('.world-row').length >= 3`);
          await js(`document.querySelector('.world-row').click()`);
          await waitFor(`!!document.querySelector('.world-opts select')`);
          await shot('09-import-world');
        }
        await js(`window.blockyard['server:stop']('s1')`);
        await sleep(1500);
        router.close();
        app.exit(0);
      } catch (e) { console.error('CAPTURE ERROR', e.message); await shot('ERR'); app.exit(1); }
    });
  });
});
