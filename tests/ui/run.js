// End-to-end UI test: the real engine (blockyard-bridge) + the real UI in headless Chromium.
// Outside services (Mojang, Paper, Fabric, Modrinth) are mocked; the Minecraft server is the fake jar.
//   cargo build -p blockyard-core --bins && node tests/ui/run.js
const { chromium } = require('playwright');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'by-ui-'));
const jar = fs.readFileSync(path.join(ROOT, 'test', 'fake', 'server.jar'));
const sha = (alg, b) => crypto.createHash(alg).update(b).digest('hex');
let failures = 0;
const expect = (cond, msg) => { if (cond) console.log('  ✓', msg); else { failures++; console.log('  ✗', msg); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- mocked web services ----------
const modA = Buffer.from('fabric mod a');
const routes = {
  'piston-meta.mojang.com/mc/game/version_manifest_v2.json': { versions: [{ id: '1.21.4', type: 'release', url: 'https://piston-meta.mojang.com/v1/1.21.4.json' }] },
  'piston-meta.mojang.com/v1/1.21.4.json': { javaVersion: { majorVersion: 17 }, downloads: { server: { url: 'https://piston-data.mojang.com/server.jar' } } },
  'fill.papermc.io/v3/projects/paper': { versions: { '1.21': ['1.21.4'] } },
  'fill.papermc.io/v3/projects/paper/versions/1.21.4/builds': [{ id: 232, channel: 'STABLE', downloads: { 'server:default': { url: 'https://fill-data.papermc.io/paper.jar' } } }],
  'fill-data.papermc.io/paper.jar': jar,
  'api.mojang.com/users/profiles/minecraft/alex': { id: '61699b2ed3274a019f1e0ea8c3f06bc6', name: 'Alex' },
  'meta.fabricmc.net/v2/versions/installer': [{ version: '1.0.1', stable: true }],
  'meta.fabricmc.net/v2/versions/loader/1.21.4/0.16.9/1.0.1/server/jar': jar,
  'cdn.modrinth.com/pack/mod-a.jar': modA,
  'api.ipify.org?format=json': { ip: '198.51.100.20' },
};
const mock = http.createServer((req, res) => {
  const key = req.url.slice(1);
  const hit = routes[key] ?? Object.entries(routes).find(([k]) => k.endsWith('*') && key.startsWith(k.slice(0, -1)))?.[1];
  if (hit == null) { res.statusCode = 404; return res.end(); }
  const body = Buffer.isBuffer(hit) ? hit : Buffer.from(JSON.stringify(typeof hit === 'function' ? hit(key) : hit));
  res.setHeader('Content-Length', body.length); res.end(body);
});
routes['api.modrinth.com/v2/search*'] = () => ({ total_hits: 1, hits: [{ project_id: 'COZY', slug: 'cozy', title: 'Cozy Fabric', description: 'A small test pack', downloads: 5, author: 'tester', display_categories: [] }] });

// ---------- a modpack file ----------
function makeMrpack(file) {
  // A minimal zip writer is overkill here: use the system zip (Linux CI has it) or Python's zipfile.
  const dir = fs.mkdtempSync(path.join(tmp, 'pack-'));
  fs.writeFileSync(path.join(dir, 'modrinth.index.json'), JSON.stringify({ formatVersion: 1, game: 'minecraft', versionId: '1.0', name: 'Cozy Fabric',
    dependencies: { minecraft: '1.21.4', 'fabric-loader': '0.16.9' },
    files: [{ path: 'mods/mod-a.jar', hashes: { sha1: sha('sha1', modA), sha512: sha('sha512', modA) }, env: { client: 'required', server: 'required' }, downloads: ['https://cdn.modrinth.com/pack/mod-a.jar'], fileSize: modA.length }] }));
  fs.mkdirSync(path.join(dir, 'overrides', 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'overrides', 'config', 'cozy.toml'), 'cozy = true\n');
  execSync(`python3 -I -c "import zipfile,os,sys; z=zipfile.ZipFile(sys.argv[1],'w'); [z.write(os.path.join(r,f), os.path.relpath(os.path.join(r,f), sys.argv[2])) for r,_,fs in os.walk(sys.argv[2]) for f in fs]" "${file}" "${dir}"`);
}

async function main() {
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const mockBase = `http://127.0.0.1:${mock.address().port}`;

  // Seed one Paper server that runs the fake jar.
  const data = path.join(tmp, 'data');
  const srv = path.join(tmp, 'servers', 'Friends SMP');
  fs.mkdirSync(path.join(srv, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(srv, 'server.jar'), jar);
  for (const p of ['EssentialsX-2.21.0.jar', 'LuckPerms-Bukkit-5.4.jar']) fs.writeFileSync(path.join(srv, 'plugins', p), Buffer.alloc(150000));
  fs.writeFileSync(path.join(srv, 'eula.txt'), 'eula=true\n');
  const port = 25611;
  fs.writeFileSync(path.join(srv, 'server.properties'), `motd=Friends SMP\nserver-port=${port}\nonline-mode=true\nlevel-name=world\n`);
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'servers.json'), JSON.stringify({ servers: [{ id: 's1', name: 'Friends SMP', dir: srv, software: 'paper', kind: 'plugins', mcVersion: '1.21.4', javaMajor: 17, memoryMB: 1024, launchArgs: ['-jar', 'server.jar'], jvmArgs: '', javaPath: '' }], settings: { keepAwake: false, defaultParent: path.join(tmp, 'servers') } }));

  const bridgeBin = path.join(ROOT, 'target', 'debug', process.platform === 'win32' ? 'blockyard-bridge.exe' : 'blockyard-bridge');
  const router = JSON.stringify({ gateway: '127.0.0.1', lanIp: '192.168.1.50', pmpPort: 9, locations: [], firstTimeout: 30 });
  const bridge = spawn(bridgeBin, ['--ui', path.join(ROOT, 'ui'), '--data', data, '--port', '0', '--router', router], { env: { ...process.env, BLOCKYARD_HTTP_OVERRIDE: mockBase }, stdio: ['ignore', 'pipe', 'inherit'] });
  const base = await new Promise((resolve, reject) => {
    bridge.stdout.on('data', d => { const m = String(d).match(/BRIDGE (http\S+)/); if (m) resolve(m[1]); });
    bridge.on('exit', c => reject(new Error(`bridge exited ${c}`)));
  });
  const post = (p, body) => fetch(base + p, { method: 'POST', body: JSON.stringify(body ?? {}) });

  const browser = await chromium.launch();
  for (const scheme of ['light', 'dark']) {
    if (scheme === 'dark') { console.log('\nDark mode screenshots'); }
    const page = await browser.newPage({ viewport: { width: 1240, height: 800 }, colorScheme: scheme, deviceScaleFactor: 1 });
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    // Player heads come from mc-heads.net, which some sandboxes can't reach: not an app error.
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    const shot = async name => { await sleep(350); await page.screenshot({ path: path.join(OUT, `${scheme === 'dark' ? 'dark-' : ''}${name}.png`) }); };
    const clickTab = t => page.locator('.tab', { hasText: new RegExp(`^${t}$`) }).click();
    const pillState = () => page.locator('.header .pill').getAttribute('class');
    const waitPill = async (st, ms = 30000) => { await page.waitForFunction(st => document.querySelector('.header .pill')?.classList.contains(st), st, { timeout: ms }); };
    await page.goto(base + '/');
    await page.waitForSelector('.srv');

    if (scheme === 'dark') {
      await shot('console');
      await clickTab('Public Access'); await shot('public-access');
      await page.close();
      continue;
    }

    console.log('Start a server and see players');
    expect((await page.locator('.srv .name').first().textContent()) === 'Friends SMP', 'seeded server shows in the sidebar');
    await shot('01-offline');
    await page.locator('.actions .btn.primary', { hasText: 'Start' }).click();
    await waitPill('online');
    expect(true, 'Start → Online');
    for (const c of ['join Steve', 'join .BedrockPal', 'say hi', 'error']) { await page.fill('#cmd', c); await page.keyboard.press('Enter'); await sleep(150); }
    await page.waitForFunction(() => document.querySelector('.log')?.textContent.includes('Steve joined the game'));
    expect(true, 'console shows server output, commands work');
    await shot('02-console');
    await clickTab('Players');
    await page.waitForSelector('text=.BedrockPal');
    expect(await page.locator('text=Steve').count() > 0, 'Players tab lists Steve and the Bedrock player');
    await shot('03-players');

    console.log('Go public: whitelist turns on, risks are explained, invite a friend');
    await clickTab('Public Access');
    await page.locator('.choice', { hasText: 'Friends anywhere' }).click();
    await page.waitForSelector('.safety');
    expect(await page.locator('.toast', { hasText: 'Whitelist turned on' }).waitFor({ timeout: 5000 }).then(() => true, () => false), 'toast says the whitelist was turned on');
    expect((await page.locator('.safety strong').first().textContent()).includes('Only people you invite'), 'safety card: only invited people can join');
    expect(fs.readFileSync(path.join(srv, 'whitelist.json'), 'utf8').includes('Steve'), 'players already online were kept on the whitelist');
    await page.locator('.safety summary').click();
    expect(await page.locator('.risks li').count() === 5, 'the risks are listed');
    await shot('04-public-safety');
    await page.locator('button', { hasText: 'Invite a Friend' }).click();
    await page.fill('.modal input[type=text]', 'alex');
    await page.locator('.modal button', { hasText: 'Add to Whitelist' }).click();
    await page.waitForSelector('.invite-text');
    expect((await page.inputValue('.invite-text')).includes('Hey Alex! Join my Minecraft server (Java Edition 1.21.4)'), 'invite message is ready to send');
    await shot('05-invite');
    await page.locator('.modal button', { hasText: 'Copy Message' }).click();
    const log1 = await (await fetch(base + '/test/log')).json();
    expect(log1.some(l => l.kind === 'clipboard:write' && String(l.args[0]).includes('Alex')), 'Copy Message puts it on the clipboard');
    await page.locator('.modal button', { hasText: 'Done' }).click();
    // Turning the whitelist off asks first, and warns afterwards.
    await post('/test/answers', [0]);
    await page.locator('.safety .switch').click();
    await page.waitForSelector('.safety .note.err');
    expect((await page.locator('.safety .note.err').textContent()).includes('whitelist is off'), 'whitelist off → a clear warning');
    await shot('06-whitelist-off-warning');
    await page.locator('.safety .switch').click();
    await page.waitForFunction(() => !document.querySelector('.safety .note.err'));
    expect(true, 'whitelist back on → warning gone');

    console.log('Sleep mode');
    await clickTab('Settings');
    await page.waitForSelector('text=Sleep when nobody');
    await shot('07-automation');
    await fetch(base + '/call', { method: 'POST', body: JSON.stringify({ channel: 'servers:update', args: ['s1', { automation: { sleepWhenEmpty: 0.002 } }] }) });
    await page.fill('#cmd', 'leave Steve').catch(() => {});
    await clickTab('Console');
    for (const c of ['leave Steve', 'leave .BedrockPal']) { await page.fill('#cmd', c); await page.keyboard.press('Enter'); await sleep(150); }
    await sleep(500);
    await post('/test/tick');
    await waitPill('sleeping');
    expect(await page.locator('.actions .btn', { hasText: 'Wake Up' }).count() === 1, 'sleeping: header offers Wake Up and Stop');
    expect((await page.locator('.srv .dot').first().getAttribute('class')).includes('sleeping'), 'sidebar shows it asleep');
    await shot('08-sleeping');
    await page.locator('.actions .btn', { hasText: 'Wake Up' }).click();
    await waitPill('online');
    expect(true, 'Wake Up → Online');
    await fetch(base + '/call', { method: 'POST', body: JSON.stringify({ channel: 'servers:update', args: ['s1', { automation: { sleepWhenEmpty: 0 } }] }) });
    await page.locator('.actions .btn', { hasText: 'Stop' }).click();
    await waitPill('stopped');
    expect(true, 'Stop → Offline');

    console.log('New server wizard');
    await page.click('#btn-new');
    await shot('09-new-server');
    await page.locator('.choice.big', { hasText: 'Start a fresh world' }).click();
    await page.waitForFunction(() => { const s = document.querySelector('.wizard select'); return s && !s.disabled; });
    await page.evaluate(() => { const n = document.querySelector('.wizard input[type=text]'); n.value = 'Survival World'; n.dispatchEvent(new Event('input')); });
    await page.locator('.modal .btn.primary').last().click();
    await page.locator('.choice', { hasText: 'Only people on my Wi-Fi' }).click();
    await page.check('.eula input');
    await page.locator('.modal .btn.primary').last().click();
    await page.waitForSelector('.modal .btn:has-text("Close")', { timeout: 60000 });
    expect(fs.existsSync(path.join(tmp, 'servers', 'Survival World', 'server.jar')), 'wizard created "Survival World" with Paper downloaded');
    await shot('10-created');
    await page.locator('.modal .btn', { hasText: 'Close' }).click();

    console.log('Modpack');
    const pack = path.join(tmp, 'cozy.mrpack');
    makeMrpack(pack);
    await page.click('#btn-new');
    await page.locator('.choice.big', { hasText: 'Install a modpack' }).click();
    await page.waitForSelector('.mr-item');
    expect((await page.locator('.mr-item strong').first().textContent()) === 'Cozy Fabric', 'Modrinth modpack search shows results');
    await shot('11-modpacks');
    await post('/test/pick', [pack]);
    await page.locator('.modal button', { hasText: 'Open .mrpack File' }).click();
    await page.waitForSelector('text=Minecraft 1.21.4');
    await page.check('.eula input');
    await shot('12-modpack-details');
    await page.locator('.modal button', { hasText: 'Install Modpack' }).click();
    await page.waitForFunction(() => !document.querySelector('.modal'), null, { timeout: 60000 });
    const packDir = path.join(tmp, 'servers', 'Cozy Fabric');
    expect(fs.existsSync(path.join(packDir, 'mods', 'mod-a.jar')) && fs.existsSync(path.join(packDir, 'config', 'cozy.toml')), 'modpack installed: mods + overrides');
    expect(fs.readFileSync(path.join(packDir, 'server.properties'), 'utf8').includes('white-list=true'), 'modpack server went public with the whitelist on');
    await shot('13-modpack-server');

    console.log('Other tabs render');
    await page.locator('.srv', { hasText: 'Friends SMP' }).click();
    for (const t of ['Stats', 'Files', 'Plugins', 'Worlds', 'Backups', 'Properties']) { await clickTab(t); await sleep(300); await shot(`14-${t.toLowerCase()}`); }
    await page.click('#btn-settings'); await shot('15-app-settings');
    expect(errors.length === 0, `no errors in the page${errors.length ? ': ' + errors.join(' | ') : ''}`);
    await page.close();
  }
  await browser.close();
  await post('/test/shutdown').catch(() => {});
  mock.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll UI checks passed');
  process.exit(failures ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
