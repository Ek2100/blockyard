// Zip backups of a server: "world" scope (worlds + configs + plugin data) or "full" (everything
// except logs/libraries/caches). Stored in <server>/backups. Live servers are paused with
// save-off / save-all flush so the files on disk are consistent, and always resumed with save-on.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { readProps } = require('./server-instance');

const LABELS = { manual: 'Manual', auto: 'Scheduled', 'pre-restore': 'Before restore' };
const NAME_RE = /^(world|full)-(\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d)-(manual|auto|pre-restore)(?:-\d+)?\.zip$/;
const ALWAYS_EXCLUDE = ['*/session.lock', 'session.lock', '*.part', '*.tmp', '.DS_Store', '*/.DS_Store', 'backups', 'backups/*'];
const FULL_EXCLUDE = ['logs', 'logs/*', 'libraries/*', 'cache/*', 'versions/*', 'crash-reports/*', '.fabric/*', 'bundler/*', 'debug/*'];

const backupDir = cfg => path.join(cfg.dir, 'backups');

function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.stdout.on('data', () => {});
    p.on('error', e => reject(new Error(`Couldn't run ${cmd}: ${e.message}`)));
    p.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${cmd} failed (exit ${code}) ${err.trim().slice(0, 300)}`))));
  });
}

/** Top-level folders that are worlds: level-name (+ _nether/_the_end) and anything holding a level.dat. */
function worldFolders(dir) {
  const level = readProps(dir)['level-name'] || 'world';
  const out = new Set();
  for (const n of [level, `${level}_nether`, `${level}_the_end`]) if (fs.existsSync(path.join(dir, n))) out.add(n);
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch {}
  for (const e of entries) if (e.isDirectory() && e.name !== 'backups' && fs.existsSync(path.join(dir, e.name, 'level.dat'))) out.add(e.name);
  return [...out];
}

/** What a "world" backup contains: worlds, top-level config files, config/ and plugin data (not jars). */
function worldScopeItems(dir) {
  const worlds = worldFolders(dir);
  if (!worlds.length) throw new Error('There’s no world folder to back up yet. Start the server once so Minecraft creates the world.');
  const items = [...worlds];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && !/\.(jar|log|part|tmp)$/i.test(e.name) && e.name !== '.DS_Store') items.push(e.name);
  }
  for (const d of ['config', 'plugins', 'defaultconfigs', 'serverconfig']) if (fs.existsSync(path.join(dir, d))) items.push(d);
  return { items, exclude: ['plugins/*.jar', 'plugins/*.jar.disabled', 'plugins/.paper-remapped/*', 'plugins/.paper-remapped'] };
}

function list(cfg) {
  const dir = backupDir(cfg);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map(file => ({ file, m: file.match(NAME_RE) }))
    .filter(x => x.m)
    .map(({ file, m }) => {
      const st = fs.statSync(path.join(dir, file));
      return { file, scope: m[1], reason: m[3], label: LABELS[m[3]], size: st.size, time: st.mtimeMs };
    })
    .sort((a, b) => b.time - a.time || b.file.localeCompare(a.file));
}

async function create(cfg, { scope = 'world', reason = 'manual', inst, log = () => {} } = {}) {
  const dir = cfg.dir;
  const plan = scope === 'full' ? { items: ['.'], exclude: FULL_EXCLUDE } : worldScopeItems(dir);
  const out = backupDir(cfg);
  fs.mkdirSync(out, { recursive: true });
  let file = `${scope}-${stamp()}-${reason}.zip`;
  for (let n = 2; fs.existsSync(path.join(out, file)); n++) file = `${scope}-${stamp()}-${reason}-${n}.zip`;
  const tmp = path.join(out, `.${file}.tmp`);

  const live = inst && inst.isRunning() && inst.state === 'online';
  if (live) {
    inst.send('save-off');
    const saved = inst.waitForLine(/Saved the game|Saved the world|All dimensions are saved|Saving complete/i, 60000);
    inst.send('save-all flush');
    try { await saved; } catch { log('The server didn’t confirm the save in time; backing up anyway.'); }
  }
  try {
    await run('zip', ['-r', '-q', '-y', tmp, ...plan.items, '-x', ...ALWAYS_EXCLUDE, ...plan.exclude], dir);
    fs.renameSync(tmp, path.join(out, file));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  } finally {
    if (live && inst.isRunning()) inst.send('save-on');
  }
  const st = fs.statSync(path.join(out, file));
  return { file, scope, reason, label: LABELS[reason], size: st.size, time: st.mtimeMs };
}

/** Delete scheduled backups beyond the newest `keep`. Manual and pre-restore backups are never pruned. */
function prune(cfg, keep = 10) {
  const removed = [];
  for (const b of list(cfg).filter(x => x.reason === 'auto').slice(Math.max(1, keep))) {
    fs.rmSync(path.join(backupDir(cfg), b.file), { force: true });
    removed.push(b.file);
  }
  return removed;
}

function zipEntries(zip) {
  return new Promise((resolve, reject) => {
    const p = spawn('unzip', ['-Z1', zip]);
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('error', reject);
    p.on('exit', code => (code === 0 ? resolve(out.split('\n').filter(Boolean)) : reject(new Error('That backup file is damaged or not a zip.'))));
  });
}

/**
 * Restore a backup (server must be stopped). Takes a "Before restore" safety copy, deletes the world
 * folders the backup contains so they're replaced rather than merged, then extracts it.
 */
async function restore(cfg, file, { log = () => {} } = {}) {
  const zip = path.join(backupDir(cfg), path.basename(file));
  if (!fs.existsSync(zip)) throw new Error('That backup no longer exists.');
  const scope = (path.basename(file).match(NAME_RE) || [])[1] || 'world';
  log('Saving a safety copy of the current state…');
  try { await create(cfg, { scope, reason: 'pre-restore' }); } catch (e) {
    if (!/no world folder/i.test(e.message)) throw e; // nothing to save is fine
  }
  const entries = await zipEntries(zip);
  const tops = new Set(entries.map(e => e.split('/')[0]));
  const level = readProps(cfg.dir)['level-name'] || 'world';
  const worlds = [...tops].filter(t => entries.includes(`${t}/level.dat`) || [level, `${level}_nether`, `${level}_the_end`].includes(t));
  for (const w of worlds) {
    const p = path.join(cfg.dir, w);
    if (path.dirname(p) === path.resolve(cfg.dir) && w !== 'backups') fs.rmSync(p, { recursive: true, force: true });
  }
  log(`Restoring ${worlds.length ? worlds.join(', ') : 'files'}…`);
  await run('unzip', ['-o', '-q', zip, '-d', cfg.dir], cfg.dir);
  log('Restore complete.');
  return { worlds };
}

module.exports = { create, list, prune, restore, backupDir, worldFolders };
