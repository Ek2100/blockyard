// Drives the real app under xvfb and saves screenshots: xvfb-run -a npx electron --no-sandbox test/ui-harness.js
const { app, BrowserWindow, nativeTheme } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(__dirname, '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'by-ui-'));
app.setPath('userData', ud);
const MODE = process.env.MODE || 'full';

// Seed one server
const dir = path.join(ud, 'srv', 'Friends SMP');
fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
fs.copyFileSync(path.join(__dirname, 'fake', 'server.jar'), path.join(dir, 'server.jar'));
for (const p of ['EssentialsX-2.21.0.jar', 'LuckPerms-Bukkit-5.4.jar', 'WorldEdit-7.3.jar.disabled']) fs.writeFileSync(path.join(dir, 'plugins', p), Buffer.alloc(150000));
fs.mkdirSync(path.join(dir, 'world', 'region'), { recursive: true });
fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
fs.writeFileSync(path.join(dir, 'ops.json'), '[{"uuid":"x","name":"Steve","level":4}]');
fs.writeFileSync(path.join(dir, 'whitelist.json'), '[{"uuid":"x","name":"Steve"},{"uuid":"y","name":"Alex"}]');
fs.writeFileSync(path.join(dir, 'server.properties'), ['#Minecraft server properties', 'motd=Friends SMP', 'server-port=25611', 'max-players=20', 'gamemode=survival', 'difficulty=normal', 'hardcore=false', 'pvp=true', 'white-list=true', 'online-mode=true', 'view-distance=10', 'simulation-distance=10', 'level-name=world', 'level-seed=', 'allow-nether=true', 'enable-command-block=false', 'spawn-protection=16', 'rcon.port=25575', 'sync-chunk-writes=true', 'max-tick-time=60000'].join('\n'));
const javaPath = require('child_process').execSync('readlink -f $(which java)').toString().trim();
if (MODE === 'full') {
  fs.writeFileSync(path.join(ud, 'servers.json'), JSON.stringify({ servers: [
    { id: 's1', name: 'Friends SMP', dir, software: 'paper', kind: 'plugins', mcVersion: '1.21.4', javaMajor: 21, memoryMB: 4096, launchArgs: ['-jar', 'server.jar'], jvmArgs: '', javaPath },
    { id: 's2', name: 'Creative Build', dir: path.join(ud, 'srv', 'c'), software: 'fabric', kind: 'mods', mcVersion: '26.1.2', javaMajor: 25, memoryMB: 3072, launchArgs: ['-jar', 'fabric-server.jar'], jvmArgs: '', javaPath: '' },
    { id: 's3', name: 'ATM10 Modpack', dir: path.join(ud, 'srv', 'd'), software: 'neoforge', kind: 'mods', mcVersion: '1.21.1', javaMajor: 21, memoryMB: 8192, launchArgs: ['-jar', 'x.jar'], jvmArgs: '', javaPath: '' },
  ], settings: { keepAwake: true } }));
}

// Mock the download APIs (the sandbox can't reach them)
const jar = fs.readFileSync(path.join(__dirname, 'fake', 'server.jar'));
global.fetch = async url => {
  const data = {
    'https://fill.papermc.io/v3/projects/paper': { versions: { '26.2': ['26.2'], '26.1': ['26.1.2', '26.1.1'], '1.21': ['1.21.11', '1.21.10', '1.21.4'] } },
    'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json': { versions: [{ id: '1.21.4', type: 'release', url: 'https://m/1.21.4.json' }] },
    'https://m/1.21.4.json': { javaVersion: { majorVersion: 21 } },
    'https://fill.papermc.io/v3/projects/paper/versions/1.21.4/builds': [{ id: 232, channel: 'STABLE', downloads: { 'server:default': { url: 'https://dl/paper.jar' } } }],
    'https://dl/paper.jar': jar,
  }[url];
  if (!data) return { ok: false, status: 404 };
  await new Promise(r => setTimeout(r, 300));
  return { ok: true, status: 200, json: async () => data, headers: { get: k => (k === 'content-length' && Buffer.isBuffer(data) ? String(data.length) : null) },
    body: (async function* () { for (let i = 0; i < jar.length; i += 500) { await new Promise(r => setTimeout(r, 40)); yield jar.subarray(i, i + 500); } })() };
};

require('../src/main/main.js');
if (process.env.DARK) nativeTheme.themeSource = 'dark';

const sleep = ms => new Promise(r => setTimeout(r, ms));
app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (e) => { console.log('[renderer]', e.level ?? '', e.message, (e.sourceId||'').split('/').pop(), e.lineNumber); });
  win.webContents.on('render-process-gone', (_e, d) => console.log('RENDERER GONE', d));
  win.webContents.once('did-finish-load', async () => {
    const js = code => win.webContents.executeJavaScript(code);
    const shot = async name => { await sleep(450); fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG()); console.log('shot', name); };
    const clickTab = t => js(`[...document.querySelectorAll('.tab')].find(x => x.textContent === ${JSON.stringify(t)}).click()`);
    try {
      win.setSize(1240, 800);
      await sleep(900);
      if (MODE === 'welcome') { await shot('welcome'); app.exit(0); return; }
      if (MODE === 'drag') {
        const dragEls = `JSON.stringify([...document.querySelectorAll('*')].filter(e => getComputedStyle(e).webkitAppRegion === 'drag').map(e => e.className || e.id || e.tagName))`;
        console.log('DRAG closed:', await js(dragEls));
        await js(`document.getElementById('btn-new').click()`); await sleep(500);
        console.log('DRAG modal open:', await js(dragEls));
        console.log('modal-open class:', await js(`document.body.classList.contains('modal-open')`));
        await js(`[...document.querySelectorAll('.modal .btn')].find(b => b.textContent === 'Cancel').click()`); await sleep(200);
        console.log('DRAG after close:', await js(dragEls), await js(`document.body.classList.contains('modal-open')`));
        app.exit(0); return;
      }
      await shot('01-console-offline');
      await js(`document.querySelector('.actions .btn.primary').click()`);
      for (let i = 0; i < 40; i++) { await sleep(250); if (await js(`!!document.querySelector('.pill.online')`)) break; }
      for (const c of ['join Steve', 'join Alex', 'join .BedrockPal', 'say hi', 'error', 'list']) { await js(`window.blockyard['server:command']('s1', ${JSON.stringify(c)})`); await sleep(120); }
      await sleep(2800); // let stats sample
      await shot(process.env.DARK ? 'dark-console' : '02-console-online');
      if (process.env.DARK) { await clickTab('Players'); await shot('dark-players'); }
      else {
        await clickTab('Players'); await shot('03-players');
        await clickTab('Files'); await shot('04-files');
        await js(`[...document.querySelectorAll('.table td.name')].find(td => td.textContent.includes('server.properties')).parentElement.dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))`);
        await shot('05-editor');
        await js(`document.querySelector('.modal-foot .btn').click()`);
        await clickTab('Plugins'); await shot('06-plugins');
        await clickTab('Properties'); await shot('07-properties');
        await clickTab('Settings'); await shot('08-settings');
        await js(`document.querySelector('.chip').click()`); await shot('09-connect');
        await js(`document.querySelector('.popover')?.remove(); document.getElementById('btn-new').click()`);
        await sleep(600); await shot('10-new-server');
        // 1.2 wizard: fresh world → Plugins (Paper) → Wi-Fi only
        await js(`document.querySelectorAll('.choice.big')[0].click()`);
        for (let i = 0; i < 40; i++) { await sleep(150); if (await js(`!!document.querySelector('.wizard select') && !document.querySelector('.wizard select').disabled`)) break; }
        await js(`(() => { const sel = document.querySelector('.wizard select'); sel.value = '1.21.4'; sel.dispatchEvent(new Event('change')); const n = document.querySelector('.wizard input[type=text]'); n.value = 'Survival World'; n.dispatchEvent(new Event('input')); [...document.querySelectorAll('.modal .btn.primary')].pop().click(); })()`);
        await sleep(300);
        await js(`(() => { document.querySelectorAll('.choice')[1].click(); })()`);
        await sleep(200);
        await js(`(() => { const e = document.querySelector('.eula input'); e.checked = true; e.dispatchEvent(new Event('change')); [...document.querySelectorAll('.modal .btn.primary')].pop().click(); })()`);
        await sleep(1200); await shot('12-creating');
        for (let i = 0; i < 60; i++) { await sleep(250); if (await js(`[...document.querySelectorAll('.modal .btn')].some(b => /Start Server|Back/.test(b.textContent))`)) break; }
        await shot('13-created');
        await js(`[...document.querySelectorAll('.modal .btn')].find(b => b.textContent === 'Close').click()`);
        await sleep(500); await shot('14-new-server-selected');
        await js(`document.querySelectorAll('.srv')[0].click()`); await sleep(300);
        await clickTab('Plugins'); await shot('06b-plugins-fixed');
        await js(`document.querySelectorAll('.srv')[1].click()`); await sleep(300);
        await clickTab('Console'); await shot('11-other-server');
      }
      await js(`window.blockyard['server:stop']('s1')`);
      for (let i = 0; i < 40; i++) { await sleep(250); if (await js(`document.querySelectorAll('.dot.stopped, .srv .dot.stopped').length >= 3 || !document.querySelector('.srv .dot.online')`)) break; }
      await sleep(500);
      app.exit(0);
    } catch (e) { console.error('HARNESS ERROR', e); app.exit(1); }
  });
});
