// Worlds: read singleplayer saves, copy them into servers (with the owner's inventory/position),
// copy server worlds back to singleplayer, and list/switch server worlds. Originals are never modified.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const nbt = require('./nbt');
const { getJSON } = require('./net');
const { readProps } = require('./server-instance');

const minecraftDir = () => (process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', 'minecraft')
  : path.join(os.homedir(), '.minecraft'));
const defaultSavesDir = () => path.join(minecraftDir(), 'saves');

const GAMEMODES = ['survival', 'creative', 'adventure', 'spectator'];
const DIFFICULTIES = ['peaceful', 'easy', 'normal', 'hard'];

/** Read the interesting bits of a world's level.dat. */
function readLevel(worldDir) {
  const file = path.join(worldDir, 'level.dat');
  const { root } = nbt.parse(fs.readFileSync(file));
  const D = (...k) => nbt.get(root, 'Data', ...k);
  const brands = D('ServerBrands')?.items || [];
  const gameType = D('GameType');
  const difficulty = D('Difficulty') ?? D('difficulty_settings', 'difficulty');
  return {
    name: D('LevelName') || path.basename(worldDir),
    version: D('Version', 'Name') || null,
    dataVersion: D('DataVersion') ?? D('Version', 'Id') ?? null,
    lastPlayed: D('LastPlayed') != null ? Number(D('LastPlayed')) : null,
    gameMode: typeof gameType === 'number' ? GAMEMODES[gameType] || 'survival' : null,
    difficulty: typeof difficulty === 'number' ? DIFFICULTIES[difficulty] || 'normal' : (typeof difficulty === 'string' ? difficulty : null),
    hardcore: !!D('hardcore'),
    cheats: !!D('allowCommands'),
    brands,
    modded: !!D('WasModded') || brands.some(b => !/^vanilla$/i.test(b)),
    hasPlayer: !!D('Player'),
  };
}

function dirSize(dir) {
  return new Promise(resolve => {
    execFile('du', ['-sk', dir], { timeout: 20000 }, (err, out) => resolve(err ? null : parseInt(String(out), 10) * 1024));
  });
}

/** Singleplayer worlds in a saves folder, newest first. */
function listSaves(savesDir = defaultSavesDir()) {
  let entries = [];
  try { entries = fs.readdirSync(savesDir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(savesDir, e.name);
    if (!fs.existsSync(path.join(dir, 'level.dat'))) continue;
    try {
      out.push({ dir, folder: e.name, ...readLevel(dir), icon: fs.existsSync(path.join(dir, 'icon.png')) ? path.join(dir, 'icon.png') : null });
    } catch (err) {
      out.push({ dir, folder: e.name, name: e.name, error: `Couldn't read level.dat (${err.message})` });
    }
  }
  return out.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
}

/** Minecraft accounts signed in to the official launcher on this Mac. */
function launcherAccounts(mcDir = minecraftDir()) {
  const found = new Map();
  for (const f of ['launcher_accounts_microsoft_store.json', 'launcher_accounts.json']) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(mcDir, f), 'utf8'));
      for (const a of Object.values(j.accounts || {})) {
        const p = a.minecraftProfile;
        if (p?.id && p?.name) found.set(p.id, { uuid: nbt.dashUuid(p.id), name: p.name });
      }
    } catch {}
  }
  return [...found.values()];
}

/** Look up a Java username's UUID (Mojang API). */
async function lookupPlayer(name) {
  const clean = String(name || '').trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(clean)) throw new Error('That isn’t a valid Minecraft username (3–16 letters, numbers or _).');
  let r;
  try { r = await getJSON(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(clean)}`); } catch (e) {
    if (/HTTP (204|404)/.test(e.message)) throw new Error(`No Minecraft account is called "${clean}".`);
    throw e;
  }
  if (!r?.id) throw new Error(`No Minecraft account is called "${clean}".`);
  return { uuid: nbt.dashUuid(r.id), name: r.name };
}

const skipLock = src => path.basename(src) !== 'session.lock';

/**
 * Copy a singleplayer world into a server folder as `targetName` (default "world").
 * The owner's singleplayer data (stored in level.dat) becomes playerdata/<uuid>.dat so they keep
 * their inventory and position. Returns the world info plus what was done.
 */
function copySaveToServer({ worldDir, serverDir, targetName = 'world', player = null, makeOp = false }) {
  if (!/^[\w .-]+$/.test(targetName)) throw new Error('World folder names can only use letters, numbers, spaces, dots, dashes and underscores.');
  const info = readLevel(worldDir);
  const dest = path.join(serverDir, targetName);
  if (fs.existsSync(dest)) throw new Error(`This server already has a world called "${targetName}". Pick another name.`);
  fs.mkdirSync(serverDir, { recursive: true });
  fs.cpSync(worldDir, dest, { recursive: true, filter: skipLock });
  const done = { info, dest, playerMoved: false, opped: false };

  if (player?.uuid) {
    const { root } = nbt.parse(fs.readFileSync(path.join(dest, 'level.dat')));
    const p = nbt.get(root, 'Data', 'Player');
    const target = path.join(dest, 'playerdata', `${player.uuid}.dat`);
    if (p && !fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, nbt.write({ name: '', root: p }));
      done.playerMoved = true;
    }
    if (makeOp) { addOp(serverDir, player); done.opped = true; }
  }
  return done;
}

function addOp(serverDir, player) {
  const file = path.join(serverDir, 'ops.json');
  let ops = [];
  try { ops = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (!ops.some(o => o.uuid === player.uuid)) ops.push({ uuid: player.uuid, name: player.name, level: 4, bypassesPlayerLimit: false });
  fs.writeFileSync(file, JSON.stringify(ops, null, 2));
}

/** server.properties values that make the server play like the singleplayer world did. */
function propsForWorld(info, levelName = 'world') {
  const p = { 'level-name': levelName };
  if (info.gameMode) p.gamemode = info.gameMode === 'spectator' ? 'survival' : info.gameMode;
  if (info.difficulty) p.difficulty = info.difficulty;
  p.hardcore = String(!!info.hardcore);
  return p;
}

/** Worlds inside a server folder. Paper keeps the Nether/End in "<name>_nether"/"<name>_the_end". */
function listServerWorlds(serverDir) {
  const active = readProps(serverDir)['level-name'] || 'world';
  let entries = [];
  try { entries = fs.readdirSync(serverDir, { withFileTypes: true }); } catch { return { active, worlds: [] }; }
  const names = entries.filter(e => e.isDirectory() && fs.existsSync(path.join(serverDir, e.name, 'level.dat'))).map(e => e.name);
  const mains = names.filter(n => !(/_(nether|the_end)$/.test(n) && names.includes(n.replace(/_(nether|the_end)$/, ''))));
  const worlds = mains.map(n => {
    let info = {};
    try { info = readLevel(path.join(serverDir, n)); } catch (e) { info = { error: e.message }; }
    const dims = ['_nether', '_the_end'].filter(sfx => names.includes(n + sfx)).map(sfx => n + sfx);
    return { folder: n, active: n === active, dims, ...info };
  });
  if (!worlds.some(w => w.active)) worlds.unshift({ folder: active, active: true, dims: [], missing: true });
  return { active, worlds };
}

/** Copy a server world back into the singleplayer saves folder (merging Paper's split dimensions). */
function copyServerWorldToSaves({ serverDir, folder, savesDir = defaultSavesDir(), newName, player = null }) {
  const src = path.join(serverDir, folder);
  if (!fs.existsSync(path.join(src, 'level.dat'))) throw new Error(`"${folder}" isn't a world.`);
  fs.mkdirSync(savesDir, { recursive: true });
  const base = (newName || `${folder} (from server)`).replace(/[/\\:]/g, '-').trim();
  let destName = base;
  for (let n = 2; fs.existsSync(path.join(savesDir, destName)); n++) destName = `${base} (${n})`;
  const dest = path.join(savesDir, destName);
  fs.cpSync(src, dest, { recursive: true, filter: skipLock });
  // Paper/Spigot: world_nether/DIM-1 and world_the_end/DIM1 belong inside the singleplayer folder.
  for (const [sfx, dim] of [['_nether', 'DIM-1'], ['_the_end', 'DIM1']]) {
    const d = path.join(serverDir, folder + sfx, dim);
    if (fs.existsSync(d) && !fs.existsSync(path.join(dest, dim))) fs.cpSync(d, path.join(dest, dim), { recursive: true, filter: skipLock });
  }
  for (const f of ['uid.dat', 'paper-world.yml']) fs.rmSync(path.join(dest, f), { force: true });
  // Rename the world, and hand the chosen player's server inventory to the singleplayer slot.
  const levelFile = path.join(dest, 'level.dat');
  const parsed = nbt.parse(fs.readFileSync(levelFile));
  const data = parsed.root.get('Data')?.value;
  if (data) {
    data.set('LevelName', { type: nbt.T.String, value: destName });
    if (player?.uuid) {
      const pf = path.join(src, 'playerdata', `${player.uuid}.dat`);
      if (fs.existsSync(pf)) data.set('Player', { type: nbt.T.Compound, value: nbt.parse(fs.readFileSync(pf)).root });
    }
    fs.writeFileSync(levelFile, nbt.write(parsed));
  }
  return { dest, name: destName };
}

module.exports = {
  minecraftDir, defaultSavesDir, readLevel, listSaves, launcherAccounts, lookupPlayer, copySaveToServer,
  propsForWorld, addOp, listServerWorlds, copyServerWorldToSaves, dirSize,
};
