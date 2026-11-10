// Server software catalogue: how to list versions and install each one.
// Every install() returns { launchArgs } — the args that go after the JVM memory flags.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getJSON, getText, download } = require('./net');

// ---------- version helpers ----------
function parts(v) {
  return String(v).split(/[-+]/)[0].split('.').map(n => parseInt(n, 10) || 0);
}
function compareVersions(a, b) {
  const pa = parts(a), pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}
const isRelease = v => /^\d+(\.\d+)+$/.test(v);
const sortDesc = list => [...new Set(list)].sort((a, b) => compareVersions(b, a));

// ---------- Mojang ----------
const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
let manifestCache = null;
async function mojangManifest() {
  if (!manifestCache || Date.now() - manifestCache.at > 10 * 60e3) {
    manifestCache = { at: Date.now(), data: await getJSON(MANIFEST) };
  }
  return manifestCache.data;
}
async function mojangVersion(mc) {
  const m = await mojangManifest();
  const entry = m.versions.find(v => v.id === mc);
  if (!entry) throw new Error(`Minecraft ${mc} isn't in Mojang's version list.`);
  return getJSON(entry.url);
}

/** Best guess when Mojang can't be asked (offline / unusual version). */
function guessJavaMajor(mc) {
  const [a, b = 0, c = 0] = parts(mc);
  if (a >= 26) return 25;
  if (a === 1 && (b > 20 || (b === 20 && c >= 5))) return 21;
  if (a === 1 && b >= 18) return 17;
  if (a === 1 && b === 17) return 16;
  return 8;
}
async function javaMajorFor(mc) {
  try {
    const info = await mojangVersion(mc);
    return info.javaVersion?.majorVersion || 8;
  } catch {
    return guessJavaMajor(mc);
  }
}

// ---------- helpers for installers ----------
function runJava(javaPath, args, cwd, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn(javaPath, args, { cwd });
    let buf = '';
    const feed = d => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
    };
    p.stdout.on('data', feed);
    p.stderr.on('data', feed);
    p.on('error', reject);
    p.on('exit', code => (code === 0 ? resolve() : reject(new Error(`The installer exited with code ${code}. See the log above.`))));
  });
}

/** Work out how to launch a Forge/NeoForge server after its installer ran. */
function forgeLaunchArgs(dir) {
  const runSh = path.join(dir, 'run.sh');
  if (fs.existsSync(runSh)) {
    for (const raw of fs.readFileSync(runSh, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const tokens = line.split(/\s+/).map(t => t.replace(/^["']|["']$/g, ''));
      const j = tokens.findIndex(t => t === 'java' || /\/java$/.test(t) || /^\$\{?JAVA/.test(t));
      if (j < 0) continue;
      const rest = tokens.slice(j + 1).filter(t => t !== '$@' && t !== '@user_jvm_args.txt' && t !== 'nogui');
      if (rest.length) return rest;
    }
  }
  // Fallbacks: look for an args file or a forge jar.
  for (const base of ['libraries/net/neoforged/neoforge', 'libraries/net/minecraftforge/forge']) {
    const root = path.join(dir, base);
    if (!fs.existsSync(root)) continue;
    for (const v of fs.readdirSync(root)) {
      const f = path.join(base, v, 'unix_args.txt');
      if (fs.existsSync(path.join(dir, f))) return ['@' + f];
    }
  }
  const jar = fs.readdirSync(dir).find(f => /^(forge|neoforge)-.*\.jar$/i.test(f) && !/installer/i.test(f));
  if (jar) return ['-jar', jar];
  throw new Error("The installer finished but I couldn't find how to launch the server (no run.sh).");
}

async function runInstaller({ url, fileName, dir, log, getJava }) {
  const dest = path.join(dir, fileName);
  log(`Downloading ${fileName}…`);
  await download(url, dest, progressLogger(log, fileName));
  const javaPath = await getJava();
  log('Running the installer (this can take a few minutes)…');
  await runJava(javaPath, ['-jar', fileName, '--installServer'], dir, line => log(line, null, true));
  for (const f of fs.readdirSync(dir)) {
    if (/installer\.jar(\.log)?$/i.test(f) || f === 'installer.log') fs.rmSync(path.join(dir, f), { force: true });
  }
  return { launchArgs: forgeLaunchArgs(dir) };
}

function progressLogger(log, label) {
  return (got, total) => {
    const mb = (got / 1048576).toFixed(1);
    if (total) log(`Downloading ${label}… ${mb} / ${(total / 1048576).toFixed(1)} MB`, got / total);
    else log(`Downloading ${label}… ${mb} MB`);
  };
}

async function simpleJar({ url, dir, log, name = 'server.jar' }) {
  await download(url, path.join(dir, name), progressLogger(log, name));
  return { launchArgs: ['-jar', name] };
}

// ---------- NeoForge version mapping ----------
// <26: 21.1.77 -> 1.21.1, 21.0.5 -> 1.21 ; >=26: 26.1.2.76 -> 26.1.2, 26.1.0.19-beta -> 26.1
function neoToMc(v) {
  const p = parts(v);
  if (p[0] >= 26) return p[2] ? `${p[0]}.${p[1]}.${p[2]}` : `${p[0]}.${p[1]}`;
  return p[1] ? `1.${p[0]}.${p[1]}` : `1.${p[0]}`;
}
let neoCache = null;
async function neoVersions() {
  if (!neoCache) {
    const xml = await getText('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');
    const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map(m => m[1]).filter(v => !/snapshot|alpha|\+/i.test(v));
    const byMc = new Map();
    for (const v of all) {
      const mc = neoToMc(v);
      const cur = byMc.get(mc);
      const stable = !/beta/i.test(v);
      // Prefer the newest stable build; fall back to the newest beta if that's all there is.
      if (!cur || (stable && !cur.stable) || (stable === cur.stable && compareVersions(v, cur.v) > 0)) byMc.set(mc, { v, stable });
    }
    neoCache = byMc;
  }
  return neoCache;
}

let forgeCache = null;
async function forgePromos() {
  if (!forgeCache) forgeCache = (await getJSON('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json')).promos;
  return forgeCache;
}

// ---------- the catalogue ----------
const SOFTWARE = {
  paper: {
    label: 'Paper', kind: 'plugins', blurb: 'Fast and stable, runs Bukkit/Spigot plugins. Best pick for most servers.',
    async versions() {
      const d = await getJSON('https://fill.papermc.io/v3/projects/paper');
      return sortDesc(Object.values(d.versions).flat().filter(isRelease));
    },
    async install({ mcVersion, dir, log }) {
      const builds = await getJSON(`https://fill.papermc.io/v3/projects/paper/versions/${mcVersion}/builds`);
      const sorted = [...builds].sort((a, b) => b.id - a.id);
      const build = sorted.find(b => b.channel === 'STABLE' || b.channel === 'RECOMMENDED') || sorted[0];
      if (!build) throw new Error(`Paper has no builds for ${mcVersion} yet.`);
      log(`Using Paper build #${build.id} (${String(build.channel).toLowerCase()})`);
      return simpleJar({ url: build.downloads['server:default'].url, dir, log });
    },
  },
  purpur: {
    label: 'Purpur', kind: 'plugins', blurb: 'Paper with extra gameplay and config options. Runs plugins.',
    async versions() {
      return sortDesc((await getJSON('https://api.purpurmc.org/v2/purpur')).versions.filter(isRelease));
    },
    install: ({ mcVersion, dir, log }) => simpleJar({ url: `https://api.purpurmc.org/v2/purpur/${mcVersion}/latest/download`, dir, log }),
  },
  vanilla: {
    label: 'Vanilla', kind: 'none', blurb: 'The official Mojang server. No plugins or mods.',
    async versions() {
      return (await mojangManifest()).versions.filter(v => v.type === 'release').map(v => v.id);
    },
    async install({ mcVersion, dir, log }) {
      const info = await mojangVersion(mcVersion);
      if (!info.downloads?.server?.url) throw new Error(`Mojang doesn't provide a server for ${mcVersion}.`);
      return simpleJar({ url: info.downloads.server.url, dir, log });
    },
  },
  fabric: {
    label: 'Fabric', kind: 'mods', blurb: 'Lightweight mod loader. Great for performance and modern mods.',
    async versions() {
      return (await getJSON('https://meta.fabricmc.net/v2/versions/game')).filter(v => v.stable).map(v => v.version);
    },
    async install({ mcVersion, dir, log }) {
      const loaders = await getJSON(`https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`);
      const loader = (loaders.find(l => l.loader?.stable) || loaders[0])?.loader?.version;
      if (!loader) throw new Error(`Fabric doesn't support ${mcVersion} yet.`);
      const installers = await getJSON('https://meta.fabricmc.net/v2/versions/installer');
      const inst = (installers.find(i => i.stable) || installers[0]).version;
      log(`Using Fabric loader ${loader}, installer ${inst}`);
      return simpleJar({ url: `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loader}/${inst}/server/jar`, dir, log, name: 'fabric-server.jar' });
    },
  },
  forge: {
    label: 'Forge', kind: 'mods', blurb: 'The classic mod loader. Needed for many older modpacks.',
    async versions() {
      const promos = await forgePromos();
      return sortDesc(Object.keys(promos).map(k => k.replace(/-(latest|recommended)$/, '')))
        .filter(v => isRelease(v) && compareVersions(v, '1.12') >= 0);
    },
    async install({ mcVersion, dir, log, getJava }) {
      const promos = await forgePromos();
      const fv = promos[`${mcVersion}-recommended`] || promos[`${mcVersion}-latest`];
      if (!fv) throw new Error(`No Forge build for ${mcVersion}.`);
      const full = `${mcVersion}-${fv}`;
      log(`Using Forge ${full}`);
      return runInstaller({ url: `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`, fileName: `forge-${full}-installer.jar`, dir, log, getJava });
    },
  },
  neoforge: {
    label: 'NeoForge', kind: 'mods', blurb: 'Modern fork of Forge. Most new big modpacks use it.',
    async versions() {
      return sortDesc([...(await neoVersions()).keys()]);
    },
    async install({ mcVersion, dir, log, getJava }) {
      const pick = (await neoVersions()).get(mcVersion);
      if (!pick) throw new Error(`No NeoForge build for ${mcVersion}.`);
      log(`Using NeoForge ${pick.v}${pick.stable ? '' : ' (beta, no stable build exists yet)'}`);
      return runInstaller({ url: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${pick.v}/neoforge-${pick.v}-installer.jar`, fileName: `neoforge-${pick.v}-installer.jar`, dir, log, getJava });
    },
  },
};

function catalogue() {
  return Object.entries(SOFTWARE).map(([id, s]) => ({ id, label: s.label, kind: s.kind, blurb: s.blurb }));
}

module.exports = { SOFTWARE, catalogue, compareVersions, javaMajorFor, guessJavaMajor, neoToMc, forgeLaunchArgs, mojangVersion, _reset: () => { manifestCache = neoCache = forgeCache = null; } };
