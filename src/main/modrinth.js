// Search and install plugins/mods from Modrinth (https://docs.modrinth.com/api/).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getJSON, download } = require('./net');

const API = 'https://api.modrinth.com/v2';
const SORTS = new Set(['relevance', 'downloads', 'follows', 'newest', 'updated']);

/** Modrinth loaders that run on each server software. */
function loadersFor(software) {
  return {
    paper: ['paper', 'spigot', 'bukkit'],
    purpur: ['purpur', 'paper', 'spigot', 'bukkit'],
    fabric: ['fabric'],
    forge: ['forge'],
    neoforge: ['neoforge'],
  }[software] || [];
}
const isPlugins = cfg => cfg.kind === 'plugins';
const noun = cfg => (isPlugins(cfg) ? 'plugin' : 'mod');
const folderOf = cfg => path.join(cfg.dir, isPlugins(cfg) ? 'plugins' : 'mods');

function facets(cfg) {
  const f = [loadersFor(cfg.software).map(l => `categories:${l}`), [`project_type:${noun(cfg)}`]];
  if (cfg.mcVersion) f.push([`versions:${cfg.mcVersion}`]);
  if (!isPlugins(cfg)) f.push(['server_side:required', 'server_side:optional']); // skip client-only mods
  return f;
}

async function search(cfg, { query = '', sort = 'relevance', offset = 0, limit = 20 } = {}) {
  const params = new URLSearchParams({
    query, facets: JSON.stringify(facets(cfg)), index: SORTS.has(sort) ? sort : 'relevance',
    offset: String(offset), limit: String(limit),
  });
  const r = await getJSON(`${API}/search?${params}`);
  return {
    total: r.total_hits || 0,
    hits: (r.hits || []).map(h => ({
      id: h.project_id, slug: h.slug, title: h.title, description: h.description, icon: h.icon_url || null,
      downloads: h.downloads || 0, author: h.author, categories: h.display_categories || h.categories || [],
    })),
  };
}

/** Newest compatible version that has a file; releases beat betas beat alphas. */
async function bestVersion(cfg, projectId) {
  const params = new URLSearchParams({ loaders: JSON.stringify(loadersFor(cfg.software)) });
  if (cfg.mcVersion) params.set('game_versions', JSON.stringify([cfg.mcVersion]));
  let versions;
  try { versions = await getJSON(`${API}/project/${encodeURIComponent(projectId)}/version?${params}`); } catch { versions = []; }
  const rank = { release: 0, beta: 1, alpha: 2 };
  const usable = (versions || []).filter(v => v.files?.length);
  usable.sort((a, b) => (rank[a.version_type] ?? 3) - (rank[b.version_type] ?? 3) || (Date.parse(b.date_published || 0) - Date.parse(a.date_published || 0)));
  return usable[0] || null;
}

async function projectTitle(projectId, fallback) {
  try { return (await getJSON(`${API}/project/${encodeURIComponent(projectId)}`)).title || fallback; } catch { return fallback; }
}

function sha512(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha512');
    fs.createReadStream(file).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * Install a project plus its required dependencies into plugins/ or mods/.
 * `installed` (projectId -> { file, versionId, version, title }) is updated in place.
 * Returns what was installed (or already up to date), root project first.
 */
async function install(cfg, projectId, { installed = {}, log = () => {}, depth = 0, seen = new Set() } = {}) {
  if (seen.has(projectId)) return [];
  seen.add(projectId);
  const v = await bestVersion(cfg, projectId);
  if (!v) {
    const msg = `No version of this ${noun(cfg)} supports ${cfg.software} ${cfg.mcVersion || ''}`.trim() + '.';
    if (depth === 0) throw new Error(msg);
    log(`Skipped a dependency (${projectId}): ${msg}`);
    return [];
  }
  const title = depth === 0 ? await projectTitle(projectId, v.name || projectId) : await projectTitle(projectId, projectId);
  if (depth > 0) log(`Installing required dependency ${title}…`);
  const file = v.files.find(f => f.primary) || v.files[0];
  const name = path.basename(file.filename);
  const folder = folderOf(cfg);
  fs.mkdirSync(folder, { recursive: true });
  const dest = path.join(folder, name);
  const prev = installed[projectId];
  const results = [];

  if (prev && prev.versionId === v.id && (fs.existsSync(dest) || fs.existsSync(dest + '.disabled'))) {
    log(`${title} is already up to date.`);
  } else {
    log(`Downloading ${name}…`);
    const tmp = path.join(folder, `.${name}.download`);
    try {
      await download(file.url, tmp);
      const want = file.hashes?.sha512;
      if (want && (await sha512(tmp)) !== want) throw new Error(`${name} failed its checksum check (the download was corrupted or tampered with), so it wasn’t installed.`);
      if (prev?.file && prev.file !== name) {
        for (const old of [prev.file, prev.file + '.disabled']) fs.rmSync(path.join(folder, path.basename(old)), { force: true });
      }
      fs.renameSync(tmp, dest);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  installed[projectId] = { file: name, versionId: v.id, version: v.version_number, title };
  results.push({ projectId, file: name, version: v.version_number, title });

  if (depth < 4) {
    for (const dep of v.dependencies || []) {
      if (dep.dependency_type !== 'required' || !dep.project_id) continue;
      if (installed[dep.project_id] && seen.has(dep.project_id)) continue;
      results.push(...await install(cfg, dep.project_id, { installed, log, depth: depth + 1, seen }));
    }
  }
  return results;
}

module.exports = { search, install, bestVersion, loadersFor, facets };
