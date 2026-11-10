/* Blockyard: Public Access, Backups, Modrinth browser and Automation UI. Uses helpers from app.js. */

// ================= Public Access =================
const METHODS = [
  { id: 'upnp', title: 'Automatic port forwarding', badge: 'Fastest', desc: 'Blockyard asks your router to open the port (UPnP / NAT-PMP). Direct connection, lowest ping, no account.' },
  { id: 'playit', title: 'playit.gg tunnel', badge: 'Works anywhere', desc: 'Free tunnel that works on any internet, even 5G, Starlink and CGNAT. Needs a playit account; adds a little ping.' },
  { id: 'ipv6', title: 'IPv6 (direct)', badge: 'Free, no tunnel', desc: 'Friends connect straight to your IPv6 address. Works on many 5G, Starlink and fibre connections where port forwarding doesn’t. Friends need IPv6 too.' },
  { id: 'manual', title: 'Manual port forwarding', badge: 'DIY', desc: 'Set up the rule in your router yourself. Same speed as automatic, works when UPnP is off.' },
  { id: 'vpn', title: 'Private network', badge: 'Most private', desc: 'Tailscale or ZeroTier. Friends install the same app and join your private network.' },
  { id: 'off', title: 'Home network only', badge: 'Default', desc: 'Only people on your Wi-Fi or LAN can join. Nothing is opened to the internet.' },
];
S.accessView = new Map();
S.testResult = new Map();
S.diagRunning = false;

async function loadAccess(id) {
  try { S.accessView.set(id, await call('access:get', id)); } catch {}
  return S.accessView.get(id);
}

function copyBtn(value, label = 'Copy') {
  return h('button', { class: 'btn sm', text: label, onclick: () => { call('clipboard:write', value); toast(`Copied ${value}`); } });
}

async function renderAccessFull(body, s, opts = {}) {
  const v = await loadAccess(s.id);
  if (!v) return;
  const online = s.snapshot.state === 'online';
  const lan = `${S.info.lan[0]?.address || 'localhost'}${v.port === 25565 ? '' : ':' + v.port}`;
  const set = guard(async patch => { if (patch.method) S.testResult.delete(s.id); S.accessView.set(s.id, await call('access:set', s.id, patch)); renderMain(); });
  const testRaw = S.testResult.get(s.id);
  const test = testRaw && testRaw.method === v.method && Date.now() - (testRaw.at || 0) < 30 * 60e3 ? testRaw : null;

  // --- hero ---
  let heroTitle, heroSub, heroIcon, heroCls = '';
  if (v.publicAddress && v.method !== 'vpn') { heroIcon = '🌍'; heroTitle = 'Friends can join from anywhere'; heroSub = v.publicAddress; heroCls = 'ok'; }
  else if (v.method === 'vpn') { heroIcon = '🔒'; heroTitle = v.tailscale ? 'Friends on your private network can join' : 'Set up Tailscale or ZeroTier below'; heroSub = v.publicAddress || lan; }
  else if (v.method === 'off') { heroIcon = '🏠'; heroTitle = 'Only people on your home network can join'; heroSub = lan; }
  else if (!online) { heroIcon = '⏸'; heroTitle = `${METHODS.find(m => m.id === v.method).title} is ready`; heroSub = 'It switches on when the server is online.'; }
  else { heroIcon = '⚠️'; heroTitle = 'Not reachable from the internet yet'; heroSub = 'Finish the steps below.'; heroCls = 'warn'; }
  const hero = h('div', { class: `card hero ${heroCls}` },
    h('div', { class: 'hero-icon', text: heroIcon }),
    h('div', { class: 'grow' }, h('div', { class: 'hero-title', text: heroTitle }), h('div', { class: `hero-sub${v.publicAddress || heroSub === lan ? ' mono selectable' : ''}`, text: heroSub })),
    (v.publicAddress || v.method === 'off') && copyBtn(v.publicAddress || lan),
    v.method !== 'off' && v.method !== 'vpn' && h('button', {
      class: 'btn sm primary', text: 'Test from Internet', disabled: !online, title: online ? 'Ask an outside service to connect to your server' : 'Start the server first',
      onclick: guard(async e => {
        e.target.disabled = true; e.target.textContent = 'Testing…';
        try { S.testResult.set(s.id, { ...(await call('access:test', s.id)), method: v.method, at: Date.now() }); } catch (err) { S.testResult.set(s.id, { error: err.message, method: v.method, at: Date.now() }); }
        if (S.tab === 'access' && current()?.id === s.id) renderMain();
      }),
    }));
  const testNote = test && (test.error ? h('div', { class: 'note err', text: test.error })
    : test.online ? h('div', { class: 'note' }, `✅ ${test.target} is reachable from the internet (checked by ${test.via}).`)
      : h('div', { class: 'note warn' }, `❌ ${test.via} couldn’t reach ${test.target}. `, v.method === 'upnp' ? 'Your router may have refused, or your internet provider blocks incoming connections (CGNAT). Run the network check below, or switch to playit.gg.' : v.method === 'playit' ? 'Check that the tunnel points to this server’s port and the playit agent is running.' : 'Double-check the router rule, then try again. Results can be cached for about a minute.'));

  // --- method picker ---
  const picker = h('div', { class: 'method-grid' }, METHODS.map(m => h('div', {
    class: `method${v.method === m.id ? ' sel' : ''}`, onclick: () => v.method !== m.id && set({ method: m.id }),
  }, h('div', { class: 'method-top' }, h('span', { class: 'radio' }), h('strong', { text: m.title }), h('span', { class: 'badge', text: m.badge })), h('div', { class: 'method-desc', text: m.desc }))));

  // --- method details ---
  const detail = h('div', { class: 'card detail' });
  const autoToggle = label => h('label', { class: 'check' }, h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: v.auto !== false, onchange: e => set({ auto: e.target.checked }) }), h('span')), h('span', { text: label }));

  if (v.method === 'upnp') {
    const up = v.upnp || {};
    const statusText = { idle: online ? 'Not open' : 'Waiting for the server to start', opening: 'Asking your router…', open: `Open via ${up.info?.via}${up.info?.lifetime ? ' (renews automatically)' : ''}`, error: 'Router said no' }[up.status || 'idle'];
    put(detail,
      h('div', { class: 'kv' }, h('span', { text: 'Status' }), h('strong', { class: up.status === 'open' ? 'good' : up.status === 'error' ? 'bad' : '', text: statusText }),
        up.info?.externalIP && [h('span', { text: 'Public address' }), h('span', { class: 'mono selectable', text: `${up.info.externalIP}:${up.info.externalPort}` })],
        h('span', { text: 'Forwarding to' }), h('span', { class: 'mono', text: `${up.info?.lanIp || v.diag?.lanIp || S.info.lan[0]?.address || '?'}:${v.port}` })),
      up.status === 'error' && h('div', { class: 'note err' }, up.error,
        h('div', { style: { marginTop: '8px', display: 'flex', gap: '6px' } },
          h('button', { class: 'btn sm', text: 'Use playit.gg instead', onclick: () => set({ method: 'playit' }) }),
          h('button', { class: 'btn sm', text: 'Check my network', onclick: () => runDiag(s) }))),
      h('div', { class: 'row-btns' },
        up.status === 'open'
          ? h('button', { class: 'btn', text: 'Close Port', onclick: guard(async () => { S.accessView.set(s.id, await call('access:upnpClose', s.id)); renderMain(); }) })
          : h('button', { class: 'btn primary', text: up.status === 'opening' ? 'Opening…' : 'Open Port Now', disabled: up.status === 'opening' || !online, title: online ? '' : 'Start the server first', onclick: guard(async () => { S.accessView.set(s.id, await call('access:upnpOpen', s.id)); renderMain(); }) }),
        autoToggle('Open automatically whenever this server starts')),
      h('div', { class: 'muted small', text: 'Routers call this UPnP, NAT-PMP or “automatic port forwarding”. Blockyard closes the port again when the server stops or you quit.' }));
  } else if (v.method === 'playit') {
    detail.append(...renderPlayitSteps(s, v, autoToggle));
  } else if (v.method === 'ipv6') {
    const addr = v.ipv6 ? (v.port === 25565 ? `[${v.ipv6}]` : `[${v.ipv6}]:${v.port}`) : null;
    put(detail,
      addr
        ? h('div', { class: 'note' }, `${THIS_PC[0].toUpperCase() + THIS_PC.slice(1)} has a public IPv6 address. Friends join at `, h('strong', { class: 'mono selectable', text: addr }), ' ', copyBtn(addr))
        : h('div', { class: 'note warn', text: 'This network didn’t give your computer a public IPv6 address, so this option can’t work here. Use automatic port forwarding or playit.gg.' }),
      h('ul', { class: 'steps' },
        h('li', null, h('strong', { text: 'Friends need IPv6 too. ' }), 'Most phones on mobile data and many home connections have it. If a friend can’t connect, they may not, so playit.gg is the fallback.'),
        h('li', null, h('strong', { text: 'Some routers block incoming IPv6. ' }), 'If the internet test fails, look for “IPv6 firewall” in your router settings and allow TCP port ', h('span', { class: 'mono', text: String(v.port) }), ` to ${THIS_PC}.`),
        h('li', null, h('strong', { text: 'The address can change ' }), 'when your router restarts. Check here and send friends the new one if it does.')));
  } else if (v.method === 'manual') {
    const d = v.diag;
    const gw = d?.gateway;
    put(detail,
      h('ol', { class: 'steps' },
        h('li', null, h('strong', { text: 'Open your router’s settings. ' }), gw ? ['Usually at ', h('a', { href: '#', text: `http://${gw}`, onclick: e => { e.preventDefault(); call('shell:external', `http://${gw}`).catch(() => toast('Open it in your browser: http://' + gw)); } }), ' (login is often on a sticker on the router).'] : 'Run the network check below to find its address.'),
        h('li', null, h('strong', { text: 'Add a port forwarding rule ' }), '(sometimes under “NAT”, “Virtual server” or “Gaming”):',
          h('div', { class: 'kv rule' },
            h('span', { text: 'Protocol' }), h('span', { class: 'mono', text: 'TCP' }),
            h('span', { text: 'External port' }), h('span', { class: 'mono', text: String(v.port) }),
            h('span', { text: 'Internal IP' }), h('span', null, h('span', { class: 'mono selectable', text: d?.lanIp || S.info.lan[0]?.address || '?' }), ' ', copyBtn(d?.lanIp || S.info.lan[0]?.address || '')),
            h('span', { text: 'Internal port' }), h('span', { class: 'mono', text: String(v.port) }))),
        h('li', null, h('strong', { text: `Give ${THIS_PC} a fixed IP ` }), '(“DHCP reservation” in the router) so the rule keeps working after a restart.'),
        h('li', null, h('strong', { text: 'Test it ' }), 'with “Test from Internet” above while the server is running. Friends join at ',
          d?.publicIP ? h('span', { class: 'mono selectable', text: `${d.publicIP}${v.port === 25565 ? '' : ':' + v.port}` }) : 'your public IP', '.')),
      !d && h('button', { class: 'btn sm', text: 'Find my router and public IP', onclick: () => runDiag(s) }),
      d?.nat === 'cgnat' && h('div', { class: 'note err', text: 'Your internet provider uses CGNAT, so port forwarding can’t work on this connection. Use playit.gg instead.' }));
  } else if (v.method === 'vpn') {
    put(detail,
      v.tailscale
        ? h('div', { class: 'note' }, `Tailscale is running on ${THIS_PC}. Friends on your tailnet join at `, h('strong', { class: 'mono selectable', text: `${v.tailscale}${v.port === 25565 ? '' : ':' + v.port}` }), ' ', copyBtn(`${v.tailscale}${v.port === 25565 ? '' : ':' + v.port}`))
        : h('div', { class: 'note warn', text: `Tailscale isn’t running on ${THIS_PC} (or you’re using ZeroTier: use the IP shown in its menu).` }),
      h('ol', { class: 'steps' },
        h('li', null, 'Install ', h('a', { href: '#', text: 'Tailscale', onclick: e => { e.preventDefault(); call('shell:external', 'https://tailscale.com/download'); } }), ' (free for personal use) or ', h('a', { href: '#', text: 'ZeroTier', onclick: e => { e.preventDefault(); call('shell:external', 'https://www.zerotier.com/download/'); } }), ' on this Mac and sign in.'),
        h('li', null, 'Invite your friends to your network (Tailscale: “Share” this machine; ZeroTier: share your network ID).'),
        h('li', null, `Friends install the same app, join, then connect in Minecraft to ${THIS_PC}’s private IP and port `, h('span', { class: 'mono', text: String(v.port) }), '.')),
      h('div', { class: 'muted small', text: 'Nothing is opened to the public internet, so this is the most private option. Every player needs the app, though.' }));
  } else {
    put(detail, h('div', null, 'People on the same Wi-Fi join at ', h('strong', { class: 'mono selectable', text: lan }), '. Nobody outside your home can see the server. Pick another option above when you want to play with friends elsewhere.'));
  }

  // --- diagnostics ---
  const diag = v.diag;
  const verdict = !diag ? null
    : diag.nat === 'cgnat' ? ['bad', 'CGNAT detected: your internet provider shares one public IP between customers, so port forwarding (automatic or manual) can’t work. Use playit.gg, or ask your provider for a public IPv4 address.']
      : diag.nat === 'double' ? ['warn', 'Double NAT: there are two routers in a row (for example, an ISP modem plus your own router). Port forwarding must be set up on both, or put the ISP modem in bridge mode. playit.gg avoids this.']
        : diag.nat === 'ok' ? ['good', 'You have a public IP address, so port forwarding can work.']
          : ['warn', diag.upnp || diag.natpmp ? 'Couldn’t confirm your router’s public address.' : 'Your router didn’t answer UPnP or NAT-PMP, so automatic forwarding won’t work until you enable it in the router (or use manual forwarding / playit.gg).'];
  const yesNo = b => h('span', { class: b ? 'good' : 'bad', text: b ? 'Available' : 'Not available' });
  const diagCard = h('div', { class: 'card detail' },
    h('div', { class: 'section-head' }, h('h2', { text: 'Network check' }),
      h('button', { class: 'btn sm', text: S.diagRunning ? 'Checking…' : diag ? 'Check Again' : 'Check My Network', disabled: S.diagRunning, onclick: () => runDiag(s) })),
    diag ? [
      h('div', { class: 'kv' },
        h('span', { text: THIS_PC[0].toUpperCase() + THIS_PC.slice(1) }), h('span', { class: 'mono selectable', text: diag.lanIp || '?' }),
        h('span', { text: 'Router' }), h('span', { class: 'mono selectable', text: diag.gateway || '?' }),
        h('span', { text: 'Public IP' }), h('span', { class: 'mono selectable', text: diag.publicIP || 'unknown' }),
        h('span', { text: 'Router’s internet address' }), h('span', { class: 'mono', text: diag.routerIP || 'unknown' }),
        h('span', { text: 'UPnP' }), yesNo(diag.upnp),
        h('span', { text: 'NAT-PMP' }), yesNo(diag.natpmp),
        diag.tailscale && [h('span', { text: 'Tailscale' }), h('span', { class: 'mono', text: diag.tailscale })],
        h('span', { text: 'IPv6' }), diag.ipv6 ? h('span', { class: 'mono selectable good', text: diag.ipv6 }) : h('span', { class: 'muted', text: 'No public IPv6 address' }),
        h('span', { text: IS_MAC ? 'macOS Firewall' : IS_WIN ? 'Windows Firewall' : 'Firewall' }), h('span', { text: diag.firewall === 'on' ? (IS_WIN ? 'On (Java must be allowed: see below)' : 'On (click “Allow” if macOS asks about Java)') : diag.firewall === 'off' ? 'Off' : 'Unknown' })),
      h('div', { class: `note ${verdict[0] === 'good' ? '' : verdict[0] === 'bad' ? 'err' : 'warn'}`, text: verdict[1] }),
    ] : h('div', { class: 'muted small', text: 'Finds your router, public IP, whether automatic forwarding is supported, and whether your provider uses CGNAT.' }));

  if (opts.advanced) put(body, h('h2', { class: 'sub', text: 'Connection method' }), picker, detail, diagCard);
  else put(body, hero, testNote, h('h2', { class: 'sub', text: 'How should friends connect?' }), picker, detail, diagCard);
}

const runDiag = guard(async s => {
  S.diagRunning = true; if (S.tab === 'access') renderMain();
  try { await call('access:diagnose'); await loadAccess(s.id); } finally { S.diagRunning = false; if (S.tab === 'access' && current()?.id === s.id) renderMain(); }
});

function renderPlayitSteps(s, v, autoToggle) {
  const p = v.playit;
  const linking = p.claim && ['waiting_for_visit', 'waiting_for_approval', 'accepted'].includes(p.claim.status);
  const linked = p.installed && p.daemon === 'running' && !p.needsLink && !!p.agentId;
  const tunnel = v.tunnel;
  const step = (n, done, title, content) => h('div', { class: `pstep${done ? ' done' : ''}` }, h('div', { class: 'pnum', text: done ? '✓' : String(n) }), h('div', { class: 'grow' }, h('strong', { text: title }), content && h('div', { class: 'pbody' }, content)));
  const dash = p.loginLink || 'https://playit.gg/account/tunnels';
  const install = guard(async e => {
    e.target.disabled = true;
    const taskId = 'pinst-' + Date.now();
    const off = api.on('task:progress', ev => { if (ev.taskId === taskId) e.target.textContent = ev.message.replace('Downloading the playit agent… ', 'Downloading… '); });
    try { await call('playit:install', taskId); toast('playit agent installed'); } finally { off(); renderMain(); }
  });
  const steps = [
    step(1, p.installed, 'Install the playit agent', p.installed ? h('span', { class: 'muted', text: 'Installed inside Blockyard (open source, from playit.gg’s GitHub).' }) : [h('div', { class: 'muted', text: 'A small download (~15 MB). It runs only while Blockyard needs it.' }), h('button', { class: 'btn sm primary', text: 'Install playit', onclick: install })]),
    step(2, linked, 'Link your playit account', !p.installed ? null
      : linked ? h('span', { class: 'muted', text: p.accountStatus === 'guest' ? 'Linked as a guest account. Open the dashboard to sign up and keep your address forever.' : 'Linked.' })
        : linking ? [h('div', { text: p.claim.status === 'accepted' ? 'Approved. Finishing up…' : 'Approve Blockyard in your browser. A playit.gg page should have opened.' }), h('div', { class: 'row-btns' }, h('button', { class: 'btn sm', text: 'Open the Link Again', onclick: () => call('shell:external', p.claim.url) }), h('button', { class: 'btn sm ghost', text: 'Cancel', onclick: () => call('playit:cancelLink').then(() => renderMain()) }))]
          : [h('div', { class: 'muted', text: 'Opens playit.gg in your browser. Sign in (or continue as guest) and click “Accept”.' }), h('button', { class: 'btn sm primary', text: 'Link Account', onclick: guard(async () => { const t = call('playit:link'); setTimeout(() => renderMain(), 300); await t; toast('playit is linked'); renderMain(); }) })]),
    step(3, !!tunnel?.address, `Tunnel for this server (port ${v.port})`, !linked ? null
      : tunnel?.address ? h('div', null, 'Friends join at ', h('strong', { class: 'mono selectable', text: tunnel.address }), ' ', copyBtn(tunnel.address))
        : [h('div', { class: 'muted', text: 'Creates a free Minecraft Java tunnel pointing at this server.' }), h('div', { class: 'row-btns' },
          h('button', { class: 'btn sm primary', text: 'Create Tunnel', onclick: guard(async e => { e.target.disabled = true; e.target.textContent = 'Creating…'; try { const t = await call('playit:createTunnel', s.id); toast(t.address ? `Tunnel ready: ${t.address}` : 'Tunnel created. Its address will appear in a moment.'); } finally { renderMain(); } }) }),
          h('button', { class: 'btn sm ghost', text: 'Or add it on playit.gg ↗', onclick: () => call('shell:external', dash) }))]),
  ];
  const notices = (p.notices || []).map(n => h('div', { class: 'note warn' }, n.message, n.resolve_link && [' ', h('a', { href: '#', text: 'Fix ↗', onclick: e => { e.preventDefault(); call('shell:external', n.resolve_link); } })]));
  return [
    h('div', { class: 'psteps' }, steps),
    ...notices,
    p.error && !linking && h('div', { class: 'note err', text: p.error }),
    p.installed && h('div', { class: 'row-btns' },
      h('span', { class: 'muted', text: `Agent: ${p.daemon === 'running' ? 'running' : 'stopped'}` }),
      p.daemon === 'running' ? h('button', { class: 'btn sm', text: 'Stop Agent', onclick: () => call('playit:stop').then(() => setTimeout(renderMain, 300)) }) : h('button', { class: 'btn sm', text: 'Start Agent', onclick: guard(async () => { await call('playit:start'); renderMain(); }) }),
      linked && h('button', { class: 'btn sm ghost', text: 'playit Dashboard ↗', onclick: () => call('shell:external', dash) }),
      autoToggle('Start playit with this server')),
  ].filter(Boolean);
}

// ================= Backups =================
const INTERVALS = [[0, 'Off'], [1, 'Every hour'], [3, 'Every 3 hours'], [6, 'Every 6 hours'], [12, 'Every 12 hours'], [24, 'Every day']];
async function renderBackups(body, s) {
  const { items, busy } = await call('backups:list', s.id);
  const b = { intervalHours: 0, keep: 10, scope: 'world', ...(s.backup || {}) };
  const saveSched = guard(async patch => { const u = await call('servers:update', s.id, { backup: { ...b, ...patch } }); Object.assign(s, u, { snapshot: s.snapshot }); toast('Backup schedule saved'); renderMain(); });
  const doBackup = scope => guard(async e => { e.target.disabled = true; e.target.textContent = 'Backing up…'; try { const r = await call('backups:create', s.id, scope); toast(`Backup saved (${fmtBytes(r.size)})`); } finally { renderMain(); } });
  const restore = it => guard(async () => {
    if (isRunning(s)) return toast('Stop the server before restoring a backup.', 'error');
    if (await confirmBox(`Restore the backup from ${fmtDate(it.time)}?`, it.scope === 'world' ? 'Your current world is replaced by the backup. Blockyard backs up the current world first, so you can undo this.' : 'Files in the backup overwrite the current ones. Blockyard backs up the current state first.', ['Restore', 'Cancel'], true) !== 0) return;
    const taskId = 'restore-' + Date.now();
    const status = h('div', { class: 'task-status', text: 'Starting…' });
    const m = modal({ title: 'Restoring backup', size: 'small', body: [status, h('div', { class: 'progress indet' }, h('i'))], dismissable: () => false });
    const off = api.on('task:progress', ev => { if (ev.taskId === taskId) status.textContent = ev.message; });
    try { await call('backups:restore', s.id, it.file, taskId); toast('Backup restored'); } finally { off(); m.close(); renderMain(); }
  });
  const next = b.intervalHours > 0 && s.snapshot.state === 'online' ? `Next scheduled backup within ${b.intervalHours} h while the server runs.` : b.intervalHours > 0 ? 'Scheduled backups run while the server is online.' : '';
  put(body,
    h('div', { class: 'section-head' }, h('h2', { text: `Backups (${items.length})` }),
      h('button', { class: 'btn sm primary', text: busy ? 'Backing up…' : 'Back Up World Now', disabled: busy, onclick: doBackup('world') }),
      h('button', { class: 'btn sm', text: 'Full Backup', title: 'Everything except logs, caches and libraries', disabled: busy, onclick: doBackup('full') }),
      h('button', { class: 'btn sm', text: 'Open Folder', onclick: () => call('backups:reveal', s.id, '') })),
    h('div', { class: 'card detail sched' },
      h('div', { class: 'sched-row' },
        h('label', null, h('strong', { text: 'Automatic backups ' }), h('select', { onchange: e => saveSched({ intervalHours: +e.target.value }) }, INTERVALS.map(([v, t]) => h('option', { value: v, text: t, selected: v === b.intervalHours })))),
        h('label', null, 'Keep the last ', h('input', { type: 'number', min: 1, max: 200, value: b.keep, style: { width: '64px' }, onchange: e => saveSched({ keep: Math.max(1, +e.target.value || 10) }) }), ' scheduled backups'),
        h('label', null, 'Back up ', h('select', { onchange: e => saveSched({ scope: e.target.value }) }, h('option', { value: 'world', text: 'the world', selected: b.scope === 'world' }), h('option', { value: 'full', text: 'everything', selected: b.scope === 'full' })))),
      h('div', { class: 'muted small', text: `${next} Backups are made safely while the server runs (autosave is paused and the world flushed to disk first). Manual backups are never deleted automatically.` })),
    h('div', { class: 'card' }, items.length
      ? h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', { text: 'Date' }), h('th', { text: 'Type' }), h('th', { text: 'Contents' }), h('th', { text: 'Size', style: { textAlign: 'right' } }), h('th'))),
        h('tbody', null, items.map(it => h('tr', null,
          h('td', { text: fmtDate(it.time) }), h('td', { text: it.label }), h('td', { text: it.scope === 'full' ? 'Everything' : 'World' }),
          h('td', { class: 'num', text: fmtBytes(it.size) }),
          h('td', null, h('div', { class: 'row-actions', style: { opacity: 1 } },
            h('button', { class: 'btn sm', text: 'Restore', onclick: restore(it) }),
            h('button', { class: 'btn sm ghost', text: 'Reveal', onclick: () => call('backups:reveal', s.id, it.file) }),
            h('button', { class: 'btn sm ghost danger', text: 'Delete', onclick: guard(async () => { if (await confirmBox('Move this backup to the Trash?', it.file, ['Move to Trash', 'Cancel'], true) === 0) { await call('backups:trash', s.id, it.file); renderMain(); } }) })))))))
      : h('div', { class: 'empty', text: 'No backups yet. Make one now, or turn on automatic backups above.' })));
}

// ================= Modrinth browser =================
S.addonView = 'installed';
S.mr = new Map(); // id -> { query, sort, hits, total, offset, loading, error }

function renderAddonSwitch(body, s, renderInstalled) {
  const kind = s.kind || swInfo(s.software).kind;
  const seg = h('div', { class: 'seg' },
    [['installed', 'Installed'], ['browse', `Browse Modrinth`]].map(([k, t]) => h('button', { class: S.addonView === k ? 'on' : '', text: t, onclick: () => { S.addonView = k; renderMain(); } })));
  body.append(seg);
  if (S.addonView === 'browse') return renderModrinth(body, s, kind);
  body.append(updatesBar(s));
  return renderInstalled();
}

function renderModrinth(body, s, kind) {
  const noun = kind === 'plugins' ? 'plugin' : 'mod';
  const st = S.mr.get(s.id) || { query: '', sort: 'relevance', hits: [], total: 0, offset: 0 };
  S.mr.set(s.id, st);
  const list = h('div', { class: 'mr-list' });
  const more = h('div', { class: 'mr-more' });
  const input = h('input', { type: 'search', placeholder: `Search ${noun}s for ${swInfo(s.software).label} ${s.mcVersion || ''}…`, value: st.query, style: { flex: 1 } });
  const sort = h('select', { onchange: e => { st.sort = e.target.value; load(true); } }, [['relevance', 'Relevance'], ['downloads', 'Most downloads'], ['follows', 'Most followed'], ['newest', 'Newest'], ['updated', 'Recently updated']].map(([v, t]) => h('option', { value: v, text: t, selected: st.sort === v })));
  let timer;
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { st.query = input.value; load(true); }, 350); });
  const fmtNum = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

  function card(hit) {
    const btn = h('button', { class: `btn sm ${hit.installed ? '' : 'primary'}`, text: hit.installed ? 'Installed ✓' : 'Install', disabled: hit.installed });
    btn.onclick = guard(async () => {
      btn.disabled = true; btn.textContent = 'Installing…';
      const taskId = 'mr-' + Date.now();
      const off = api.on('task:progress', ev => { if (ev.taskId === taskId) btn.title = ev.message; });
      try {
        const res = await call('modrinth:install', s.id, hit.id, taskId);
        hit.installed = true; btn.textContent = 'Installed ✓'; btn.classList.remove('primary');
        const extra = res.length > 1 ? ` (+ ${res.slice(1).map(r => r.file).join(', ')})` : '';
        toast(`Installed ${res[0].file}${extra}.${isRunning(s) ? ' Restart the server to load it.' : ''}`);
      } catch (e) { btn.disabled = false; btn.textContent = 'Install'; throw e; } finally { off(); }
    });
    const icon = hit.icon ? h('img', { src: hit.icon, alt: '' }) : h('div', { class: 'ph' });
    if (hit.icon) icon.onerror = () => icon.replaceWith(h('div', { class: 'ph' }));
    return h('div', { class: 'card mr-card' }, icon,
      h('div', { class: 'grow' },
        h('div', { class: 'mr-title' }, h('a', { href: '#', text: hit.title, onclick: e => { e.preventDefault(); call('shell:external', `https://modrinth.com/${kind === 'plugins' ? 'plugin' : 'mod'}/${hit.slug}`); } }), h('span', { class: 'muted', text: ` by ${hit.author}` })),
        h('div', { class: 'mr-desc', text: hit.description }),
        h('div', { class: 'mr-meta' }, `⬇ ${fmtNum(hit.downloads)}`, ...hit.categories.slice(0, 3).map(c => h('span', { class: 'tag', text: c })))),
      btn);
  }
  function draw() {
    clear(list); clear(more);
    if (st.error) list.append(h('div', { class: 'note err', text: st.error }));
    else if (!st.hits.length && !st.loading) list.append(h('div', { class: 'empty', text: st.query ? `No ${noun}s found for “${st.query}” on this version.` : 'Nothing here.' }));
    st.hits.forEach(hit => list.append(card(hit)));
    if (st.loading) more.append(h('div', { class: 'muted', text: 'Loading…' }));
    else if (st.hits.length < st.total) more.append(h('button', { class: 'btn', text: 'Load More', onclick: () => load(false) }));
  }
  async function load(reset) {
    if (reset) { st.offset = 0; st.hits = []; }
    st.loading = true; st.error = null; draw();
    try {
      const r = await call('modrinth:search', s.id, { query: st.query, sort: st.sort, offset: st.offset });
      st.hits = reset ? r.hits : st.hits.concat(r.hits);
      st.total = r.total; st.offset = st.hits.length;
    } catch (e) { st.error = e.message; }
    st.loading = false;
    if (S.addonView === 'browse' && current()?.id === s.id) draw();
  }
  put(body,
    h('div', { class: 'toolbar' }, input, sort),
    !s.mcVersion && h('div', { class: 'note warn', text: 'Set the Minecraft version in Settings so results only show compatible versions.' }),
    kind === 'mods' && h('div', { class: 'note', text: 'Only mods that work on servers are shown. Many mods must also be installed on each player’s game.' }),
    list, more);
  if (!st.hits.length) load(true); else draw();
  setTimeout(() => input.focus(), 0);
}

// ================= Automation (in Settings) =================
function automationSection(s) {
  const a = { restartOnCrash: true, dailyRestart: '', startOnLaunch: false, ...(s.automation || {}) };
  const save = guard(async patch => { const u = await call('servers:update', s.id, { automation: { ...a, ...patch } }); Object.assign(s, u, { snapshot: s.snapshot }); Object.assign(a, patch); toast('Saved'); });
  const sw = (checked, onchange) => h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked, onchange }), h('span'));
  const time = h('input', { type: 'time', value: a.dailyRestart || '04:00', disabled: !a.dailyRestart, onchange: e => save({ dailyRestart: e.target.value }) });
  return [
    h('h2', { text: 'Automation', style: { fontSize: '14px', margin: '30px 0 10px' } }),
    h('div', { class: 'card detail auto' },
      h('div', { class: 'auto-row' }, sw(a.restartOnCrash !== false, e => save({ restartOnCrash: e.target.checked })),
        h('div', null, h('strong', { text: 'Restart automatically if it crashes' }), h('div', { class: 'muted small', text: 'Waits 5 seconds, then starts it again. Pauses after 4 crashes in 10 minutes so a broken server doesn’t loop forever.' }))),
      h('div', { class: 'auto-row' }, sw(!!a.dailyRestart, e => { time.disabled = !e.target.checked; save({ dailyRestart: e.target.checked ? time.value || '04:00' : '' }); }),
        h('div', { class: 'grow' }, h('strong', { text: 'Restart every day at ' }), time, h('div', { class: 'muted small', text: 'Clears memory leaks from plugins and mods. Players are warned in chat 5 minutes and 1 minute before.' }))),
      ...sleepRows(s, a, save, sw),
      h('div', { class: 'auto-row' }, sw(!!a.startOnLaunch, e => save({ startOnLaunch: e.target.checked })),
        h('div', null, h('strong', { text: 'Start when Blockyard opens' }), h('div', { class: 'muted small', text: 'Starts this server as soon as Blockyard opens.' }))),
      h('div', { class: 'auto-row' }, sw(!!s.optimizedFlags, guard(async e => {
        const u = await call('servers:update', s.id, { optimizedFlags: e.target.checked });
        Object.assign(s, u, { snapshot: s.snapshot });
        toast(isRunning(s) ? 'Saved. Restart the server to apply.' : 'Saved.');
      })),
        h('div', null, h('strong', { text: 'Use optimized Java settings' }), h('div', { class: 'muted small', text: 'Aikar’s garbage-collection flags, recommended by Paper. Smoother TPS with fewer lag spikes. Reserves the full memory amount up front.' })))),
  ];
}

/** Server icon shown next to the server in players' multiplayer list (server-icon.png, 64×64). */
function iconSection(s) {
  const img = h('img', { class: 'srv-icon-preview', alt: '' });
  const ph = h('div', { class: 'srv-icon-preview ph', text: '?' });
  const removeBtn = h('button', { class: 'btn sm ghost', text: 'Remove' });
  const show = url => { img.style.display = url ? '' : 'none'; ph.style.display = url ? 'none' : ''; removeBtn.disabled = !url; if (url) img.src = url; };
  show(null);
  call('icon:get', s.id).then(show).catch(() => {});
  removeBtn.onclick = guard(async () => { await call('icon:remove', s.id); show(null); toast('Icon removed'); });
  return [
    h('h2', { text: 'Server icon', style: { fontSize: '14px', margin: '30px 0 10px' } }),
    h('div', { class: 'card detail icon-row' }, img, ph,
      h('div', { class: 'grow' }, h('strong', { text: 'Shown next to your server in the multiplayer list' }),
        h('div', { class: 'muted small', text: 'Pick any picture. Blockyard crops it square and shrinks it to 64×64. Players see it after the next restart.' })),
      h('button', { class: 'btn sm', text: 'Choose Image…', onclick: guard(async () => { const url = await call('icon:set', s.id); if (url) { show(url); toast(isRunning(s) ? 'Icon saved. Restart to show it.' : 'Icon saved.'); } }) }),
      removeBtn),
  ];
}
