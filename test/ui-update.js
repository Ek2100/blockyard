// Checks the "new version" notice: a fake GitHub release newer than package.json shows a sidebar note.
// xvfb-run -a npx electron --no-sandbox test/ui-update.js
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(__dirname, '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'by-upd-'));
app.setPath('userData', ud);
process.env.BLOCKYARD_TEST = '1';

let apiCalls = 0;
global.fetch = async url => {
  url = String(url);
  if (url === 'https://api.github.com/repos/Ek2100/blockyard/releases/latest') {
    apiCalls++;
    const body = { tag_name: 'v9.9.9', html_url: 'https://github.com/Ek2100/blockyard/releases/tag/v9.9.9', assets: [{ name: 'Blockyard-9.9.9-arm64.zip', browser_download_url: 'https://github.com/x.zip' }] };
    return { ok: true, status: 200, json: async () => body };
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
require('../src/main/main.js');
app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const js = code => win.webContents.executeJavaScript(code);
    const fail = msg => { console.error('FAIL', msg); app.exit(1); };
    try {
      for (let i = 0; i < 80 && !(await js(`!!document.getElementById('update-note')`)); i++) await sleep(100);
      const text = await js(`document.getElementById('update-note')?.textContent || ''`);
      if (!/Blockyard 9\.9\.9 is out/.test(text)) return fail('no update note: ' + text);
      fs.writeFileSync(path.join(OUT, 'u01-update-note.png'), (await win.webContents.capturePage()).toPNG());
      await js(`[...document.querySelectorAll('#update-note button')].find(b => b.textContent === 'Later').click()`);
      if (await js(`!!document.getElementById('update-note')`)) return fail('Later did not dismiss');
      // Turning the check off stops background checks but a manual check still works.
      await js(`window.blockyard['settings:set']({ checkUpdates: false })`);
      const off = await js(`window.blockyard['app:checkUpdate'](false)`);
      if (!off.disabled || off.available) return fail('disabled check still ran');
      const forced = await js(`window.blockyard['app:checkUpdate'](true)`);
      if (!forced.available || forced.latest !== '9.9.9') return fail('forced check failed');
      console.log('PASS update notice', { apiCalls });
      app.exit(0);
    } catch (e) { fail(e.message); }
  });
});
