// Bedrock crossplay: installs Geyser + Floodgate for the server's platform and keeps their config sane.
// Paper/Purpur: Geyser from Modrinth (version-matched), Floodgate-Spigot from GeyserMC's download API.
// Fabric/NeoForge: both from Modrinth (Floodgate-Modded), dependencies such as Fabric API included.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const modrinth = require('./modrinth');
const { getJSON, download } = require('./net');

const GEYSER_API = 'https://download.geysermc.org/v2/projects';
const SUPPORTED = new Set(['paper', 'purpur', 'fabric', 'neoforge']);
const DEFAULT_PORT = 19132;

const supported = cfg => SUPPORTED.has(cfg.software);
const isPluginServer = cfg => cfg.software === 'paper' || cfg.software === 'purpur';
const addonFolder = cfg => path.join(cfg.dir, isPluginServer(cfg) ? 'plugins' : 'mods');

function configPath(cfg) {
  if (isPluginServer(cfg)) return path.join(cfg.dir, 'plugins', 'Geyser-Spigot', 'config.yml');
  return path.join(cfg.dir, 'config', cfg.software === 'fabric' ? 'Geyser-Fabric' : 'Geyser-NeoForge', 'config.yml');
}

/** Which Geyser/Floodgate jars are present in plugins/ or mods/. */
function detect(cfg) {
  let files = [];
  try { files = fs.readdirSync(addonFolder(cfg)); } catch {}
  const enabled = f => /\.jar$/i.test(f);
  return {
    geyser: files.find(f => /^geyser/i.test(f) && enabled(f)) || null,
    floodgate: files.find(f => /^floodgate/i.test(f) && enabled(f)) || null,
  };
}

async function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

async function installFloodgateSpigot(cfg, log) {
  const meta = await getJSON(`${GEYSER_API}/floodgate/versions/latest/builds/latest`);
  const d = meta.downloads?.spigot;
  if (!d) throw new Error('GeyserMC’s download service has no Floodgate build for Spigot/Paper right now.');
  const folder = addonFolder(cfg);
  fs.mkdirSync(folder, { recursive: true });
  for (const f of fs.readdirSync(folder)) if (/^floodgate.*\.jar$/i.test(f)) fs.rmSync(path.join(folder, f), { force: true });
  const name = path.basename(d.name || 'floodgate-spigot.jar');
  const tmp = path.join(folder, `.${name}.download`);
  log(`Downloading ${name}…`);
  try {
    await download(`${GEYSER_API}/floodgate/versions/latest/builds/latest/downloads/spigot`, tmp);
    if (d.sha256 && (await sha256(tmp)) !== d.sha256) throw new Error('Floodgate failed its checksum check, so it wasn’t installed.');
    fs.renameSync(tmp, path.join(folder, name));
  } finally { fs.rmSync(tmp, { force: true }); }
  return name;
}

/**
 * Install Geyser + Floodgate. `installed` is the Modrinth install map (projectId -> info) for update tracking.
 * Returns { files, port }.
 */
async function install(cfg, { installed = {}, port = DEFAULT_PORT, log = () => {} } = {}) {
  if (!supported(cfg)) throw new Error('Bedrock crossplay needs Paper, Purpur, Fabric or NeoForge. Vanilla and Forge servers can’t load Geyser.');
  const files = [];
  log('Installing Geyser (lets Bedrock players connect)…');
  try {
    files.push(...(await modrinth.install(cfg, 'geyser', { installed, log })).map(r => r.file));
  } catch (e) {
    if (/No version/.test(e.message)) throw new Error(`Geyser doesn’t support ${cfg.software} ${cfg.mcVersion} (it follows recent Minecraft versions). Update the server's Minecraft version, then try again.`);
    throw e;
  }
  log('Installing Floodgate (Bedrock players don’t need a Java account)…');
  if (isPluginServer(cfg)) files.push(await installFloodgateSpigot(cfg, log));
  else files.push(...(await modrinth.install(cfg, 'floodgate', { installed, log })).map(r => r.file));
  applyConfig(cfg, { port });
  return { files: [...new Set(files)], port }; // Fabric API is shared by both
}

/** Disable by renaming jars to .disabled (keeps configs and linked accounts). */
function setEnabled(cfg, enabled) {
  const folder = addonFolder(cfg);
  let files = [];
  try { files = fs.readdirSync(folder); } catch {}
  for (const f of files) {
    if (!/^(geyser|floodgate)/i.test(f)) continue;
    if (enabled && /\.jar\.disabled$/i.test(f)) fs.renameSync(path.join(folder, f), path.join(folder, f.replace(/\.disabled$/i, '')));
    if (!enabled && /\.jar$/i.test(f)) fs.renameSync(path.join(folder, f), path.join(folder, f + '.disabled'));
  }
}

/**
 * Set a key inside a top-level YAML section without a YAML library (keeps comments and layout).
 * Only touches the first `key:` that is indented under `section:`.
 */
function setYamlKey(text, section, key, value) {
  const lines = text.split('\n');
  const start = lines.findIndex(l => new RegExp(`^${section}:\\s*(#.*)?$`).test(l));
  if (start < 0) return { text, changed: false };
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\S/.test(l) && !l.startsWith('#')) break; // next top-level key
    const m = l.match(new RegExp(`^(\\s+)${key}:\\s*([^#]*?)(\\s*#.*)?$`));
    if (m) {
      if (m[2].trim() === String(value)) return { text, changed: false };
      lines[i] = `${m[1]}${key}: ${value}${m[3] || ''}`;
      return { text: lines.join('\n'), changed: true };
    }
  }
  return { text, changed: false };
}

/**
 * Make Geyser listen on the chosen Bedrock port and authenticate through Floodgate.
 * Geyser only writes its config on first start; until then there's nothing to patch (defaults: 19132, and
 * recent Geyser switches to Floodgate auth by itself when Floodgate is installed).
 */
function applyConfig(cfg, { port = DEFAULT_PORT } = {}) {
  const file = configPath(cfg);
  if (!fs.existsSync(file)) return { exists: false, changed: false };
  let text = fs.readFileSync(file, 'utf8');
  let changed = false;
  const r1 = setYamlKey(text, 'bedrock', 'port', port); text = r1.text; changed ||= r1.changed;
  // auth-type lives under `remote:` (older configs) or `java:` (newer configs).
  for (const sec of ['remote', 'java']) {
    const r = setYamlKey(text, sec, 'auth-type', 'floodgate'); text = r.text; changed ||= r.changed;
  }
  if (changed) fs.writeFileSync(file, text);
  return { exists: true, changed };
}

function readPort(cfg) {
  try {
    const text = fs.readFileSync(configPath(cfg), 'utf8');
    const start = text.search(/^bedrock:/m);
    const m = start >= 0 && text.slice(start).match(/^\s+port:\s*(\d+)/m);
    return m ? parseInt(m[1], 10) : null;
  } catch { return null; }
}

// Console lines that tell us Geyser came up (or why it didn't).
const READY_RE = /Started Geyser on [^\s:]*:?(\d+)|Geyser.*listening on.*?:(\d+)/i;
const FAIL_RE = /\[Geyser[^\]]*\].*(Unable to bind|Failed to start|address already in use)/i;

module.exports = { install, detect, setEnabled, applyConfig, readPort, setYamlKey, configPath, supported, DEFAULT_PORT, READY_RE, FAIL_RE };
