// File browser + server.properties + player list files. Every path is confined to the server folder.
const fs = require('fs');
const path = require('path');

function safe(root, rel = '') {
  const r = path.resolve(root);
  const p = path.resolve(r, rel);
  if (p !== r && !p.startsWith(r + path.sep)) throw new Error('That path is outside the server folder.');
  return p;
}

const TEXT_EXT = new Set(['.txt', '.properties', '.yml', '.yaml', '.json', '.json5', '.toml', '.cfg', '.conf', '.ini', '.log', '.md', '.sh', '.mcmeta', '.csv', '.xml', '.js', '.lang', '.snbt', '.secret']);
function isText(name) {
  const ext = path.extname(name).toLowerCase();
  return TEXT_EXT.has(ext) || name === 'eula.txt' || !ext && !name.startsWith('.');
}

function list(root, rel = '') {
  const dir = safe(root, rel);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.name !== '.DS_Store')
    .map(e => {
      let st = null;
      try { st = fs.statSync(path.join(dir, e.name)); } catch {}
      const isDir = st ? st.isDirectory() : e.isDirectory();
      return { name: e.name, dir: isDir, size: st && !isDir ? st.size : null, mtime: st ? st.mtimeMs : null, text: !isDir && isText(e.name) };
    })
    .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

function readText(root, rel) {
  const p = safe(root, rel);
  const st = fs.statSync(p);
  if (st.size > 4 * 1024 * 1024) throw new Error('That file is over 4 MB, too big to edit here. Open it in Finder instead.');
  return fs.readFileSync(p, 'utf8');
}
function writeText(root, rel, content) { fs.writeFileSync(safe(root, rel), content); }
function mkdir(root, rel) { fs.mkdirSync(safe(root, rel), { recursive: true }); }

function rename(root, rel, newName) {
  if (!newName || /[/\\]/.test(newName)) throw new Error('Names can’t contain slashes.');
  const from = safe(root, rel);
  const to = safe(root, path.join(path.dirname(rel), newName));
  if (fs.existsSync(to)) throw new Error(`"${newName}" already exists.`);
  fs.renameSync(from, to);
}

function copyIn(root, destRel, sources) {
  const dest = safe(root, destRel);
  const copied = [];
  for (const src of sources) {
    let target = path.join(dest, path.basename(src));
    if (path.resolve(src) === path.resolve(target)) continue;
    let n = 2;
    while (fs.existsSync(target)) {
      const ext = path.extname(src);
      target = path.join(dest, `${path.basename(src, ext)} ${n++}${ext}`);
    }
    fs.cpSync(src, target, { recursive: true });
    copied.push(path.basename(target));
  }
  return copied;
}

// ---------- plugins / mods ----------
function addonsDir(cfg) { return cfg.kind === 'plugins' ? 'plugins' : 'mods'; }
function listAddons(cfg) {
  const rel = addonsDir(cfg);
  const dir = safe(cfg.dir, rel);
  if (!fs.existsSync(dir)) return { folder: rel, items: [] };
  const items = fs.readdirSync(dir)
    .filter(f => /\.jar(\.disabled)?$/i.test(f))
    .map(f => ({ file: f, name: f.replace(/\.disabled$/i, '').replace(/\.jar$/i, ''), enabled: !/\.disabled$/i.test(f), size: fs.statSync(path.join(dir, f)).size }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return { folder: rel, items };
}
function toggleAddon(cfg, file, enabled) {
  const rel = addonsDir(cfg);
  const from = safe(cfg.dir, path.join(rel, file));
  const base = file.replace(/\.disabled$/i, '');
  const to = safe(cfg.dir, path.join(rel, enabled ? base : base + '.disabled'));
  if (from !== to) fs.renameSync(from, to);
}
function addAddons(cfg, sources) {
  const rel = addonsDir(cfg);
  fs.mkdirSync(safe(cfg.dir, rel), { recursive: true });
  return copyIn(cfg.dir, rel, sources.filter(s => /\.jar$/i.test(s)));
}

// ---------- server.properties ----------
function readProperties(dir) {
  const p = path.join(dir, 'server.properties');
  if (!fs.existsSync(p)) return { exists: false, values: {} };
  const values = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([^#!=:\s][^=:]*?)\s*[=:]\s*(.*)$/);
    if (m) values[m[1]] = unescapeProp(m[2]);
  }
  return { exists: true, values };
}
const unescapeProp = v => v.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\(.)/g, '$1');
const escapeProp = v => String(v).replace(/\\/g, '\\\\').replace(/[:=]/g, m => '\\' + m).replace(/[^\x20-\x7e]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

function writeProperties(dir, updates) {
  const p = path.join(dir, 'server.properties');
  const lines = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split(/\r?\n/) : ['#Minecraft server properties'];
  const pending = { ...updates };
  const out = lines.map(line => {
    const m = line.match(/^\s*([^#!=:\s][^=:]*?)\s*[=:]/);
    if (m && m[1] in pending) { const v = pending[m[1]]; delete pending[m[1]]; return `${m[1]}=${escapeProp(v)}`; }
    return line;
  });
  while (out.length && out[out.length - 1] === '') out.pop();
  for (const [k, v] of Object.entries(pending)) out.push(`${k}=${escapeProp(v)}`);
  fs.writeFileSync(p, out.join('\n') + '\n');
}

// ---------- ops / whitelist / bans ----------
function readJson(dir, name) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { return []; }
}
function playerLists(dir) {
  return {
    ops: readJson(dir, 'ops.json').map(o => o.name),
    whitelist: readJson(dir, 'whitelist.json').map(o => o.name),
    banned: readJson(dir, 'banned-players.json').map(o => o.name),
  };
}

module.exports = { safe, list, readText, writeText, mkdir, rename, copyIn, listAddons, toggleAddon, addAddons, addonsDir, readProperties, writeProperties, playerLists };
