// Find installed Java runtimes and download Eclipse Temurin when the right one is missing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { download } = require('./net');

let managedRoot = path.join(os.homedir(), '.blockyard', 'java');
function setManagedRoot(dir) { managedRoot = dir; cache = null; }

function run(cmd, args) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: 10000 }, (err, stdout, stderr) => resolve({ err, out: String(stdout) + String(stderr) }));
  });
}

async function versionOf(bin) {
  const { out } = await run(bin, ['-version']);
  const m = out.match(/version "([^"]+)"/);
  if (!m) return null;
  const v = m[1];
  const major = v.startsWith('1.') ? parseInt(v.split('.')[1], 10) : parseInt(v, 10);
  return { version: v, major };
}

function findJavaBin(root, depth = 4) {
  // Locate bin/java inside an extracted JDK/JRE (macOS: */Contents/Home/bin/java).
  const direct = [path.join(root, 'Contents/Home/bin/java'), path.join(root, 'bin/java')];
  for (const d of direct) if (fs.existsSync(d)) return d;
  if (depth <= 0 || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) return null;
  for (const e of fs.readdirSync(root)) {
    const p = path.join(root, e);
    if (fs.statSync(p).isDirectory()) { const f = findJavaBin(p, depth - 1); if (f) return f; }
  }
  return null;
}

function globDirs(parent) {
  try { return fs.readdirSync(parent).map(e => path.join(parent, e)); } catch { return []; }
}

let cache = null;
async function listJavas(force = false) {
  if (cache && !force && Date.now() - cache.at < 30e3) return cache.list;
  const candidates = new Map(); // bin -> managed?
  for (const d of globDirs(managedRoot)) { const b = findJavaBin(d, 3); if (b) candidates.set(b, true); }

  if (process.platform === 'darwin') {
    // Never call /usr/bin/java on macOS: without a JDK it pops up an "install Java" dialog.
    const { out } = await run('/usr/libexec/java_home', ['-V']);
    for (const line of out.split('\n')) {
      const m = line.match(/\s(\/\S.*)$/);
      if (m && fs.existsSync(path.join(m[1].trim(), 'bin/java'))) candidates.set(path.join(m[1].trim(), 'bin/java'), false);
    }
    for (const parent of ['/Library/Java/JavaVirtualMachines', path.join(os.homedir(), 'Library/Java/JavaVirtualMachines')]) {
      for (const d of globDirs(parent)) { const b = path.join(d, 'Contents/Home/bin/java'); if (fs.existsSync(b)) candidates.set(b, false); }
    }
    for (const parent of ['/opt/homebrew/opt', '/usr/local/opt']) {
      for (const d of globDirs(parent)) if (/openjdk/.test(path.basename(d))) { const b = path.join(d, 'bin/java'); if (fs.existsSync(b)) candidates.set(b, false); }
    }
  } else {
    const { out, err } = await run('which', ['java']);
    if (!err && out.trim()) candidates.set(out.trim().split('\n')[0], false);
  }
  if (process.env.JAVA_HOME) { const b = path.join(process.env.JAVA_HOME, 'bin/java'); if (fs.existsSync(b)) candidates.set(b, false); }

  const seen = new Set();
  const list = [];
  for (const [bin, managed] of candidates) {
    let real; try { real = fs.realpathSync(bin); } catch { continue; }
    if (seen.has(real)) continue;
    seen.add(real);
    const v = await versionOf(bin);
    if (v) list.push({ path: bin, ...v, managed });
  }
  list.sort((a, b) => b.major - a.major);
  cache = { at: Date.now(), list };
  return list;
}

/** Exact major first; Java 17+ servers also run fine on newer Java. */
function pick(list, major) {
  const exact = list.filter(j => j.major === major);
  if (exact.length) return exact.find(j => j.managed) || exact[0];
  if (major >= 16) {
    const newer = list.filter(j => j.major > major).sort((a, b) => a.major - b.major);
    if (newer.length) return newer[0];
  }
  return null;
}

async function find(major) { return pick(await listJavas(), major); }

async function install(major, log = () => {}) {
  const feature = major === 16 ? 17 : major; // Temurin never shipped 16 as LTS; 17 runs 1.17 fine.
  const os_ = process.platform === 'darwin' ? 'mac' : 'linux';
  let arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  fs.mkdirSync(managedRoot, { recursive: true });
  const tarball = path.join(managedRoot, `temurin-${feature}.tar.gz`);
  const url = a => `https://api.adoptium.net/v3/binary/latest/${feature}/ga/${os_}/${a}/jre/hotspot/normal/eclipse`;
  log(`Downloading Java ${feature} (Eclipse Temurin)…`);
  const onProg = (got, total) => log(`Downloading Java ${feature}… ${(got / 1048576).toFixed(1)}${total ? ' / ' + (total / 1048576).toFixed(1) : ''} MB`, total ? got / total : null);
  try {
    await download(url(arch), tarball, onProg);
  } catch (e) {
    if (arch !== 'aarch64') throw e;
    log(`No Apple Silicon build of Java ${feature}, using the Intel one (runs through Rosetta).`);
    arch = 'x64';
    await download(url(arch), tarball, onProg);
  }
  log(`Unpacking Java ${feature}…`);
  const dest = path.join(managedRoot, String(feature));
  const tmp = dest + '.tmp';
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const r = await run('tar', ['-xzf', tarball, '-C', tmp]);
  fs.rmSync(tarball, { force: true });
  if (r.err) throw new Error(`Couldn't unpack Java: ${r.out}`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(tmp, dest);
  const bin = findJavaBin(dest);
  if (!bin) throw new Error('Java downloaded but bin/java was not found inside it.');
  cache = null;
  log(`Java ${feature} is ready.`);
  return bin;
}

async function ensure(major, log) {
  const found = await find(major);
  if (found) { log?.(`Using Java ${found.version} at ${found.path}`); return found.path; }
  return install(major, log);
}

module.exports = { listJavas, find, pick, install, ensure, versionOf, setManagedRoot };
