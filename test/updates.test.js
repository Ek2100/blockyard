const test = require('node:test');
const assert = require('node:assert');
const u = require('../src/main/updates');

const reply = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('version comparison', () => {
  assert.deepStrictEqual(u.parseVersion('v1.2.10'), [1, 2, 10]);
  assert.ok(u.isNewer('1.3.0', '1.2.9'));
  assert.ok(u.isNewer('v1.2.10', '1.2.9'));
  assert.ok(!u.isNewer('1.2.0', '1.2.0'));
  assert.ok(!u.isNewer('1.1.9', '1.2.0'));
  assert.ok(!u.isNewer('garbage', '1.2.0'));
});

test('finds a newer release and picks the arm64 zip', async () => {
  const up = u.createUpdater({ currentVersion: '1.2.0', userAgent: 'x', fetchImpl: reply(200, {
    tag_name: 'v1.3.0', html_url: 'https://github.com/Ek2100/blockyard/releases/tag/v1.3.0', body: 'notes',
    assets: [{ name: 'Blockyard-1.3.0-arm64.zip', browser_download_url: 'https://example/a.zip' }],
  }) });
  const r = await up.check();
  assert.strictEqual(r.available, true);
  assert.strictEqual(r.latest, '1.3.0');
  assert.strictEqual(r.download, 'https://example/a.zip');
});

test('no release yet, prereleases and same version are not offered', async () => {
  for (const [status, body] of [[404, {}], [200, { tag_name: 'v9.0.0', prerelease: true }], [200, { tag_name: 'v1.2.0' }]]) {
    const r = await u.createUpdater({ currentVersion: '1.2.0', userAgent: 'x', fetchImpl: reply(status, body) }).check();
    assert.strictEqual(r.available, false);
  }
});

test('caches results and rethrows API errors', async () => {
  let calls = 0;
  const up = u.createUpdater({ currentVersion: '1.2.0', userAgent: 'x', fetchImpl: async () => { calls++; return { status: 200, ok: true, json: async () => ({ tag_name: 'v1.2.0' }) }; } });
  await up.check(); await up.check();
  assert.strictEqual(calls, 1);
  await up.check({ force: true });
  assert.strictEqual(calls, 2);
  await assert.rejects(u.createUpdater({ currentVersion: '1', userAgent: 'x', fetchImpl: reply(403, {}) }).check(), /403/);
});

test('issue link carries version info but nothing personal', () => {
  const url = u.issueUrl({ version: '1.2.0', macos: '15.1', arch: 'arm64' });
  assert.ok(url.startsWith('https://github.com/Ek2100/blockyard/issues/new?body='));
  assert.match(decodeURIComponent(url), /Blockyard 1\.2\.0 · macOS 15\.1 · arm64/);
});
