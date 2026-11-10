const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args).catch(err => {
  // Strip Electron's "Error invoking remote method 'x': Error: " prefix so messages read nicely.
  throw new Error(String(err.message || err).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
});

const channels = [
  'app:info', 'settings:get', 'settings:set', 'software:list', 'software:versions',
  'servers:list', 'server:log', 'servers:create', 'servers:detect', 'servers:import', 'servers:update', 'servers:remove',
  'server:start', 'server:stop', 'server:kill', 'server:restart', 'server:command',
  'java:list', 'java:install',
  'files:list', 'files:read', 'files:write', 'files:mkdir', 'files:rename', 'files:trash', 'files:copyIn', 'files:reveal', 'files:open',
  'addons:list', 'addons:toggle', 'addons:add', 'addons:trash', 'addons:openFolder',
  'props:get', 'props:set', 'players:lists', 'port:check',
  'dialog:pickFolder', 'dialog:pickFiles', 'dialog:confirm', 'shell:external', 'clipboard:write',
  'access:get', 'access:set', 'access:upnpOpen', 'access:upnpClose', 'access:diagnose', 'access:test',
  'playit:state', 'playit:install', 'playit:start', 'playit:stop', 'playit:link', 'playit:cancelLink', 'playit:createTunnel', 'playit:logs',
  'backups:list', 'backups:create', 'backups:restore', 'backups:trash', 'backups:reveal',
  'modrinth:search', 'modrinth:install', 'modrinth:installed',
  'icon:get', 'icon:set', 'icon:remove', 'tray:set',
  'stats:get', 'stats:worldSize', 'stats:reset',
  'geyser:status', 'geyser:install', 'geyser:setEnabled', 'geyser:setPort', 'geyser:createTunnel',
  'worlds:saves', 'worlds:savesDir', 'worlds:accounts', 'worlds:lookup', 'worlds:list', 'worlds:importSave', 'worlds:setActive',
  'worlds:reset', 'worlds:trash', 'worlds:exportToSaves', 'worlds:openSaves',
  'server:changeVersion', 'modrinth:checkUpdates', 'modrinth:updateAll', 'webhook:test', 'logs:list', 'logs:read',
  'app:logError', 'app:openLogs', 'app:checkUpdate', 'app:openRelease', 'app:reportIssue',
];

const api = {};
for (const ch of channels) api[ch] = (...args) => call(ch, ...args);

api.on = (event, cb) => {
  const allowed = ['server:line', 'server:state', 'server:stats', 'task:progress', 'access:state', 'playit:state', 'backups:busy', 'app:select', 'server:metrics', 'bedrock:state', 'app:menu'];
  if (!allowed.includes(event)) throw new Error('Unknown event ' + event);
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(event, fn);
  return () => ipcRenderer.removeListener(event, fn);
};
api.pathForFile = file => webUtils.getPathForFile(file);

contextBridge.exposeInMainWorld('blockyard', api);
