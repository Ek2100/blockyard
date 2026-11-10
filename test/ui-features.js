// UI run-through of Public Access / playit / Backups / Modrinth / Automation with fakes.
// xvfb-run -a npx electron --no-sandbox test/ui-features.js
const { app, nativeTheme } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { startRouter } = require('./fake/router');

const OUT = path.join(__dirname, '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'by-uif-'));
app.setPath('userData', ud);
if (process.env.DARK) nativeTheme.themeSource = 'dark';

const dir = path.join(ud, 'srv', 'Friends SMP');
fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
fs.mkdirSync(path.join(dir, 'world/region'), { recursive: true });
fs.writeFileSync(path.join(dir, 'world/level.dat'), Buffer.alloc(200000, 1));
fs.copyFileSync(path.join(__dirname, 'fake/server.jar'), path.join(dir, 'server.jar'));
fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
fs.writeFileSync(path.join(dir, 'server.properties'), 'motd=Friends SMP\nserver-port=25631\nlevel-name=world\n');
fs.writeFileSync(path.join(dir, 'plugins/LuckPerms.jar'), 'x');
const javaPath = execSync('readlink -f $(which java)').toString().trim();
fs.writeFileSync(path.join(ud, 'servers.json'), JSON.stringify({ servers: [
  { id: 's1', name: 'Friends SMP', dir, software: 'paper', kind: 'plugins', mcVersion: '1.21.4', javaMajor: 21, memoryMB: 2048, launchArgs: ['-jar', 'server.jar'], jvmArgs: '', javaPath, access: { method: 'upnp', auto: true }, backup: { intervalHours: 6, keep: 10, scope: 'world' } },
], settings: { keepAwake: true } }));
// playit agent "installed" (fake daemon)
fs.mkdirSync(path.join(ud, 'playit/bin'), { recursive: true });
fs.copyFileSync(path.join(__dirname, 'fake/fake-playitd.js'), path.join(ud, 'playit/bin/playitd'));
fs.chmodSync(path.join(ud, 'playit/bin/playitd'), 0o755);

let setup = 0;
const routes = {
  'https://api.ipify.org?format=json': { ip: '203.0.113.7' },
  'https://api.mcsrvstat.us/3/203.0.113.7%3A25631': { online: true, version: '1.21.4' },
  'https://api.mcsrvstat.us/3/friendly-cat.joinmc.link': { online: true },
  'https://api.playit.gg/claim/setup': () => ({ status: 'success', data: ['WaitingForUserVisit', 'WaitingForUser', 'UserAccepted'][Math.min(2, Math.floor(setup++ / 2))] }),
  'https://api.playit.gg/claim/exchange': { status: 'success', data: { secret_key: 'cd'.repeat(32) } },
  'https://api.playit.gg/tunnels/create': () => {
    setTimeout(() => fs.writeFileSync(path.join(ud, 'playit/tunnels.json'), JSON.stringify([{ id: 't1', display_address: 'friendly-cat.joinmc.link', destination: '127.0.0.1:25631', is_disabled: false, disabled_reason: null }])), 300);
    return { status: 'success', data: { id: 't1' } };
  },
  'https://api.modrinth.com/v2/search': {
    total_hits: 3, hits: [
      { project_id: 'a', slug: 'essentialsx', title: 'EssentialsX', description: 'The essential plugin suite for Minecraft servers: homes, warps, kits, economy and 130+ commands.', icon_url: null, downloads: 2400000, author: 'EssentialsX', display_categories: ['utility', 'management'] },
      { project_id: 'b', slug: 'luckperms', title: 'LuckPerms', description: 'A permissions plugin for Minecraft servers.', icon_url: null, downloads: 1900000, author: 'Luck', display_categories: ['management'] },
      { project_id: 'c', slug: 'chunky', title: 'Chunky', description: 'Pre-generates chunks, quickly and efficiently.', icon_url: null, downloads: 980000, author: 'pop4959', display_categories: ['optimization'] },
    ],
  },
  'https://api.modrinth.com/v2/project/c/version': [{ id: 'cv', version_type: 'release', version_number: '1.4.28', files: [{ primary: true, filename: 'Chunky-Bukkit-1.4.28.jar', url: 'https://cdn/chunky.jar', hashes: {} }], dependencies: [] }],
  'https://cdn/chunky.jar': Buffer.from('chunky'),
};
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  let r = routes[url] ?? routes[url.split('?')[0]];
  if (typeof r === 'function') r = r(url, opts);
  if (r === undefined) { console.log('UNMOCKED', url); return { ok: false, status: 404, headers: { get: () => null }, text: async () => '{}', json: async () => ({}) }; }
  const buf = Buffer.isBuffer(r) ? r : null;
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => r, text: async () => JSON.stringify(r), body: (async function* () { if (buf) yield buf; })() };
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
startRouter({ externalIP: '203.0.113.7' }).then(router => {
  process.env.BLOCKYARD_PORTMAP_OPTS = JSON.stringify({ gateway: '127.0.0.1', lanIp: '192.168.1.42', pmpPort: router.pmpPort, locations: [router.location], firstTimeout: 100 });
  require('../src/main/main.js');
  app.on('browser-window-created', (_e, win) => {
    win.webContents.on('console-message', e => console.log('[renderer]', e.level ?? '', e.message ?? e));
    win.webContents.once('did-finish-load', async () => {
      const js = code => win.webContents.executeJavaScript(code);
      const shot = async name => { await sleep(500); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); console.log('shot', name); };
      const tab = t => js(`[...document.querySelectorAll('.tab')].find(x => x.textContent === ${JSON.stringify(t)}).click()`);
      const clickText = (t, sel = 'button') => js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => x.textContent.trim() === ${JSON.stringify(t)}); if (!b) throw new Error('no button ' + ${JSON.stringify(t)}); b.click(); })()`);
      const waitFor = async (cond, ms = 10000) => { for (let i = 0; i < ms / 100; i++) { if (await js(cond)) return true; await sleep(100); } throw new Error('timeout waiting for ' + cond); };
      const P = process.env.DARK ? 'dark-' : 'f';
      try {
        win.setSize(1240, 860);
        await sleep(800);
        await tab('Public Access');
        await shot(`${P}01-access-offline`);
        await js(`document.querySelector('.actions .btn.primary').click()`);
        await waitFor(`!!document.querySelector('.pill.online')`);
        await waitFor(`document.querySelector('.chip')?.textContent.includes('203.0.113.7')`);
        await sleep(300);
        await shot(`${P}02-access-upnp-open`);
        if (process.env.DARK) { app.exit(0); return; }
        // 1.2: the internet test runs by itself once the port is open
        await waitFor(`document.body.textContent.includes('Reachable from the internet')`, 15000);
        await js(`document.querySelector('.access-adv').open = true`);
        await clickText('Check My Network');
        await waitFor(`document.body.textContent.includes('You have a public IP')`, 15000);
        await shot('f03-access-tested-diag');
        // switch to playit
        await js(`[...document.querySelectorAll('.method')].find(m => m.textContent.includes('playit.gg tunnel')).click()`);
        await waitFor(`document.body.textContent.includes('Link your playit account')`);
        await waitFor(`!!document.querySelector('.chip') && !document.querySelector('.chip').textContent.includes('203.0.113.7')`);
        await shot('f04-playit-steps');
        await clickText('Link Account');
        await waitFor(`document.body.textContent.includes('Linked as a guest')`, 15000);
        await shot('f05-playit-linked');
        await clickText('Create Tunnel');
        await waitFor(`document.querySelector('.chip')?.textContent.includes('friendly-cat.joinmc.link')`, 15000);
        await shot('f06-playit-tunnel');
        await waitFor(`document.querySelector('.hero-addr')?.textContent.includes('friendly-cat.joinmc.link') && document.body.textContent.includes('Reachable from the internet')`, 15000);
        await js(`document.querySelector('.chip').click()`);
        await shot('f07-connect-popover');
        await js(`document.querySelectorAll('.popover').forEach(p => p.remove())`);
        // manual + vpn screens
        await js(`[...document.querySelectorAll('.method')].find(m => m.textContent.includes('Manual port')).click()`);
        await waitFor(`document.body.textContent.includes('Add a port forwarding rule')`);
        await shot('f08-manual');
        await js(`[...document.querySelectorAll('.method')].find(m => m.textContent.includes('playit.gg tunnel')).click()`);
        // backups
        await tab('Backups');
        await waitFor(`document.body.textContent.includes('Automatic backups')`);
        await clickText('Back Up World Now');
        await waitFor(`document.querySelectorAll('.table tbody tr').length === 1`, 15000);
        await shot('f09-backups');
        // modrinth
        await tab('Plugins');
        await clickText('Browse Modrinth');
        await waitFor(`document.querySelectorAll('.mr-card').length === 3`);
        await js(`[...document.querySelectorAll('.mr-card')].find(c => c.textContent.includes('Chunky')).querySelector('.btn').click()`);
        await waitFor(`[...document.querySelectorAll('.mr-card')].find(c => c.textContent.includes('Chunky')).querySelector('.btn').textContent.includes('Installed')`);
        await shot('f10-modrinth');
        await clickText('Installed');
        await waitFor(`document.body.textContent.includes('Chunky-Bukkit-1.4.28')`);
        // settings / automation
        await tab('Settings');
        await waitFor(`document.body.textContent.includes('Automation')`);
        await js(`document.querySelector('.auto').scrollIntoView()`);
        await shot('f11-automation');
        // console shows what happened
        await tab('Console');
        await shot('f12-console');
        await js(`window.blockyard['server:stop']('s1')`);
        await waitFor(`!document.querySelector('.srv .dot.online')`, 15000);
        await sleep(600);
        console.log('UPNP after stop:', JSON.stringify([...router.state.pmpMaps.keys()]), JSON.stringify([...router.state.upnpMaps.keys()]));
        console.log('backups:', fs.readdirSync(path.join(dir, 'backups')).join(','));
        console.log('plugins:', fs.readdirSync(path.join(dir, 'plugins')).join(','));
        console.log('config:', JSON.stringify(JSON.parse(fs.readFileSync(path.join(ud, 'servers.json'), 'utf8')).servers[0].access));
        app.exit(0);
      } catch (e) { console.error('HARNESS ERROR', e.message); await shot('fERR'); app.exit(1); }
    });
  });
});
