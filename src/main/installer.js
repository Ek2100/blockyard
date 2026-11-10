// Creating new servers and detecting existing ones for import.
const fs = require('fs');
const path = require('path');
const providers = require('./providers');
const java = require('./java');
const files = require('./files');
const { readProps } = require('./server-instance');

const safeName = n => String(n).trim().replace(/[/\\:*?"<>|]/g, '').replace(/\s+/g, ' ').slice(0, 64) || 'Minecraft Server';

async function createServer(opts, log) {
  const { name, software, mcVersion, parentDir, port = 25565, memoryMB = 2048, eula } = opts;
  const sw = providers.SOFTWARE[software];
  if (!sw) throw new Error(`Unknown server software: ${software}`);
  if (!mcVersion) throw new Error('Pick a Minecraft version.');
  if (!eula) throw new Error('You need to accept the Minecraft EULA to run a server.');
  const dir = path.join(parentDir, safeName(name));
  const existed = fs.existsSync(dir);
  if (existed && fs.readdirSync(dir).filter(f => f !== '.DS_Store').length) {
    throw new Error(`"${dir}" already exists and has files in it. Pick a different name, or use Import for an existing server.`);
  }
  fs.mkdirSync(dir, { recursive: true });
  try {
    log(`Creating ${sw.label} ${mcVersion} server in ${dir}`, 0.02);
    const javaMajor = await providers.javaMajorFor(mcVersion);
    log(`Minecraft ${mcVersion} needs Java ${javaMajor}.`);
    let javaPath = null;
    const getJava = async () => (javaPath ||= await java.ensure(javaMajor, log));
    await getJava(); // get Java ready now so the first Start just works
    const { launchArgs } = await sw.install({ mcVersion, dir, log, getJava });

    fs.writeFileSync(path.join(dir, 'eula.txt'), `# Accepted in Blockyard on ${new Date().toISOString()}\n# https://aka.ms/MinecraftEULA\neula=true\n`);
    files.writeProperties(dir, { 'server-port': String(port), motd: `${safeName(name)} (Blockyard)` });
    log('All done! Press Start to launch your server.', 1);
    return {
      name: safeName(name), dir, software, kind: sw.kind, mcVersion, javaMajor, memoryMB, launchArgs, jvmArgs: '', javaPath: '',
    };
  } catch (e) {
    if (!existed) fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/** Look at a folder and guess what kind of server it is. */
function detect(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('That folder does not exist.');
  const entries = fs.readdirSync(dir);
  const has = p => fs.existsSync(path.join(dir, p));
  const jars = entries.filter(f => /\.jar$/i.test(f) && !/installer/i.test(f));
  const result = { dir, name: path.basename(dir), jars, software: 'vanilla', mcVersion: '', launchArgs: null, port: 25565, warnings: [] };

  const props = readProps(dir);
  if (props['server-port']) result.port = parseInt(props['server-port'], 10) || 25565;

  const libVersion = base => { try { return fs.readdirSync(path.join(dir, base)).sort(providers.compareVersions).pop(); } catch { return null; } };

  if (has('libraries/net/neoforged/neoforge')) {
    result.software = 'neoforge';
    const v = libVersion('libraries/net/neoforged/neoforge');
    if (v) result.mcVersion = providers.neoToMc(v);
  } else if (has('libraries/net/minecraftforge/forge') || jars.some(j => /^forge-/i.test(j))) {
    result.software = 'forge';
    const v = libVersion('libraries/net/minecraftforge/forge') || (jars.find(j => /^forge-/i.test(j)) || '').replace(/^forge-|\.jar$/gi, '');
    if (v) result.mcVersion = v.split('-')[0];
  } else if (has('.fabric') || jars.some(j => /fabric/i.test(j))) {
    result.software = 'fabric';
  } else if (has('purpur.yml') || jars.some(j => /purpur/i.test(j))) {
    result.software = 'purpur';
  } else if (has('config/paper-global.yml') || has('paper.yml') || jars.some(j => /paper/i.test(j))) {
    result.software = 'paper';
  } else if (has('spigot.yml') || has('bukkit.yml') || has('plugins')) {
    result.software = 'paper'; // Spigot/Bukkit: treat as a plugin server
  }

  if (result.software === 'forge' || result.software === 'neoforge') {
    try { result.launchArgs = providers.forgeLaunchArgs(dir); } catch (e) { result.warnings.push(e.message); }
  }
  if (!result.launchArgs) {
    const preferred = ['server.jar', 'fabric-server.jar', 'fabric-server-launch.jar', 'paper.jar', 'purpur.jar', 'spigot.jar', 'minecraft_server.jar'];
    const jar = preferred.find(p => jars.includes(p))
      || jars.find(j => /paper|purpur|spigot|fabric|server|minecraft/i.test(j) && !/^(libraries|cache)/.test(j))
      || [...jars].sort((a, b) => fs.statSync(path.join(dir, b)).size - fs.statSync(path.join(dir, a)).size)[0];
    if (jar) result.launchArgs = ['-jar', jar];
    else result.warnings.push("No server .jar found in this folder. You can set the launch command in Settings after importing.");
  }

  // Minecraft version hints.
  if (!result.mcVersion) {
    try {
      const vh = JSON.parse(fs.readFileSync(path.join(dir, 'version_history.json'), 'utf8'));
      const m = String(vh.currentVersion || '').match(/MC: ([\d.]+)/);
      if (m) result.mcVersion = m[1];
    } catch {}
  }
  if (!result.mcVersion) {
    const jar = result.launchArgs?.[1] || '';
    const m = jar.match(/(\d+\.\d+(?:\.\d+)?)/);
    if (m) result.mcVersion = m[1];
  }
  if (!result.mcVersion) {
    for (const d of ['versions', 'cache']) {
      try { const v = fs.readdirSync(path.join(dir, d)).find(f => /^\d+\.\d+/.test(f)); if (v) { result.mcVersion = v.match(/^[\d.]+\d/)[0]; break; } } catch {}
    }
  }
  if (!has('server.properties') && !has('world') && !jars.length) result.warnings.push("This doesn't look like a Minecraft server folder.");
  result.kind = providers.SOFTWARE[result.software].kind;
  return result;
}

module.exports = { createServer, detect, safeName };
