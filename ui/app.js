/* Blockyard renderer: plain DOM, no framework. */
const api = window.blockyard;
const call = (ch, ...a) => api[ch](...a);

// ---------- tiny DOM helper ----------
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') Object.assign(el.style, v);
      else if (k === 'value') el.value = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const $ = (s, el = document) => el.querySelector(s);
const clear = el => { while (el.firstChild) el.firstChild.remove(); return el; };
// append that skips false/null/0 from `cond && el` patterns
const put = (el, ...kids) => el.append(...kids.flat(Infinity).filter(k => k != null && k !== false && k !== 0 && k !== ''));

// ---------- formatting ----------
const fmtMem = mb => (mb >= 1024 ? `${+(mb / 1024).toFixed(mb % 1024 ? 1 : 0)} GB` : `${mb} MB`);
function fmtBytes(b) {
  if (b == null) return '';
  if (b < 1024) return `${b} B`;
  const u = ['KB', 'MB', 'GB']; let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
  return `${b.toFixed(b < 10 ? 1 : 0)} ${u[i]}`;
}
function fmtDur(ms) {
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), hh = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60;
  if (d) return `${d}d ${hh}h`;
  if (hh) return `${hh}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
const fmtDate = t => (t ? new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const STATE_LABEL = { stopped: 'Offline', starting: 'Starting…', online: 'Online', stopping: 'Stopping…', sleeping: 'Sleeping' };

// ---------- platform wording ----------
const IS_MAC = navigator.userAgent.includes('Macintosh');
const IS_WIN = navigator.userAgent.includes('Windows');
const THIS_PC = IS_MAC ? 'this Mac' : IS_WIN ? 'this PC' : 'this computer';
const YOUR_PC = IS_MAC ? 'Your Mac' : IS_WIN ? 'Your PC' : 'Your computer';
const FILE_MGR = IS_MAC ? 'Finder' : IS_WIN ? 'File Explorer' : 'your file manager';
const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl+';

// ---------- app state ----------
const S = {
  info: null, software: [], servers: [], selected: null, tab: 'console',
  logs: new Map(), history: new Map(), cwd: new Map(), props: new Map(), javas: null,
};
const server = id => S.servers.find(s => s.id === id);
const current = () => server(S.selected);
const swInfo = id => S.software.find(s => s.id === id) || { label: id, kind: 'none' };
const isRunning = s => s && !['stopped', 'sleeping'].includes(s.snapshot.state);

// ---------- toasts & modals ----------
function toast(msg, type = 'ok') {
  const t = h('div', { class: `toast ${type}`, text: msg });
  $('#toasts').append(t);
  setTimeout(() => t.remove(), type === 'error' ? 7000 : 3500);
}
const guard = fn => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message, 'error'); } };

function modal({ title, subtitle, body, foot, size = '', dismissable = () => true }) {
  const root = $('#modal-root');
  const box = h('div', { class: `modal ${size}` },
    h('div', { class: 'modal-head' }, h('h2', { text: title }), subtitle && h('p', { text: subtitle })),
    h('div', { class: 'modal-body' }, body),
    foot && h('div', { class: 'modal-foot' }, foot));
  const bd = h('div', { class: 'backdrop', onmousedown: e => { if (e.target === bd && dismissable()) close(); } }, box);
  const onKey = e => { if (e.key === 'Escape' && dismissable()) close(); };
  function close() { bd.remove(); document.removeEventListener('keydown', onKey); syncModalClass(); }
  document.addEventListener('keydown', onKey);
  root.append(bd);
  syncModalClass();
  return { close, box };
}

const syncModalClass = () => document.body.classList.toggle('modal-open', !!document.querySelector('#modal-root .backdrop'));

function promptModal({ title, label, placeholder = '', value = '', okLabel = 'OK' }) {
  return new Promise(resolve => {
    const input = h('input', { type: 'text', placeholder, value, style: { width: '100%' } });
    const done = v => { m.close(); resolve(v); };
    const m = modal({
      title, size: 'small',
      body: h('div', { class: 'field' }, label && h('label', { text: label }), input),
      foot: [h('button', { class: 'btn', text: 'Cancel', onclick: () => done(null) }),
        h('button', { class: 'btn primary', text: okLabel, onclick: () => done(input.value) })],
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') done(input.value); });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}
const confirmBox = (message, detail, buttons = ['OK', 'Cancel'], danger = false) => call('dialog:confirm', { message, detail, buttons, danger });

function popover(anchor, content) {
  document.querySelectorAll('.popover').forEach(p => p.remove());
  const r = anchor.getBoundingClientRect();
  const p = h('div', { class: 'popover' }, content);
  document.body.append(p);
  const left = Math.min(window.innerWidth - p.offsetWidth - 12, Math.max(12, r.left + r.width / 2 - p.offsetWidth / 2));
  Object.assign(p.style, { top: `${r.bottom + 8}px`, left: `${left}px` });
  const off = e => { if (!p.contains(e.target) && e.target !== anchor) { p.remove(); document.removeEventListener('mousedown', off); } };
  setTimeout(() => document.addEventListener('mousedown', off), 0);
}

// ---------- data ----------
async function loadServers() { S.servers = await call('servers:list'); }
async function loadProps(id) {
  try { S.props.set(id, await call('props:get', id)); } catch { S.props.set(id, { exists: false, values: {} }); }
  return S.props.get(id);
}
const portOf = id => S.props.get(id)?.values?.['server-port'] || '25565';

// ---------- sidebar ----------
function swIcon(id, lg) {
  return h('div', { class: `sw-icon sw-${id}${lg ? ' lg' : ''}`, text: swInfo(id).label[0] });
}
function renderSidebar() {
  const list = clear($('#server-list'));
  if (!S.servers.length) list.append(h('div', { class: 'muted', style: { padding: '6px 8px', fontSize: '12px' }, text: 'No servers yet.' }));
  for (const s of S.servers) {
    list.append(h('div', { class: `srv${s.id === S.selected ? ' active' : ''}`, onclick: () => select(s.id) },
      swIcon(s.software),
      h('div', { class: 'meta' }, h('div', { class: 'name', text: s.name }),
        h('div', { class: 'sub', text: `${swInfo(s.software).label}${s.mcVersion ? ' ' + s.mcVersion : ''}${s.snapshot.state === 'online' ? ` · ${s.snapshot.players.length} online` : ''}` })),
      h('span', { class: `dot ${s.snapshot.state}`, title: STATE_LABEL[s.snapshot.state] })));
  }
}

// ---------- main view ----------
const TABS = [
  ['console', 'Console'], ['players', 'Players'], ['stats', 'Stats'], ['files', 'Files'], ['addons', 'Plugins'], ['worlds', 'Worlds'], ['access', 'Public Access'], ['backups', 'Backups'], ['properties', 'Properties'], ['settings', 'Settings'],
];

async function select(id) {
  S.selected = id;
  if (!S.logs.has(id)) S.logs.set(id, await call('server:log', id));
  await Promise.all([loadProps(id), loadAccess(id)]);
  renderSidebar();
  renderMain();
}

function renderMain() {
  const main = clear($('#main'));
  const s = current();
  if (!s) return renderWelcome(main);
  const kind = s.kind || swInfo(s.software).kind;
  const tabs = TABS.filter(([k]) => k !== 'addons' || kind !== 'none');
  if (!tabs.some(([k]) => k === S.tab)) S.tab = 'console';
  main.append(
    h('div', { class: 'header', id: 'hdr' }),
    h('div', { class: 'stats', id: 'stats' }),
    h('div', { class: 'tabs' }, tabs.map(([k, label]) => h('div', {
      class: `tab${S.tab === k ? ' active' : ''}`, text: k === 'addons' ? (kind === 'plugins' ? 'Plugins' : 'Mods') : label,
      onclick: () => { S.tab = k; renderMain(); },
    }))),
    h('div', { class: 'tab-body', id: 'body' }),
  );
  renderHeader();
  renderStats();
  const body = $('#body');
  ({ console: renderConsole, players: renderPlayers, stats: renderStatsTab, worlds: renderWorlds, files: renderFiles, addons: renderAddons, access: renderAccessSimple, backups: renderBackups, properties: renderProperties, settings: renderSettings })[S.tab](body, s);
}

function renderWelcome(main) {
  main.append(h('div', { class: 'welcome-drag' }), h('div', { class: 'welcome' }, h('div', { class: 'welcome-inner' },
    h('div', { class: 'cube' }),
    h('h1', { text: 'Host a Minecraft server' }),
    h('p', { text: 'Pick Paper, Fabric, Forge and more. Blockyard downloads everything, including the right Java, and gives you a console, players, files and settings in one window.' }),
    h('div', { class: 'btns' },
      h('button', { class: 'btn primary', text: 'Create a Server', onclick: () => openCreate() }),
      h('button', { class: 'btn', text: 'Use a Singleplayer World', onclick: () => openCreate({ mode: 'world' }) }),
      h('button', { class: 'btn', text: 'Import Server Folder…', onclick: openImport })))));
}

function renderHeader() {
  const el = $('#hdr'); const s = current();
  if (!el || !s) return;
  const st = s.snapshot.state;
  const pub = S.accessView.get(s.id)?.publicAddress;
  const addr = pub || `${S.info.lan[0]?.address || 'localhost'}:${portOf(s.id)}`;
  const chip = h('div', { class: `chip${pub ? ' public' : ''}`, title: pub ? 'Public address: click for details' : 'How friends connect', onclick: () => connectPopover(chip, s) }, h('span', { text: pub ? '🌍' : '🏠' }), addr);
  clear(el).append(
    swIcon(s.software, true),
    h('div', { class: 'title' },
      h('h1', { text: s.name }),
      h('div', { class: 'subtitle' }, h('span', { class: `pill ${st}` }, h('span', { class: `dot ${st}` }), STATE_LABEL[st]),
        `${swInfo(s.software).label}${s.mcVersion ? ' ' + s.mcVersion : ''}`)),
    chip,
    h('div', { class: 'actions' },
      st === 'sleeping' && [
        h('button', { class: 'btn primary', text: '▶  Wake Up', title: 'Start it now instead of waiting for someone to join', onclick: guard(() => call('server:start', s.id)) }),
        h('button', { class: 'btn', text: '■  Stop', title: 'Stop sleeping: nobody can wake it until you start it', onclick: guard(() => call('server:stop', s.id)) })],
      st === 'stopped' && h('button', { class: 'btn primary', text: '▶  Start', onclick: guard(async e => { e.target.disabled = true; await call('server:start', s.id).finally(() => { e.target.disabled = false; }); }) }),
      (st === 'online' || st === 'starting') && [
        h('button', { class: 'btn', text: '↻  Restart', onclick: guard(() => call('server:restart', s.id)) }),
        h('button', { class: 'btn', text: '■  Stop', onclick: guard(() => call('server:stop', s.id)) }),
      ],
      st === 'stopping' && h('button', {
        class: 'btn danger', text: 'Force Stop', title: 'Kill the process immediately (unsaved changes may be lost)',
        onclick: guard(async () => { if (await confirmBox('Force stop the server?', 'The world might lose the last few minutes of changes.', ['Force Stop', 'Cancel'], true) === 0) call('server:kill', s.id); }),
      }),
    ),
  );
}

function connectPopover(anchor, s) {
  const port = portOf(s.id);
  const row = (label, value) => h('div', { class: 'addr' }, h('div', null, h('div', { class: 'muted', style: { fontSize: '11px' }, text: label }), h('div', { class: 'mono', text: value })),
    h('button', { class: 'btn sm', text: 'Copy', onclick: () => { call('clipboard:write', value); toast(`Copied ${value}`); } }));
  popover(anchor, [
    h('h4', { text: 'How to join' }),
    row(`On ${THIS_PC}`, port === '25565' ? 'localhost' : `localhost:${port}`),
    ...S.info.lan.slice(0, 2).map(a => row(`Same Wi-Fi / network (${a.name})`, `${a.address}:${port}`)),
    S.accessView.get(s.id)?.publicAddress ? row('From anywhere', S.accessView.get(s.id).publicAddress) : h('p', { text: 'Friends outside your home can’t join yet.' }),
    h('button', { class: 'btn sm block', text: 'Public Access settings…', style: { marginTop: '8px' }, onclick: () => { document.querySelectorAll('.popover').forEach(p => p.remove()); S.tab = 'access'; renderMain(); } }),
  ]);
}

function renderStats() {
  const el = $('#stats'); const s = current();
  if (!el || !s) return;
  const snap = s.snapshot; const run = !['stopped', 'sleeping'].includes(snap.state);
  const mem = snap.stats?.memMB || 0; const memMax = s.memoryMB || 2048;
  const stat = (k, v, pct) => h('div', { class: 'stat' }, h('div', { class: 'k', text: k }), h('div', { class: 'v', text: v }),
    pct != null && h('div', { class: 'bar' }, h('i', { style: { width: `${Math.min(100, pct)}%` } })));
  const m = snap.metrics; const fresh = m?.at && Date.now() - m.at < 60000;
  const tps = snap.state === 'online' && fresh && m.tps != null ? m.tps : null;
  const tpsTile = h('div', { class: 'stat', title: 'Ticks per second: 20 is perfect. Measured in the background.' },
    h('div', { class: 'k', text: 'TPS' }),
    h('div', { class: 'v' }, tps == null ? '–' : tps.toFixed(1), tps != null && h('span', { class: `tps-label ${tpsLevel(tps)[0]}`, text: tpsLevel(tps)[1] })),
    h('div', { class: 'bar' }, h('i', { style: { width: `${tps == null ? 0 : (tps / 20) * 100}%` } })));
  clear(el).append(
    tpsTile,
    stat('CPU', run ? `${Math.round(snap.stats?.cpu || 0)}%` : '–', run ? (snap.stats?.cpu || 0) / (navigator.hardwareConcurrency || 4) : 0),
    stat('Memory', run ? `${fmtMem(mem)} / ${fmtMem(memMax)}` : `– / ${fmtMem(memMax)}`, run ? (mem / memMax) * 100 : 0),
    stat('Players', snap.state === 'online' ? `${snap.players.length}${snap.maxPlayers ? ' / ' + snap.maxPlayers : ''}` : '–'),
    h('div', { class: 'stat' }, h('div', { class: 'k', text: 'Uptime' }), h('div', { class: 'v', id: 'uptime', text: snap.startedAt ? fmtDur(Date.now() - snap.startedAt) : '–' })),
  );
}
setInterval(() => {
  const s = current(); const el = $('#uptime');
  if (el && s?.snapshot.startedAt) el.textContent = fmtDur(Date.now() - s.snapshot.startedAt);
}, 1000);

// ---------- console ----------
function lineClass(entry) {
  if (entry.source === 'app') return 'ln app';
  if (entry.source === 'cmd') return 'ln cmd';
  const t = entry.text;
  if (/\b(ERROR|FATAL|SEVERE)\b|Exception|^\s+at /.test(t)) return 'ln error';
  if (/\bWARN(ING)?\b/.test(t)) return 'ln warn';
  if (/ (joined|left) the game\s*$/.test(t)) return 'ln join';
  return 'ln';
}
const lineEl = entry => h('div', { class: lineClass(entry), text: entry.text });

function renderConsole(body, s) {
  body.className = 'tab-body flush';
  const running = !['stopped', 'sleeping'].includes(s.snapshot.state);
  const log = h('div', { class: 'log', id: 'log' });
  const lines = S.logs.get(s.id) || [];
  if (!lines.length) log.append(h('div', { class: 'console-empty', text: running ? 'Waiting for output…' : 'The server is offline. Press Start to launch it. Its console output will appear here.' }));
  const frag = document.createDocumentFragment();
  for (const l of lines) frag.append(lineEl(l));
  log.append(frag);

  const hist = S.history.get(s.id) || []; S.history.set(s.id, hist);
  let hi = hist.length;
  const input = h('input', { type: 'text', id: 'cmd', placeholder: running ? 'Type a command, e.g. say hello or op YourName (no slash needed)' : 'Start the server to send commands', disabled: !running, spellcheck: false, autocomplete: 'off' });
  const sendCmd = guard(async cmd => {
    cmd = cmd.trim(); if (!cmd) return;
    if (hist[hist.length - 1] !== cmd) hist.push(cmd);
    hi = hist.length;
    await call('server:command', s.id, cmd);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { sendCmd(input.value); input.value = ''; }
    else if (e.key === 'ArrowUp' && hi > 0) { input.value = hist[--hi]; e.preventDefault(); }
    else if (e.key === 'ArrowDown') { hi = Math.min(hist.length, hi + 1); input.value = hist[hi] || ''; e.preventDefault(); }
  });
  const quick = ['list', 'save-all', 'time set day', 'weather clear', 'difficulty peaceful'];
  put(body, h('div', { class: 'console' }, log,
    h('div', { class: 'console-bar' },
      h('div', { class: 'quick' }, quick.map(q => h('button', { text: q, disabled: s.snapshot.state !== 'online', onclick: () => sendCmd(q) })),
        h('span', { style: { flex: 1 } }),
        h('button', { text: 'log files', onclick: () => openLogFiles(s) }),
        h('button', { text: 'clear view', onclick: () => { S.logs.set(s.id, []); clear(log); } })),
      h('div', { class: 'cmd-row' }, h('span', { class: 'prompt', text: '›' }), input,
        h('button', { class: 'btn primary', text: 'Send', disabled: !running, onclick: () => { sendCmd(input.value); input.value = ''; input.focus(); } })))));
  log.scrollTop = log.scrollHeight;
  if (running) setTimeout(() => input.focus(), 0);
}

function appendLine(entry) {
  const log = $('#log'); if (!log) return;
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  const empty = $('.console-empty', log); if (empty) empty.remove();
  log.append(lineEl(entry));
  while (log.childElementCount > 2500) log.firstElementChild.remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
}

// ---------- players ----------
async function renderPlayers(body, s) {
  const online = s.snapshot.state === 'online';
  const cmd = guard(async c => { await call('server:command', s.id, c); setTimeout(() => S.tab === 'players' && current()?.id === s.id && refreshLists(), 900); });
  const lists = await call('players:lists', s.id).catch(() => ({ ops: [], whitelist: [], banned: [] }));
  const ops = new Set(lists.ops.map(n => n.toLowerCase()));

  const onlineSec = h('div', { class: 'section', id: 'online-sec' });
  function drawOnline() {
    const snap = current()?.snapshot || s.snapshot;
    clear(onlineSec).append(h('div', { class: 'section-head' },
      h('h2', { text: `Online now${snap.state === 'online' ? ` (${snap.players.length}${snap.maxPlayers ? '/' + snap.maxPlayers : ''})` : ''}` }),
      h('button', { class: 'btn sm', text: 'Refresh', disabled: snap.state !== 'online', title: 'Runs the "list" command', onclick: () => cmd('list') })));
    if (snap.state !== 'online') { onlineSec.append(h('div', { class: 'card empty', text: 'The server is offline.' })); return; }
    if (!snap.players.length) { onlineSec.append(h('div', { class: 'card empty', text: 'Nobody is online yet. Share your address (top right) with friends.' })); return; }
    onlineSec.append(h('div', { class: 'players' }, snap.players.map(p => {
      const img = h('img', { src: `https://mc-heads.net/avatar/${encodeURIComponent(p.uuid || p.name)}/40`, alt: '' });
      img.onerror = () => img.replaceWith(h('div', { class: 'ph' }));
      const isOp = ops.has(p.name.toLowerCase());
      return h('div', { class: 'card player' }, img, h('div', { class: 'meta' },
        h('div', { class: 'pname selectable', text: p.name }),
        h('div', { class: 'muted', style: { fontSize: '11px' }, text: p.joinedAt ? `Joined ${fmtDur(Date.now() - p.joinedAt)} ago${isOp ? ' · operator' : ''}` : (isOp ? 'Operator' : 'Online') }),
        h('div', { class: 'pbtns' },
          h('button', { class: 'btn sm', text: 'Kick', onclick: async () => { const r = await promptModal({ title: `Kick ${p.name}`, label: 'Reason (optional)', okLabel: 'Kick' }); if (r !== null) cmd(`kick ${p.name}${r.trim() ? ' ' + r.trim() : ''}`); } }),
          h('button', { class: 'btn sm danger', text: 'Ban', onclick: async () => { const r = await promptModal({ title: `Ban ${p.name}`, label: 'Reason (optional)', okLabel: 'Ban' }); if (r !== null) cmd(`ban ${p.name}${r.trim() ? ' ' + r.trim() : ''}`); } }),
          h('button', { class: 'btn sm', text: isOp ? 'De-op' : 'Make op', onclick: () => cmd(`${isOp ? 'deop' : 'op'} ${p.name}`) }),
          h('button', { class: 'btn sm', text: 'Gamemode', onclick: async () => { const r = await promptModal({ title: `Gamemode for ${p.name}`, label: 'survival, creative, adventure or spectator', value: 'creative', okLabel: 'Set' }); if (r) cmd(`gamemode ${r.trim()} ${p.name}`); } }),
        )));
    })));
  }
  drawOnline();
  S.redrawOnline = drawOnline;

  const listsEl = h('div', { class: 'lists' });
  function listCard(title, names, addCmd, removeCmd, extra) {
    const input = h('input', { type: 'text', placeholder: 'Player name', disabled: !online });
    const add = () => { const n = input.value.trim(); if (n) { cmd(`${addCmd} ${n}`); input.value = ''; } };
    input.addEventListener('keydown', e => e.key === 'Enter' && add());
    return h('div', { class: 'card list-card' },
      h('h3', null, title, h('span', { class: 'count', text: names.length }), h('span', { style: { flex: 1 } }), extra),
      names.length ? h('ul', null, names.map(n => h('li', null, h('span', { class: 'selectable', text: n }),
        h('button', { class: 'btn sm ghost', text: 'Remove', disabled: !online, onclick: () => cmd(`${removeCmd} ${n}`) }))))
        : h('div', { class: 'muted', style: { flex: 1, fontSize: '12px' }, text: 'Empty' }),
      h('div', { class: 'add' }, input, h('button', { class: 'btn sm', text: 'Add', disabled: !online, onclick: add })));
  }
  async function refreshLists() {
    const l = await call('players:lists', s.id).catch(() => lists);
    const props = await loadProps(s.id);
    ops.clear(); l.ops.forEach(n => ops.add(n.toLowerCase()));
    const wlOn = props.values['white-list'] === 'true';
    const wlToggle = h('label', { class: 'switch', title: online ? 'Turn the whitelist on/off' : 'Start the server to change' },
      h('input', { type: 'checkbox', checked: wlOn, disabled: !online, onchange: e => cmd(`whitelist ${e.target.checked ? 'on' : 'off'}`) }), h('span'));
    clear(listsEl).append(
      listCard('Operators', l.ops, 'op', 'deop'),
      listCard('Whitelist', l.whitelist, 'whitelist add', 'whitelist remove', wlToggle),
      listCard('Banned', l.banned, 'ban', 'pardon'));
    drawOnline();
  }
  await refreshLists();
  put(body, onlineSec, h('div', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', { text: 'Player lists' }), !online && h('span', { class: 'hint', text: 'Start the server to make changes' })),
    listsEl));
}

// ---------- files ----------
const FICON = name => (/\.jar$/i.test(name) ? '☕' : /\.(ya?ml|json|toml|properties|cfg|conf|txt|log|ini)$/i.test(name) ? '📄' : /\.(png|jpe?g|gif)$/i.test(name) ? '🖼' : /\.(zip|gz|tar)$/i.test(name) ? '🗜' : '📄');

async function renderFiles(body, s) {
  const cwd = S.cwd.get(s.id) || '';
  const go = rel => { S.cwd.set(s.id, rel); renderMain(); };
  let entries;
  try { entries = await call('files:list', s.id, cwd); } catch (e) {
    if (cwd) { S.cwd.set(s.id, ''); return renderMain(); }
    put(body, h('div', { class: 'note err', text: e.message })); return;
  }
  const parts = cwd ? cwd.split('/') : [];
  const crumbs = h('div', { class: 'crumbs' }, h('button', { text: s.name, onclick: () => go('') }),
    parts.map((p, i) => [h('span', { class: 'sep', text: '›' }), h('button', { text: p, onclick: () => go(parts.slice(0, i + 1).join('/')) })]));
  const rel = name => (cwd ? `${cwd}/${name}` : name);
  const refresh = () => renderMain();

  const open = guard(async e => {
    if (e.dir) return go(rel(e.name));
    if (e.text) return openEditor(s, rel(e.name));
    return call('files:open', s.id, rel(e.name));
  });

  const rows = entries.map(e => h('tr', { ondblclick: () => open(e) },
    h('td', { class: 'name' }, h('span', { class: 'ficon', text: e.dir ? '📁' : FICON(e.name) }), e.name),
    h('td', { class: 'num', text: e.dir ? '' : fmtBytes(e.size) }),
    h('td', { class: 'num', text: fmtDate(e.mtime) }),
    h('td', null, h('div', { class: 'row-actions' },
      !e.dir && e.text && h('button', { class: 'btn sm ghost', text: 'Edit', onclick: () => openEditor(s, rel(e.name)) }),
      h('button', { class: 'btn sm ghost', text: 'Rename', onclick: guard(async () => { const n = await promptModal({ title: 'Rename', value: e.name, okLabel: 'Rename' }); if (n && n !== e.name) { await call('files:rename', s.id, rel(e.name), n); refresh(); } }) }),
      h('button', { class: 'btn sm ghost', text: 'Reveal', onclick: () => call('files:reveal', s.id, rel(e.name)) }),
      h('button', { class: 'btn sm ghost danger', text: 'Delete', onclick: guard(async () => {
        if (await confirmBox(`Move "${e.name}" to the Trash?`, isRunning(s) ? 'The server is running. Deleting files it uses can cause problems.' : 'You can restore it from the Trash.', ['Move to Trash', 'Cancel'], true) === 0) { await call('files:trash', s.id, rel(e.name)); refresh(); }
      }) })))));

  const zone = h('div', { class: 'card dropzone' }, entries.length
    ? h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', { text: 'Name' }), h('th', { text: 'Size', style: { textAlign: 'right' } }), h('th', { text: 'Modified', style: { textAlign: 'right' } }), h('th'))), h('tbody', null, rows))
    : h('div', { class: 'empty', text: 'This folder is empty. Drop files here to add them.' }));
  dropTarget(zone, guard(async paths => { const c = await call('files:copyIn', s.id, cwd, paths); toast(`Copied ${c.length} item${c.length === 1 ? '' : 's'}`); refresh(); }));

  put(body, 
    h('div', { class: 'toolbar' }, crumbs,
      cwd && h('button', { class: 'btn sm', text: '↑ Up', onclick: () => go(parts.slice(0, -1).join('/')) }),
      h('button', { class: 'btn sm', text: 'New Folder', onclick: guard(async () => { const n = await promptModal({ title: 'New folder', placeholder: 'Folder name', okLabel: 'Create' }); if (n) { await call('files:mkdir', s.id, rel(n)); refresh(); } }) }),
      h('button', { class: 'btn sm', text: 'Add Files…', onclick: guard(async () => { const p = await call('dialog:pickFiles', { title: 'Copy files into this folder' }); if (p.length) { await call('files:copyIn', s.id, cwd, p); refresh(); } }) }),
      h('button', { class: 'btn sm', text: `Open in ${FILE_MGR}`, onclick: () => call('files:reveal', s.id, cwd) })),
    zone,
    h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '8px' }, text: `Double-click to open folders and edit text files. Drag files from ${FILE_MGR} to copy them in.` }));
}

function dropTarget(el, onPaths) {
  if (api.dropTarget) return api.dropTarget(el, onPaths); // the app: Tauri reports dropped file paths
  let depth = 0;
  el.addEventListener('dragenter', e => { e.preventDefault(); depth++; el.classList.add('drag'); });
  el.addEventListener('dragover', e => e.preventDefault());
  el.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; el.classList.remove('drag'); } });
  el.addEventListener('drop', e => {
    e.preventDefault(); depth = 0; el.classList.remove('drag');
    const paths = [...e.dataTransfer.files].map(f => api.pathForFile?.(f)).filter(Boolean);
    if (paths.length) onPaths(paths);
  });
}

async function openEditor(s, rel) {
  let text;
  try { text = await call('files:read', s.id, rel); } catch (e) { return toast(e.message, 'error'); }
  const ta = h('textarea', { class: 'editor', spellcheck: false, value: text });
  let dirty = false;
  ta.addEventListener('input', () => { dirty = true; });
  const save = guard(async () => { await call('files:write', s.id, rel, ta.value); dirty = false; toast(`Saved ${rel}`); if (rel === 'server.properties') loadProps(s.id); m.close(); });
  ta.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); }
    if (e.key === 'Tab') { e.preventDefault(); const p = ta.selectionStart; ta.setRangeText('  ', p, ta.selectionEnd, 'end'); dirty = true; }
  });
  const m = modal({
    title: rel.split('/').pop(), subtitle: rel, size: 'wide', body: ta, dismissable: () => !dirty || confirm('Discard unsaved changes?'),
    foot: [h('span', { class: 'muted grow', text: isRunning(s) ? 'Most config changes apply after a restart.' : `${MOD_KEY}S to save` }),
      h('button', { class: 'btn', text: 'Cancel', onclick: () => { if (!dirty || confirm('Discard unsaved changes?')) m.close(); } }),
      h('button', { class: 'btn primary', text: 'Save', onclick: save })],
  });
  setTimeout(() => ta.focus(), 30);
}

// ---------- plugins / mods ----------
async function renderAddons(body, s) {
  return renderAddonSwitch(body, s, () => renderInstalledAddons(body, s));
}
async function renderInstalledAddons(body, s) {
  const kind = s.kind || swInfo(s.software).kind;
  const noun = kind === 'plugins' ? 'plugin' : 'mod';
  const { items } = await call('addons:list', s.id);
  const refresh = () => renderMain();
  const loader = kind === 'plugins' ? 'paper' : s.software;
  const modrinth = `https://modrinth.com/${kind === 'plugins' ? 'plugins' : 'mods'}?g=categories:${loader}${s.mcVersion ? `&v=${s.mcVersion}` : ''}`;
  const zone = h('div', { class: 'card dropzone' }, items.length
    ? h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', { text: 'Enabled' }), h('th', { text: 'Name' }), h('th', { text: 'Size', style: { textAlign: 'right' } }), h('th'))),
      h('tbody', null, items.map(it => h('tr', null,
        h('td', null, h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: it.enabled, onchange: guard(async e => { await call('addons:toggle', s.id, it.file, e.target.checked); changed(); refresh(); }) }), h('span'))),
        h('td', { class: 'name', style: { opacity: it.enabled ? 1 : 0.5 } }, h('span', { class: 'ficon', text: '🧩' }), it.name),
        h('td', { class: 'num', text: fmtBytes(it.size) }),
        h('td', null, h('div', { class: 'row-actions' }, h('button', { class: 'btn sm ghost danger', text: 'Remove', onclick: guard(async () => {
          if (await confirmBox(`Remove ${it.name}?`, 'The .jar will be moved to the Trash.', ['Move to Trash', 'Cancel'], true) === 0) { await call('addons:trash', s.id, it.file); changed(); refresh(); }
        }) })))))))
    : h('div', { class: 'empty' }, `No ${noun}s yet. Drop .jar files here, or find some on Modrinth.`));
  const changed = () => { if (isRunning(s)) toast(`Restart the server to apply ${noun} changes.`); };
  dropTarget(zone, guard(async paths => { const c = await call('addons:add', s.id, paths); toast(c.length ? `Added ${c.join(', ')}` : 'Only .jar files can be added.', c.length ? 'ok' : 'error'); changed(); refresh(); }));
  put(body, 
    h('div', { class: 'section-head' }, h('h2', { text: `${kind === 'plugins' ? 'Plugins' : 'Mods'} (${items.length})` }),
      h('button', { class: 'btn sm', text: `Add .jar…`, onclick: guard(async () => { const p = await call('dialog:pickFiles', { title: `Add ${noun}s`, filters: [{ name: 'Java archives', extensions: ['jar'] }] }); if (p.length) { await call('addons:add', s.id, p); changed(); refresh(); } }) }),
      h('button', { class: 'btn sm', text: 'Open Folder', onclick: () => call('addons:openFolder', s.id) }),
      h('button', { class: 'btn sm primary', text: `Browse Modrinth`, onclick: () => { S.addonView = 'browse'; renderMain(); } }),
      h('button', { class: 'btn sm ghost', text: 'modrinth.com ↗', onclick: () => call('shell:external', modrinth) })),
    kind === 'mods' && h('div', { class: 'note' }, `Download the ${swInfo(s.software).label} build of each mod for Minecraft ${s.mcVersion || 'your version'}. Most mods also have to be installed on every player's game.`),
    zone,
    h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '8px' }, text: `Turning a ${noun} off renames it to .jar.disabled so the server skips it. Changes apply after a restart.` }));
}

// ---------- properties ----------
const PROPS = [
  ['motd', 'text', 'Server name', 'Shown under your server in the multiplayer list'],
  ['server-port', 'number', 'Port', 'The port players connect to. Default is 25565'],
  ['max-players', 'number', 'Max players'],
  ['gamemode', ['survival', 'creative', 'adventure', 'spectator'], 'Default game mode'],
  ['difficulty', ['peaceful', 'easy', 'normal', 'hard'], 'Difficulty'],
  ['hardcore', 'bool', 'Hardcore', 'Players are banned/spectators on death'],
  ['pvp', 'bool', 'PvP', 'Players can damage each other'],
  ['white-list', 'bool', 'Whitelist', 'Only players on the whitelist can join'],
  ['enforce-whitelist', 'bool', 'Enforce whitelist', 'Kick people not on the whitelist when it reloads'],
  ['online-mode', 'bool', 'Online mode', 'Check that players own Minecraft. Keep on unless you know why not'],
  ['allow-flight', 'bool', 'Allow flight', 'Stops kicking players for flying (needed for some mods)'],
  ['view-distance', 'number', 'View distance', 'Chunks sent to players (lower = less lag)'],
  ['simulation-distance', 'number', 'Simulation distance', 'Chunks where mobs and crops update'],
  ['spawn-protection', 'number', 'Spawn protection', 'Radius around spawn only ops can build in (0 = off)'],
  ['level-name', 'text', 'World folder', 'Change to start a fresh world (old one is kept)'],
  ['level-seed', 'text', 'World seed', 'Only used when a new world is generated'],
  ['allow-nether', 'bool', 'Allow Nether'],
  ['enable-command-block', 'bool', 'Command blocks'],
  ['spawn-monsters', 'bool', 'Spawn monsters'],
  ['generate-structures', 'bool', 'Generate structures'],
  ['force-gamemode', 'bool', 'Force game mode', 'Put players in the default mode every time they join'],
  ['enable-status', 'bool', 'Show in server list'],
];

async function renderProperties(body, s) {
  const props = await loadProps(s.id);
  if (!props.exists) {
    put(body, h('div', { class: 'note warn', text: 'There’s no server.properties yet. Start the server once and Minecraft will create it with all the settings.' }));
    return;
  }
  const values = { ...props.values };
  const changes = {};
  const saveBtn = h('button', { class: 'btn primary', text: 'Save Changes', disabled: true });
  const status = h('span', { class: 'muted', style: { flex: 1 } });
  const set = (k, v) => { changes[k] = String(v); saveBtn.disabled = false; status.textContent = `${Object.keys(changes).length} unsaved change(s)`; };

  const control = (key, type, value) => {
    if (type === 'bool') return h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: value === 'true', onchange: e => set(key, e.target.checked) }), h('span'));
    if (Array.isArray(type)) return h('select', { onchange: e => set(key, e.target.value) }, (type.includes(value) || !value ? type : [value, ...type]).map(o => h('option', { value: o, text: o[0].toUpperCase() + o.slice(1), selected: o === value })));
    return h('input', { type: type === 'number' ? 'number' : 'text', value: value ?? '', oninput: e => set(key, e.target.value) });
  };
  const known = PROPS.filter(([k]) => k in values);
  const cards = known.map(([key, type, label, desc]) => {
    const c = control(key, type, values[key]);
    return h('div', { class: 'card prop' },
      h('div', { class: 'top' }, h('div', { class: 'key' }, label, h('small', { text: key })), type === 'bool' && c),
      desc && h('div', { class: 'desc', text: desc }), type !== 'bool' && c);
  });
  const knownKeys = new Set(PROPS.map(p => p[0]));
  const others = Object.keys(values).filter(k => !knownKeys.has(k)).sort();
  saveBtn.onclick = guard(async () => {
    await call('props:set', s.id, changes);
    await loadProps(s.id);
    toast(isRunning(s) ? 'Saved. Restart the server to apply.' : 'Saved.');
    renderMain();
  });
  put(body, 
    isRunning(s) && h('div', { class: 'note warn', text: 'The server is running. Changes are saved to server.properties and take effect after a restart.' }),
    h('div', { class: 'props' }, cards),
    others.length > 0 && h('details', { class: 'adv', style: { marginTop: '18px' } }, h('summary', { text: `All other settings (${others.length})` }),
      h('div', { class: 'props', style: { marginTop: '8px' } }, others.map(k => h('div', { class: 'card prop' }, h('div', { class: 'key mono', text: k }), control(k, 'text', values[k]))))),
    h('div', { class: 'sticky-save' }, status, h('button', { class: 'btn', text: 'Edit as Text', onclick: () => openEditor(s, 'server.properties') }), saveBtn));
}

// ---------- settings ----------
async function renderSettings(body, s) {
  const total = S.info.totalMemMB;
  const maxMem = Math.max(2048, Math.floor((total * 0.75) / 512) * 512);
  const javas = S.javas = await call('java:list').catch(() => []);
  const name = h('input', { type: 'text', value: s.name });
  const memLabel = h('strong', { text: fmtMem(s.memoryMB || 2048), style: { minWidth: '60px' } });
  const mem = h('input', { type: 'range', min: 1024, max: maxMem, step: 512, value: s.memoryMB || 2048, oninput: e => { memLabel.textContent = fmtMem(+e.target.value); } });
  const javaSel = h('select', null,
    h('option', { value: '', text: `Automatic${s.javaMajor ? ` (Java ${s.javaMajor})` : ''}` }),
    javas.map(j => h('option', { value: j.path, text: `Java ${j.version}${j.managed ? ' (Blockyard)' : ''}`, selected: j.path === s.javaPath })));
  const sw = h('select', null, S.software.map(x => h('option', { value: x.id, text: x.label, selected: x.id === s.software })));
  const ver = h('input', { type: 'text', value: s.mcVersion || '', placeholder: 'e.g. 1.21.4' });
  const jvm = h('input', { type: 'text', class: 'mono', value: s.jvmArgs || '', placeholder: 'e.g. -XX:+UseG1GC', spellcheck: false });
  const launch = h('input', { type: 'text', class: 'mono', value: (s.launchArgs || []).join(' '), spellcheck: false });
  const needMajor = s.javaMajor || 21;
  const hasNeeded = javas.some(j => j.major === needMajor || (needMajor >= 16 && j.major > needMajor));

  const save = guard(async () => {
    const launchArgs = launch.value.match(/"[^"]*"|\S+/g)?.map(t => t.replace(/^"|"$/g, '')) || [];
    if (!launchArgs.length) throw new Error('The launch arguments can’t be empty (usually -jar server.jar).');
    const updated = await call('servers:update', s.id, { name: name.value.trim() || s.name, memoryMB: +mem.value, javaPath: javaSel.value, software: sw.value, mcVersion: ver.value.trim(), jvmArgs: jvm.value.trim(), launchArgs });
    Object.assign(s, updated, { snapshot: s.snapshot });
    toast(isRunning(s) ? 'Saved. Restart the server to apply.' : 'Settings saved.');
    renderSidebar(); renderMain();
  });

  const row = (label, ctrl, help) => [h('label', { class: 'k', text: label }), ctrl, help && h('div', { class: 'help', text: help })];
  put(body, 
    h('div', { class: 'form' },
      row('Name', name),
      row('Memory (RAM)', h('div', { class: 'row' }, mem, memLabel), `${YOUR_PC} has ${fmtMem(total)}. 2–4 GB suits a few friends, 6–8 GB+ for modpacks. Leave plenty for everything else.`),
      row('Java', h('div', { class: 'row' }, javaSel, !hasNeeded && h('button', { class: 'btn', text: `Download Java ${needMajor}`, onclick: () => installJava(needMajor, () => renderMain()) })),
        `Minecraft ${s.mcVersion || ''} needs Java ${needMajor}. "Automatic" picks a matching one and offers to download it if missing.`),
      row('Software', sw),
      row('Minecraft version', ver, 'Used to choose the right Java and to filter Modrinth.'),
      row('Extra JVM flags', jvm, 'Optional. Memory flags (-Xmx/-Xms) are added automatically.'),
      row('Launch arguments', launch, 'What runs after "java": usually -jar server.jar. "nogui" is added for you.'),
      row('Folder', h('div', { class: 'row' }, h('div', { class: 'p mono selectable', style: { flex: 1, fontSize: '11.5px', overflow: 'hidden', textOverflow: 'ellipsis' }, text: s.dir }),
        h('button', { class: 'btn', text: `Show in ${FILE_MGR}`, onclick: () => call('files:reveal', s.id, '') }))),
      h('span'), h('div', null, h('button', { class: 'btn primary', text: 'Save Settings', onclick: save })),
    ),
    automationSection(s),
    schedulesSection(s),
    webhookSection(s),
    iconSection(s),
    h('h2', { text: 'Remove server', style: { fontSize: '14px', margin: '30px 0 10px' } }),
    h('div', { class: 'danger-zone' },
      h('div', { class: 'grow' }, h('div', { style: { fontWeight: 600 }, text: 'Remove from Blockyard' }), h('div', { class: 'muted', style: { fontSize: '12px' }, text: 'Keep the folder, or move the whole server (world included) to the Trash.' })),
      h('button', { class: 'btn', text: 'Remove, Keep Files', disabled: isRunning(s), onclick: () => removeServer(s, false) }),
      h('button', { class: 'btn danger-fill', text: 'Move to Trash', disabled: isRunning(s), onclick: () => removeServer(s, true) })),
    isRunning(s) && h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' }, text: 'Stop the server to remove it.' }),
  );
}

const removeServer = guard(async (s, trash) => {
  const r = await confirmBox(trash ? `Move "${s.name}" to the Trash?` : `Remove "${s.name}" from Blockyard?`,
    trash ? `The folder ${s.dir} (including the world) will go to the Trash.` : `The files stay in ${s.dir}. You can import it again later.`,
    [trash ? 'Move to Trash' : 'Remove', 'Cancel'], trash);
  if (r !== 0) return;
  await call('servers:remove', s.id, { trash });
  S.servers = S.servers.filter(x => x.id !== s.id);
  S.selected = S.servers[0]?.id || null;
  renderSidebar(); S.selected ? select(S.selected) : renderMain();
});

function installJava(major, done) {
  const taskId = 'java-' + Date.now();
  const bar = h('div', { class: 'progress indet' }, h('i'));
  const status = h('div', { class: 'task-status', text: 'Starting download…' });
  const m = modal({ title: `Installing Java ${major}`, subtitle: 'Eclipse Temurin, stored inside Blockyard', size: 'small', body: [status, bar], dismissable: () => false });
  const off = api.on('task:progress', p => {
    if (p.taskId !== taskId) return;
    status.textContent = p.message;
    if (p.pct != null) { bar.classList.remove('indet'); bar.firstChild.style.width = `${Math.round(p.pct * 100)}%`; }
  });
  call('java:install', major, taskId).then(() => { toast(`Java ${major} installed`); done?.(); }, e => toast(e.message, 'error')).finally(() => { off(); m.close(); });
}

// ---------- create server ----------
// openCreate (the new-server wizard) lives in v12.js
function uniqueName(base) {
  const names = new Set(S.servers.map(s => s.name));
  if (!names.has(base)) return base;
  let i = 2; while (names.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

// ---------- import ----------
async function openImport() {
  const dir = await call('dialog:pickFolder', { title: 'Choose an existing server folder', buttonLabel: 'Import' });
  if (!dir) return;
  let d;
  try { d = await call('servers:detect', dir); } catch (e) { return toast(e.message, 'error'); }
  const name = h('input', { type: 'text', value: d.name, style: { width: '100%' } });
  const sw = h('select', { style: { width: '100%' } }, S.software.map(x => h('option', { value: x.id, text: x.label, selected: x.id === d.software })));
  const ver = h('input', { type: 'text', value: d.mcVersion, placeholder: 'e.g. 1.21.4', style: { width: '100%' } });
  const launch = h('input', { type: 'text', class: 'mono', value: (d.launchArgs || []).join(' '), placeholder: '-jar server.jar', style: { width: '100%' } });
  const jarSel = d.jars.length > 1 && h('select', { style: { width: '100%' }, onchange: e => { launch.value = `-jar ${e.target.value}`; } },
    d.jars.map(j => h('option', { value: j, text: j, selected: d.launchArgs?.[1] === j })));
  const total = S.info.totalMemMB;
  const memLabel = h('strong', { text: fmtMem(2048) });
  const mem = h('input', { type: 'range', min: 1024, max: Math.max(2048, Math.floor((total * 0.75) / 512) * 512), step: 512, value: 2048, oninput: e => { memLabel.textContent = fmtMem(+e.target.value); } });
  const m = modal({
    title: 'Import Server', subtitle: dir, size: '',
    body: [
      ...d.warnings.map(w => h('div', { class: 'note warn', text: w })),
      h('div', { class: 'field' }, h('label', { text: 'Name' }), name),
      h('div', { class: 'field-row' },
        h('div', { class: 'field' }, h('label', { text: 'Software (detected)' }), sw),
        h('div', { class: 'field' }, h('label', { text: 'Minecraft version' }), ver, !d.mcVersion && h('div', { class: 'help', text: 'Couldn’t detect it. Enter it so the right Java is used.' }))),
      jarSel && h('div', { class: 'field' }, h('label', { text: 'Server jar' }), jarSel),
      h('div', { class: 'field' }, h('label', { text: 'Launch arguments' }), launch, h('div', { class: 'help', text: 'What runs after "java". Memory flags and nogui are added for you.' })),
      h('div', { class: 'field' }, h('label', null, 'Memory: ', memLabel), mem),
    ],
    foot: [h('button', { class: 'btn', text: 'Cancel', onclick: () => m.close() }),
      h('button', { class: 'btn primary', text: 'Import', onclick: guard(async () => {
        const launchArgs = launch.value.match(/"[^"]*"|\S+/g)?.map(t => t.replace(/^"|"$/g, ''));
        const created = await call('servers:import', { dir, name: name.value.trim(), software: sw.value, mcVersion: ver.value.trim(), launchArgs, memoryMB: +mem.value });
        S.servers.push(created); m.close(); S.tab = 'console'; select(created.id); toast(`Imported ${created.name}`);
      }) })],
  });
}

// ---------- app settings ----------
async function openAppSettings() {
  const settings = await call('settings:get');
  const javas = await call('java:list').catch(() => []);
  const awake = h('input', { type: 'checkbox', checked: settings.keepAwake !== false, onchange: e => call('settings:set', { keepAwake: e.target.checked }) });
  const javaList = h('div', { class: 'card', style: { padding: '4px 0' } }, javas.length
    ? javas.map(j => h('div', { style: { display: 'flex', gap: '10px', padding: '6px 12px', alignItems: 'center' } }, h('strong', { text: `Java ${j.major}`, style: { width: '64px' } }), h('span', { class: 'mono muted selectable', style: { fontSize: '11px', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, text: j.path, title: j.path })))
    : h('div', { class: 'empty', text: 'No Java found. Blockyard will download it when a server needs it.' }));
  const m = modal({
    title: 'Blockyard Settings', size: 'small',
    body: [
      h('label', { class: 'check', style: { marginBottom: '4px' } }, h('label', { class: 'switch' }, awake, h('span')), h('strong', { text: `Keep ${THIS_PC.replace('this ', '')} awake while servers run` })),
      h('div', { class: 'muted', style: { fontSize: '12px', margin: '0 0 14px 42px' }, text: IS_MAC ? 'Stops idle sleep so the server stays reachable. Closing a MacBook lid still sleeps it.' : 'Stops idle sleep so the server stays reachable. Closing a laptop lid may still sleep it.' }),
      h('label', { class: 'check', style: { marginBottom: '4px' } }, h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: settings.notifyPlayers !== false, onchange: e => call('settings:set', { notifyPlayers: e.target.checked }) }), h('span')), h('strong', { text: 'Notify me when players join or leave' })),
      h('div', { class: 'muted', style: { fontSize: '12px', margin: '0 0 14px 42px' }, text: 'Only while Blockyard isn’t the front window.' }),
      h('label', { class: 'check', style: { margin: '6px 0 14px' } }, h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: settings.menuBar !== false, onchange: e => call('tray:set', e.target.checked) }), h('span')), h('strong', { text: 'Show Blockyard in the menu bar' })),
      h('label', { class: 'check', style: { marginBottom: '18px' } }, h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: settings.notifyCrashes !== false, onchange: e => call('settings:set', { notifyCrashes: e.target.checked }) }), h('span')), h('strong', { text: 'Notify me when a server crashes or a backup fails' })),
      h('div', { class: 'field' }, h('label', { text: 'Java runtimes found' }), javaList),
      h('div', { class: 'row', style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, [25, 21, 17, 8].map(v => h('button', { class: 'btn sm', text: `Get Java ${v}`, onclick: () => { m.close(); installJava(v, openAppSettings); } }))),
      h('label', { class: 'check', style: { margin: '18px 0 4px' } }, h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: settings.checkUpdates !== false, onchange: e => call('settings:set', { checkUpdates: e.target.checked }) }), h('span')), h('strong', { text: 'Check GitHub for new versions' })),
      h('div', { class: 'muted', style: { fontSize: '12px', margin: '0 0 10px 42px' }, text: 'Once at launch. Nothing about you or your servers is sent.' }),
      h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
        h('button', { class: 'btn sm', text: 'Check for Updates', onclick: e => checkForUpdate(true, e.target) }),
        h('button', { class: 'btn sm', text: 'Report a Problem…', onclick: () => call('app:reportIssue') }),
        h('button', { class: 'btn sm', text: 'Show Logs', onclick: () => call('app:openLogs') })),
      h('div', { class: 'muted', style: { fontSize: '11.5px', marginTop: '18px' }, text: `Blockyard ${S.info.version} · Free and open source (MIT) · Not affiliated with Mojang or Microsoft.` }),
    ],
    foot: [h('button', { class: 'btn primary', text: 'Done', onclick: () => m.close() })],
  });
}

// ---------- live events ----------
api.on('server:line', ({ id, line }) => {
  const log = S.logs.get(id);
  if (log) { log.push(line); if (log.length > 2500) log.splice(0, log.length - 2500); }
  if (id === S.selected && S.tab === 'console') appendLine(line);
});
api.on('server:state', snap => {
  const s = server(snap.id); if (!s) return;
  const prev = s.snapshot.state;
  s.snapshot = snap;
  renderSidebar();
  if (snap.id !== S.selected) return;
  renderHeader(); renderStats();
  if (prev !== snap.state) {
    if (S.tab === 'console') { const i = $('#cmd'); const run = !['stopped', 'sleeping'].includes(snap.state); if (i) { i.disabled = !run; i.placeholder = run ? 'Type a command, e.g. say hello or op YourName (no slash needed)' : 'Start the server to send commands'; } document.querySelectorAll('.cmd-row .btn').forEach(b => { b.disabled = !run; }); document.querySelectorAll('.quick button').forEach(b => { if (b.textContent !== 'clear view') b.disabled = snap.state !== 'online'; }); if (run && i) i.focus(); }
    else if (['players', 'settings', 'properties', 'access', 'backups'].includes(S.tab)) renderMain();
    if (snap.state === 'online') { loadProps(snap.id).then(renderHeader); }
  } else if (S.tab === 'players') S.redrawOnline?.();
});
let accessRedraw;
api.on('access:state', ({ id, view }) => {
  S.accessView.set(id, view);
  if (id !== S.selected) return;
  renderHeader();
  if (S.tab === 'access' && !document.querySelector('#modal-root .backdrop')) { clearTimeout(accessRedraw); accessRedraw = setTimeout(renderMain, 150); }
});
api.on('backups:busy', ({ id }) => { if (id === S.selected && S.tab === 'backups') renderMain(); });
api.on('app:select', id => { if (server(id)) { S.tab = 'console'; select(id); } });
api.on('server:stats', ({ id, stats }) => {
  const s = server(id); if (!s) return;
  s.snapshot.stats = stats;
  if (id === S.selected) renderStats();
});

// ---------- boot ----------
// Start only after every <script> (features.js too) has run, or early IPC replies can race it.
async function boot() {
  if (IS_MAC) document.body.classList.add('mac');
  if (IS_WIN) document.body.classList.add('win');
  [S.info, S.software] = await Promise.all([call('app:info'), call('software:list')]);
  await loadServers();
  $('#btn-new').onclick = () => openCreate();
  $('#btn-import').onclick = openImport;
  $('#btn-settings').onclick = openAppSettings;
  renderSidebar();
  if (S.servers.length) await select(S.servers[0].id); else renderMain();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
