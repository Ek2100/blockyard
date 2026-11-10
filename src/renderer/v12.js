/* Blockyard 1.2 UI: onboarding wizard, simple Public Access + Bedrock crossplay, Stats, Worlds,
   log viewer, scheduled commands, Discord notifications, plugin updates, menu & error reporting.
   Uses helpers from app.js and features.js (h, put, call, modal, toast, guard, …). */

// ================= shared helpers =================
function cmpVer(a, b) {
  const p = v => String(v).split(/[-+ ]/)[0].split('.').map(n => parseInt(n, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
  return 0;
}
const isReleaseVer = v => /^\d+(\.\d+)+$/.test(String(v || ''));
function tpsLevel(tps) {
  if (tps == null) return ['', ''];
  if (tps >= 19) return ['good', 'Smooth'];
  if (tps >= 15) return ['warn', 'Some lag'];
  return ['bad', 'Laggy'];
}
function fmtAgo(t) {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) { const d = Math.round(s / 86400); return d === 1 ? 'yesterday' : `${d} days ago`; }
  return new Date(t).toLocaleDateString();
}
const fmtClock = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const switchEl = (checked, onchange, disabled) => h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked, disabled, onchange }), h('span'));
const linkBtn = (text, url) => h('a', { href: '#', text, onclick: e => { e.preventDefault(); call('shell:external', url); } });

/** Run a long main-process task with a progress modal. `run(taskId)` returns the result. */
function runTask({ title, subtitle, run, doneText }) {
  return new Promise((resolve, reject) => {
    const taskId = 't-' + Date.now() + Math.random().toString(16).slice(2);
    const status = h('div', { class: 'task-status', text: 'Starting…' });
    const bar = h('div', { class: 'progress indet' }, h('i'));
    const logBox = h('div', { class: 'task-log selectable small-log' });
    let busy = true;
    const foot = h('div', { class: 'modal-foot-inner' }, h('span', { class: 'muted grow', text: 'This can take a minute.' }));
    const m = modal({ title, subtitle, size: 'small', body: [status, bar, logBox], foot, dismissable: () => !busy });
    const off = api.on('task:progress', ev => {
      if (ev.taskId !== taskId) return;
      status.textContent = ev.message;
      if (ev.pct != null) { bar.classList.remove('indet'); bar.firstChild.style.width = `${Math.round(ev.pct * 100)}%`; }
      if (!/Downloading .*MB$/.test(ev.message)) { logBox.append(ev.message + '\n'); logBox.scrollTop = logBox.scrollHeight; }
    });
    run(taskId).then(r => {
      busy = false; off(); m.close();
      if (doneText) toast(typeof doneText === 'function' ? doneText(r) : doneText);
      resolve(r);
    }, e => {
      busy = false; off();
      status.textContent = 'Something went wrong';
      bar.classList.remove('indet'); bar.firstChild.style.width = '0';
      logBox.before(h('div', { class: 'note err selectable', text: e.message }));
      clear(foot).append(h('span', { class: 'grow' }), h('button', { class: 'btn', text: 'Close', onclick: () => m.close() }));
      reject(e);
    });
  });
}

// ================= Onboarding wizard (New Server) =================
const GOALS = [
  { sw: 'paper', title: 'Plugins', tag: 'Recommended', desc: 'Best for survival with friends. Fast, and works with thousands of plugins (homes, land claims, maps, economy).' },
  { sw: 'fabric', title: 'Mods', tag: 'Fabric', desc: 'Lightweight mod loader for modern mods and performance mods like Lithium.' },
  { sw: 'neoforge', title: 'Big modpacks', tag: 'NeoForge', desc: 'For large modpacks such as All the Mods. Needs more memory.' },
  { sw: 'vanilla', title: 'Pure vanilla', tag: 'Official', desc: 'Exactly like singleplayer, straight from Mojang. No plugins or mods.' },
];
const MORE_SW = [
  { sw: 'purpur', title: 'Purpur', desc: 'Paper plus extra gameplay settings.' },
  { sw: 'forge', title: 'Forge', desc: 'Classic mod loader for older modpacks.' },
];
const CROSSPLAY_SW = new Set(['paper', 'purpur', 'fabric', 'neoforge']);

async function openCreate(opts = {}) {
  const info = S.info = await call('app:info');
  const total = info.totalMemMB;
  const defMem = sw => Math.min(sw === 'neoforge' || sw === 'forge' ? 6144 : 4096, Math.max(2048, Math.floor(total / 4 / 512) * 512));
  const st = {
    step: opts.mode === 'world' ? 'world' : 'start', mode: opts.mode || null,
    world: null, playerChoice: null, player: null, makeOp: true, applySettings: true,
    software: 'paper', version: '', versions: {}, name: uniqueName('My Server'), memory: defMem('paper'),
    audience: 'anywhere', bedrock: false, port: info.suggestedPort, parent: info.defaultParent, eula: false,
  };
  let busy = false;
  const body = h('div', { class: 'wizard' });
  const foot = h('div', { class: 'modal-foot-inner' });
  const m = modal({ title: 'New Server', size: 'wide', body, foot, dismissable: () => !busy });
  const head = $('.modal-head', m.box);
  const setHead = (title, sub) => { put(clear(head), h('h2', { text: title }), sub && h('p', { text: sub })); };

  const STEPS = () => (st.mode === 'world' ? ['start', 'world', 'type', 'play'] : ['start', 'type', 'play']);
  const dots = () => h('div', { class: 'wiz-dots' }, STEPS().map(k => h('span', { class: k === st.step ? 'on' : STEPS().indexOf(k) < STEPS().indexOf(st.step) ? 'done' : '' })));
  const go = step => { st.step = step; draw(); };
  const back = () => { const s = STEPS(); const i = s.indexOf(st.step); if (i > 0) go(s[i - 1]); };
  const next = () => { const s = STEPS(); const i = s.indexOf(st.step); if (i < s.length - 1) go(s[i + 1]); };

  function draw() {
    clear(body); clear(foot);
    ({ start: drawStart, world: drawWorld, type: drawType, play: drawPlay })[st.step]();
  }

  // ---- step 1: what do you want to do? ----
  function drawStart() {
    setHead('New Server', 'What would you like to do?');
    const card = (icon, title, desc, onclick) => h('button', { class: 'choice big', onclick }, h('div', { class: 'choice-icon', text: icon }), h('div', null, h('strong', { text: title }), h('div', { class: 'muted', text: desc })));
    put(body, h('div', { class: 'choice-col' },
      card('✨', 'Start a fresh world', 'A brand-new world. Pick plugins, mods or pure vanilla.', () => { st.mode = 'new'; go('type'); }),
      card('🗺', 'Bring over a singleplayer world', 'Copy a world from your Minecraft saves into a server, inventory included. Your original stays untouched.', () => { st.mode = 'world'; go('world'); }),
      card('📂', 'Use an existing server folder', 'You already have a server on this Mac. Blockyard detects what it is.', () => { m.close(); openImport(); })));
    put(foot, h('span', { class: 'grow' }), h('button', { class: 'btn', text: 'Cancel', onclick: () => m.close() }));
  }

  // ---- step 2 (world mode): pick the world + whose inventory ----
  function drawWorld() {
    setHead('Choose a world', 'Blockyard copies it. The singleplayer world itself is never changed.');
    const nextBtn = h('button', { class: 'btn primary', text: 'Next', disabled: true });
    const chooser = worldChooser(st, ok => { nextBtn.disabled = !ok; });
    put(body, dots(), chooser);
    nextBtn.onclick = guard(async () => {
      nextBtn.disabled = true;
      try { await resolvePlayer(st); } finally { nextBtn.disabled = false; }
      st.name = uniqueName(st.world.name || 'My Server');
      if (st.world.modded) { st.software = 'fabric'; }
      go('type');
    });
    put(foot, h('button', { class: 'btn', text: 'Back', onclick: back }), h('span', { class: 'grow' }), nextBtn);
  }

  // ---- step 3: server type, version, name, memory ----
  function drawType() {
    setHead('What kind of server?', st.mode === 'world' ? `For “${st.world?.name}”${st.world?.version ? ` (Minecraft ${st.world.version})` : ''}` : 'Not sure? Plugins is a great default.');
    const verSel = h('select', { style: { width: '100%' } });
    const verHelp = h('div', { class: 'help' });
    const nextBtn = h('button', { class: 'btn primary', text: 'Next', disabled: true });
    const name = h('input', { type: 'text', value: st.name, style: { width: '100%' }, oninput: e => { st.name = e.target.value; validate(); } });
    const memLabel = h('strong', { text: fmtMem(st.memory) });
    const mem = h('input', { type: 'range', min: 1024, max: Math.max(2048, Math.floor((total * 0.75) / 512) * 512), step: 512, value: st.memory, oninput: e => { st.memory = +e.target.value; memLabel.textContent = fmtMem(st.memory); } });
    const validate = () => { nextBtn.disabled = !(st.version && st.name.trim()); };
    verSel.onchange = () => { st.version = verSel.value; validate(); };

    async function loadVersions() {
      const id = st.software;
      clear(verSel).append(h('option', { text: 'Loading versions…' })); verSel.disabled = true; st.version = ''; validate(); verHelp.textContent = '';
      try {
        let list = st.versions[id] ||= await call('software:versions', id);
        if (st.software !== id) return;
        const wv = st.mode === 'world' && isReleaseVer(st.world?.version) ? st.world.version : null;
        if (wv) list = list.filter(v => cmpVer(v, wv) >= 0);
        if (!list.length) {
          clear(verSel).append(h('option', { text: 'No compatible version' }));
          verHelp.textContent = wv ? `${swInfo(id).label} has no version for Minecraft ${wv} or newer yet. Pick another type.` : 'No versions found.';
          return;
        }
        put(clear(verSel), list.map(v => h('option', { value: v, text: v === wv ? `${v} (same as your world)` : v })));
        st.version = wv && list.includes(wv) ? wv : wv ? list[list.length - 1] : list[0];
        verSel.value = st.version; verSel.disabled = false; validate();
        verHelp.textContent = wv
          ? (st.version === wv ? 'Same version as your world: the safest choice.' : `Your world will be upgraded to ${st.version}. Older versions would damage it, so they're hidden.`)
          : st.mode === 'world' && st.world?.version ? `Your world is from ${st.world.version}. Pick that version or newer.` : 'Players must use the same version to join.';
      } catch (e) {
        clear(verSel).append(h('option', { text: 'Couldn’t load versions' }));
        verHelp.textContent = e.message + ' ';
        verHelp.append(h('button', { class: 'btn sm', text: 'Retry', onclick: () => { delete st.versions[id]; loadVersions(); } }));
      }
    }
    const pick = sw => {
      st.software = sw; st.memory = Math.max(st.memory, defMem(sw)); mem.value = st.memory; memLabel.textContent = fmtMem(st.memory);
      body.querySelectorAll('.goal').forEach(c => c.classList.toggle('sel', c.dataset.sw === sw));
      loadVersions();
    };
    const goal = (g, small) => h('div', { class: `goal${small ? ' small' : ''}${g.sw === st.software ? ' sel' : ''}`, 'data-sw': g.sw, onclick: () => pick(g.sw) },
      swIcon(g.sw), h('div', null, h('div', { class: 'goal-title' }, h('strong', { text: g.title }), g.tag && h('span', { class: 'badge', text: g.tag })), h('div', { class: 'muted small', text: g.desc })));
    const moddedWarn = st.mode === 'world' && st.world?.modded && h('div', { class: 'note warn', text: `This world was played with mods (${(st.world.brands || []).join(', ') || 'modded'}). Pick the same mod loader and add the same mods, or modded blocks will disappear.` });
    put(body, dots(), moddedWarn,
      h('div', { class: 'goal-grid' }, GOALS.map(g => goal(g))),
      h('details', { class: 'more-sw', open: !GOALS.some(g => g.sw === st.software) }, h('summary', { text: 'More server types' }), h('div', { class: 'goal-grid' }, MORE_SW.map(g => goal(g, true)))),
      h('div', { class: 'field-row', style: { marginTop: '14px' } },
        h('div', { class: 'field' }, h('label', { text: 'Minecraft version' }), verSel, verHelp),
        h('div', { class: 'field' }, h('label', { text: 'Server name' }), name)),
      h('div', { class: 'field' }, h('label', null, 'Memory: ', memLabel), mem, h('div', { class: 'help', text: `Your Mac has ${fmtMem(total)}. 4 GB is plenty for a few friends; modpacks want 6–8 GB.` })));
    loadVersions();
    nextBtn.onclick = next;
    put(foot, h('button', { class: 'btn', text: 'Back', onclick: back }), h('span', { class: 'grow' }), nextBtn);
  }

  // ---- step 4: who's playing? ----
  function drawPlay() {
    setHead('Who’s going to play?', 'You can change all of this later in Public Access.');
    const createBtn = h('button', { class: 'btn primary', text: 'Create Server', disabled: !st.eula });
    const crossOK = CROSSPLAY_SW.has(st.software);
    if (!crossOK) st.bedrock = false;
    const aud = (id, icon, title, desc) => h('div', { class: `choice${st.audience === id ? ' sel' : ''}`, onclick: () => { st.audience = id; draw(); } },
      h('span', { class: 'radio' }), h('div', { class: 'choice-icon', text: icon }), h('div', null, h('strong', { text: title }), h('div', { class: 'muted small', text: desc })));
    const port = h('input', { type: 'number', value: st.port, min: 1024, max: 65535, style: { width: '100%' }, oninput: e => { st.port = +e.target.value; } });
    const pathEl = h('div', { class: 'p' });
    const updatePath = () => { const p = `${st.parent}/${st.name.trim()}`; pathEl.textContent = `‎${p}‎`; pathEl.title = p; };
    updatePath();
    put(body, dots(),
      h('div', { class: 'choice-col' },
        aud('anywhere', '🌍', 'Friends anywhere', 'Blockyard opens your router automatically and checks it works. If your internet blocks that, it walks you through a free playit.gg tunnel.'),
        aud('lan', '🏠', 'Only people on my Wi-Fi', 'Nothing is opened to the internet. Great for playing at home.')),
      h('label', { class: `check card bedrock-opt${crossOK ? '' : ' disabled'}` },
        h('input', { type: 'checkbox', checked: st.bedrock, disabled: !crossOK, onchange: e => { st.bedrock = e.target.checked; } }),
        h('div', null, h('strong', { text: 'Let Bedrock players join too' }),
          h('div', { class: 'muted small', text: crossOK ? 'Phones, tablets and Windows join directly; Xbox, PlayStation and Switch need a free helper app. Installs Geyser + Floodgate so nobody needs Java Edition.' : `Not available for ${swInfo(st.software).label}. Use Plugins, Mods (Fabric) or NeoForge for crossplay.` }))),
      h('details', { class: 'more-sw' }, h('summary', { text: 'Advanced: port and location' }),
        h('div', { class: 'field-row', style: { marginTop: '10px' } },
          h('div', { class: 'field' }, h('label', { text: 'Port' }), port, h('div', { class: 'help', text: '25565 is the Minecraft default' })),
          h('div', { class: 'field' }, h('label', { text: 'Location' }), h('div', { class: 'path-pick' }, pathEl,
            h('button', { class: 'btn', text: 'Change…', onclick: async () => { const p = await call('dialog:pickFolder', { title: 'Where should the server folder go?', defaultPath: st.parent, buttonLabel: 'Choose' }); if (p) { st.parent = p; updatePath(); } } }))))),
      h('label', { class: 'check eula' }, h('input', { type: 'checkbox', checked: st.eula, onchange: e => { st.eula = e.target.checked; createBtn.disabled = !st.eula; } }),
        h('span', null, 'I agree to the ', linkBtn('Minecraft EULA', 'https://aka.ms/MinecraftEULA'), ' (required by Mojang)')));
    createBtn.onclick = () => create();
    put(foot, h('button', { class: 'btn', text: 'Back', onclick: back }), h('span', { class: 'grow' }), createBtn);
  }

  // ---- create + done ----
  async function create() {
    if (!(st.port >= 1 && st.port <= 65535)) return toast('Pick a port between 1 and 65535.', 'error');
    busy = true;
    setHead(`Setting up ${st.name.trim()}`, 'Downloading the server and the right Java. This can take a minute.');
    const status = h('div', { class: 'task-status', text: 'Starting…' });
    const bar = h('div', { class: 'progress indet' }, h('i'));
    const logBox = h('div', { class: 'task-log selectable' });
    clear(body).append(status, bar, logBox); clear(foot);
    const taskId = 'create-' + Date.now();
    const off = api.on('task:progress', ev => {
      if (ev.taskId !== taskId) return;
      if (!ev.verbose) status.textContent = ev.message;
      if (ev.pct != null) { bar.classList.remove('indet'); bar.firstChild.style.width = `${Math.round(ev.pct * 100)}%`; } else if (!/Downloading/.test(ev.message)) bar.classList.add('indet');
      if (!/Downloading .*MB$/.test(ev.message) || ev.pct === 1) { logBox.append(ev.message + '\n'); logBox.scrollTop = logBox.scrollHeight; }
    });
    const say = msg => { status.textContent = msg; logBox.append(msg + '\n'); };
    const warnings = [];
    let created;
    try {
      created = await call('servers:create', { name: st.name.trim(), software: st.software, mcVersion: st.version, parentDir: st.parent, port: st.port, memoryMB: st.memory, eula: st.eula }, taskId);
      S.servers.push(created);
      if (st.mode === 'world') {
        say(`Copying “${st.world.name}” into the server…`);
        const r = await call('worlds:importSave', created.id, { worldDir: st.world.dir, targetName: 'world', player: st.player, makeOp: st.player && st.makeOp, setActive: true, applySettings: st.applySettings });
        say(r.playerMoved ? `World copied. ${st.player.name}'s inventory and position came along.` : 'World copied.');
      }
      if (st.audience === 'anywhere') await call('access:set', created.id, { method: 'upnp', auto: true });
      if (st.bedrock) {
        say('Setting up Bedrock crossplay (Geyser + Floodgate)…');
        try { await call('geyser:install', created.id, taskId); } catch (e) { warnings.push(`Bedrock crossplay couldn’t be set up: ${e.message} You can try again in Public Access.`); }
      }
      Object.assign(created, (await call('servers:list')).find(x => x.id === created.id) || {});
      const i = S.servers.findIndex(x => x.id === created.id); if (i >= 0) S.servers[i] = created;
    } catch (e) {
      off(); busy = false;
      status.textContent = 'Something went wrong';
      bar.classList.remove('indet'); bar.firstChild.style.width = '0';
      body.prepend(h('div', { class: 'note err selectable', text: e.message }));
      put(foot, h('span', { class: 'grow' }), h('button', { class: 'btn', text: 'Close', onclick: () => m.close() }), h('button', { class: 'btn primary', text: 'Back', onclick: () => go('play') }));
      if (created) { renderSidebar(); }
      return;
    }
    off(); busy = false;
    renderSidebar();
    drawDone(created, warnings);
  }

  function drawDone(created, warnings) {
    setHead('Your server is ready 🎉', null);
    const lan = `${S.info.lan[0]?.address || 'localhost'}${st.port === 25565 ? '' : ':' + st.port}`;
    clear(body).append(
      ...warnings.map(w => h('div', { class: 'note warn', text: w })),
      h('div', { class: 'done-grid' },
        h('div', { class: 'card done-card' }, h('div', { class: 'done-k', text: 'You (on this Mac)' }), h('div', { class: 'mono big', text: st.port === 25565 ? 'localhost' : `localhost:${st.port}` })),
        h('div', { class: 'card done-card' }, h('div', { class: 'done-k', text: 'Friends on your Wi-Fi' }), h('div', { class: 'mono big selectable', text: lan })),
        h('div', { class: 'card done-card' }, h('div', { class: 'done-k', text: 'Friends anywhere' }),
          h('div', { text: st.audience === 'anywhere' ? 'Start the server: your public address appears in Public Access once Blockyard has opened your router.' : 'Turn on “Friends anywhere” in Public Access whenever you like.' }))),
      st.bedrock && !warnings.length && h('div', { class: 'note', text: `Bedrock players add a server with the same address and port ${created.crossplay?.port || 19132} (also shown in Public Access).` }),
      h('div', { class: 'muted small', text: 'In Minecraft: Multiplayer → Add Server → paste the address. Start the server first!' }));
    clear(foot).append(h('button', { class: 'btn', text: 'Close', onclick: () => { m.close(); S.tab = 'console'; select(created.id); } }), h('span', { class: 'grow' }),
      h('button', { class: 'btn primary', text: '▶  Start Server', onclick: guard(async () => { m.close(); S.tab = 'console'; await select(created.id); await call('server:start', created.id); }) }));
  }
  draw();
}

/** The singleplayer-world list + "whose inventory" options. Used by the wizard and the Worlds tab. */
function worldChooser(st, onValid) {
  const wrap = h('div', { class: 'world-chooser' });
  const listEl = h('div', { class: 'world-list' }, h('div', { class: 'muted', style: { padding: '14px' }, text: 'Looking for your worlds…' }));
  const opts = h('div', { class: 'world-opts' });
  let accounts = [];
  const valid = () => onValid(!!st.world && !st.world.error && (st.playerChoice !== 'other' || /^[A-Za-z0-9_]{3,16}$/.test(st.otherName || '')));

  async function load(dir) {
    clear(listEl).append(h('div', { class: 'muted', style: { padding: '14px' }, text: 'Looking for your worlds…' }));
    let worlds = [];
    try { worlds = await call('worlds:saves', dir || null); } catch (e) { toast(e.message, 'error'); }
    clear(listEl);
    if (!worlds.length) {
      listEl.append(h('div', { class: 'empty' }, dir ? 'No Minecraft worlds in that folder.' : 'No singleplayer worlds found in the standard Minecraft folder. If you use another launcher (Prism, CurseForge, Modrinth App…), choose its saves folder below.'));
    }
    for (const w of worlds) {
      const row = h('div', { class: `world-row${st.world?.dir === w.dir ? ' sel' : ''}${w.error ? ' broken' : ''}`, onclick: () => {
        if (w.error) return toast(w.error, 'error');
        st.world = w;
        st.makeOp = !!w.cheats; // singleplayer cheats on ≈ operator on the server
        listEl.querySelectorAll('.world-row').forEach(r => r.classList.toggle('sel', r === row));
        drawOpts(); valid();
      } },
      w.icon ? h('img', { class: 'world-icon', src: w.icon, alt: '' }) : h('div', { class: 'world-icon ph', text: '🌍' }),
      h('div', { class: 'grow' }, h('strong', { text: w.name }),
        h('div', { class: 'muted small', text: w.error || [w.version && `Minecraft ${w.version}`, w.gameMode && w.gameMode[0].toUpperCase() + w.gameMode.slice(1), w.hardcore && 'Hardcore', w.modded && 'Modded', `played ${fmtAgo(w.lastPlayed)}`].filter(Boolean).join(' · ') })));
      listEl.append(row);
    }
  }
  function drawOpts() {
    clear(opts);
    if (!st.world) return;
    const sel = h('select', { onchange: e => { st.playerChoice = e.target.value; drawOpts(); valid(); } },
      accounts.map(a => h('option', { value: a.uuid, text: `${a.name} (signed in to Minecraft on this Mac)`, selected: st.playerChoice === a.uuid })),
      h('option', { value: 'other', text: 'Someone else (type their name)…', selected: st.playerChoice === 'other' }),
      h('option', { value: 'none', text: 'Nobody: everyone starts fresh', selected: st.playerChoice === 'none' }));
    put(opts,
      st.world.hasPlayer && h('div', { class: 'field' }, h('label', { text: 'Whose inventory and position should come along?' }), sel,
        st.playerChoice === 'other' && h('input', { type: 'text', placeholder: 'Minecraft username', value: st.otherName || '', oninput: e => { st.otherName = e.target.value.trim(); valid(); } }),
        h('div', { class: 'help', text: 'In singleplayer your items are stored inside the world. Blockyard moves them to your account so you spawn where you left off.' })),
      st.playerChoice !== 'none' && st.world.hasPlayer && h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.makeOp, onchange: e => { st.makeOp = e.target.checked; } }), h('span', { text: 'Make them an operator (admin), like cheats in singleplayer' })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.applySettings, onchange: e => { st.applySettings = e.target.checked; } }),
        h('span', { text: `Use the world’s settings (${[st.world.gameMode, st.world.difficulty, st.world.hardcore && 'hardcore'].filter(Boolean).join(', ') || 'game mode, difficulty'})` })));
  }
  put(wrap, listEl,
    h('div', { class: 'row-btns' },
      h('button', { class: 'btn sm', text: 'Choose Another Folder…', onclick: async () => { const d = await call('dialog:pickFolder', { title: 'Choose a saves folder or a world folder', buttonLabel: 'Choose' }); if (d) load(d); } }),
      h('button', { class: 'btn sm ghost', text: 'Refresh', onclick: () => load() })),
    opts);
  call('worlds:accounts').then(a => {
    accounts = a || [];
    if (!st.playerChoice) st.playerChoice = accounts[0]?.uuid || 'other';
    drawOpts(); valid();
  }).catch(() => { st.playerChoice ||= 'other'; });
  load();
  return wrap;
}
/** Turn the chooser's selection into { uuid, name } (Mojang lookup for typed names). */
async function resolvePlayer(st) {
  if (!st.world?.hasPlayer || st.playerChoice === 'none') { st.player = null; return; }
  if (st.playerChoice === 'other') { st.player = await call('worlds:lookup', st.otherName); return; }
  const acc = (await call('worlds:accounts')).find(a => a.uuid === st.playerChoice);
  st.player = acc || null;
}

// ================= Public Access (simple) =================
S.autoTested = new Set();
async function renderAccessSimple(body, s) {
  const v = await loadAccess(s.id);
  if (!v) return;
  const online = s.snapshot.state === 'online';
  const lanIp = S.info.lan[0]?.address || 'localhost';
  const lanAddr = `${lanIp}${v.port === 25565 ? '' : ':' + v.port}`;
  const anywhere = v.method !== 'off';
  const set = guard(async patch => { if (patch.method) S.testResult.delete(s.id); S.accessView.set(s.id, await call('access:set', s.id, patch)); renderMain(); });

  // Automatic outside test, once per server start, as soon as there's something to test.
  const test = S.testResult.get(s.id);
  const testFresh = test && test.method === v.method && Date.now() - test.at < 30 * 60e3 ? test : null;
  const testable = online && ((v.method === 'upnp' && v.upnp?.status === 'open') || (v.method === 'playit' && v.tunnel?.address) || v.method === 'manual');
  const key = `${s.id}:${v.method}:${s.snapshot.startedAt}`;
  if (testable && !testFresh && !S.autoTested.has(key)) {
    S.autoTested.add(key);
    call('access:test', s.id).then(r => S.testResult.set(s.id, { ...r, method: v.method, at: Date.now() }), e => S.testResult.set(s.id, { error: e.message, method: v.method, at: Date.now() }))
      .finally(() => { if (S.tab === 'access' && current()?.id === s.id) renderMain(); });
  }
  const testing = testable && !testFresh && S.autoTested.has(key);

  // ---- who can join ----
  const who = (id, icon, title, desc) => h('div', { class: `choice${(id === 'anywhere') === anywhere ? ' sel' : ''}`, onclick: () => { if ((id === 'anywhere') !== anywhere) set({ method: id === 'anywhere' ? 'upnp' : 'off', auto: true }); } },
    h('span', { class: 'radio' }), h('div', { class: 'choice-icon', text: icon }), h('div', null, h('strong', { text: title }), h('div', { class: 'muted small', text: desc })));

  // ---- the address to share ----
  let shareTitle, shareAddr, shareNote, shareCls = '';
  if (!anywhere) { shareTitle = 'Friends on your Wi-Fi join at'; shareAddr = lanAddr; shareNote = 'People outside your home can’t see this server.'; }
  else if (v.publicAddress && (!testFresh || testFresh.online !== false)) { shareTitle = 'Give friends this address'; shareAddr = v.publicAddress; shareCls = testFresh?.online ? 'ok' : ''; shareNote = testFresh?.online ? `✅ Checked from the internet by ${testFresh.via}.` : testing ? 'Checking it works from the internet…' : online ? '' : 'Works while the server is running.'; }
  else if (!online) { shareTitle = 'Start the server to get your public address'; shareAddr = null; shareNote = 'Blockyard opens your router and tests it automatically when the server starts.'; }
  else { shareTitle = 'Not reachable from the internet yet'; shareAddr = null; shareCls = 'warn'; shareNote = 'See what to do below.'; }
  const share = h('div', { class: `card hero ${shareCls}` },
    h('div', { class: 'hero-icon', text: !anywhere ? '🏠' : shareCls === 'warn' ? '⚠️' : '🌍' }),
    h('div', { class: 'grow' }, h('div', { class: 'hero-title', text: shareTitle }), shareAddr && h('div', { class: 'hero-addr mono selectable', text: shareAddr }), shareNote && h('div', { class: 'muted small', text: shareNote })),
    shareAddr && copyBtn(shareAddr, 'Copy Address'));

  // ---- checklist for "anywhere" ----
  let checklist = null;
  if (anywhere) {
    const row = (state, title, content) => h('div', { class: `check-row ${state}` }, h('span', { class: 'check-dot', text: state === 'done' ? '✓' : state === 'fail' ? '!' : state === 'busy' ? '…' : '•' }), h('div', { class: 'grow' }, h('strong', { text: title }), content && h('div', { class: 'muted small' }, content)));
    const items = [row(online ? 'done' : 'todo', online ? 'Server is running' : 'Start the server', !online && 'Everything below happens automatically once it’s online.')];
    if (v.method === 'upnp') {
      const up = v.upnp || {};
      const stt = up.status === 'open' ? 'done' : up.status === 'error' ? 'fail' : up.status === 'opening' ? 'busy' : 'todo';
      items.push(row(stt, { open: `Router opened port ${v.port} automatically`, error: 'Your router didn’t allow automatic setup', opening: 'Asking your router to open the port…', idle: 'Open the port on your router' }[up.status || 'idle'],
        up.status === 'error' ? [up.error, h('div', { class: 'row-btns' }, h('button', { class: 'btn sm primary', text: 'Use playit.gg instead (free)', onclick: () => set({ method: 'playit' }) }), h('button', { class: 'btn sm', text: 'Try Again', disabled: !online, onclick: guard(async () => { S.accessView.set(s.id, await call('access:upnpOpen', s.id)); renderMain(); }) }))]
          : up.status === 'idle' && online ? h('button', { class: 'btn sm', text: 'Open Port Now', onclick: guard(async () => { S.accessView.set(s.id, await call('access:upnpOpen', s.id)); renderMain(); }) }) : null));
    } else if (v.method === 'playit') {
      items.push(row(v.tunnel?.address ? 'done' : 'todo', 'playit.gg tunnel', v.tunnel?.address ? `Tunnel ready: ${v.tunnel.address}` : 'Follow the steps below. It takes about two minutes, once.'));
    } else {
      items.push(row('done', `Using ${METHODS.find(x => x.id === v.method)?.title || v.method}`, 'Set up under Advanced below.'));
    }
    if (v.method !== 'vpn') {
      const tstate = testFresh ? (testFresh.online ? 'done' : 'fail') : testing ? 'busy' : 'todo';
      items.push(row(tstate, testFresh?.online ? 'Reachable from the internet' : testFresh ? 'The internet test couldn’t reach your server' : testing ? 'Testing from the internet…' : 'Test from the internet',
        [testFresh && !testFresh.online && (testFresh.error || (v.method === 'upnp' ? 'Your internet provider may block incoming connections (common on 4G/5G, Starlink and some fibre plans). playit.gg works around this.' : 'Check the tunnel or router rule, then test again.')),
          testFresh && !testFresh.online && v.method === 'upnp' && h('div', { class: 'row-btns' }, h('button', { class: 'btn sm primary', text: 'Switch to playit.gg', onclick: () => set({ method: 'playit' }) })),
          online && !testing && h('button', { class: 'btn sm', text: testFresh ? 'Test Again' : 'Test Now', onclick: guard(async e => {
            e.target.disabled = true; e.target.textContent = 'Testing…';
            try { S.testResult.set(s.id, { ...(await call('access:test', s.id)), method: v.method, at: Date.now() }); } catch (err) { S.testResult.set(s.id, { error: err.message, method: v.method, at: Date.now() }); }
            renderMain();
          }) })].filter(Boolean)));
    }
    checklist = h('div', { class: 'card checklist' }, items);
  }
  const playitBox = anywhere && v.method === 'playit' && h('div', { class: 'card detail' }, renderPlayitSteps(s, v, label => h('label', { class: 'check' }, switchEl(v.auto !== false, e => set({ auto: e.target.checked })), h('span', { text: label }))));

  const bedrockBox = h('div', { class: 'card detail bedrock' }, h('div', { class: 'muted', text: 'Loading Bedrock crossplay…' }));
  renderBedrock(bedrockBox, s, v).catch(e => { clear(bedrockBox).append(h('div', { class: 'note err', text: e.message })); });

  const adv = h('details', { class: 'adv access-adv', open: S.accessAdvOpen || ['manual', 'vpn'].includes(v.method), ontoggle: e => { S.accessAdvOpen = e.target.open; } },
    h('summary', { text: 'Advanced: other connection methods and network check' }));
  const advBody = h('div', { style: { marginTop: '10px' } });
  adv.append(advBody);
  renderAccessFull(advBody, s, { advanced: true });

  put(body,
    h('h2', { class: 'sub', text: 'Who can join?' }),
    h('div', { class: 'choice-row' },
      who('lan', '🏠', 'Only my Wi-Fi', 'Nothing is opened to the internet.'),
      who('anywhere', '🌍', 'Friends anywhere', 'Automatic: opens your router, tests it, falls back to playit.gg if needed.')),
    share, checklist, playitBox,
    h('h2', { class: 'sub', text: 'Bedrock crossplay' }), bedrockBox,
    adv);
}

async function renderBedrock(box, s, v) {
  const b = await call('geyser:status', s.id);
  const online = s.snapshot.state === 'online';
  const lanIp = S.info.lan[0]?.address || 'localhost';
  clear(box);
  if (!b.supported) {
    put(box, h('div', { class: 'muted' }, `Bedrock players (phones, consoles, Windows) can’t join ${swInfo(s.software).label} servers. Crossplay needs Paper, Purpur, Fabric or NeoForge.`));
    return;
  }
  if (!b.installed.geyser && !b.installed.floodgate) {
    put(box,
      h('div', { class: 'bedrock-intro' }, h('div', { class: 'hero-icon', text: '📱' }), h('div', { class: 'grow' }, h('strong', { text: 'Let Bedrock players join' }),
        h('div', { class: 'muted small', text: 'Friends on phones, tablets, Windows, Xbox, PlayStation and Switch can join this Java server. Installs Geyser + Floodgate; they don’t need to own Java Edition.' })),
      h('button', { class: 'btn primary', text: 'Set Up Crossplay', onclick: guard(async () => {
        await runTask({ title: 'Setting up Bedrock crossplay', subtitle: 'Geyser + Floodgate', run: taskId => call('geyser:install', s.id, taskId), doneText: isRunning(s) ? 'Crossplay installed. Restart the server to turn it on.' : 'Crossplay installed.' });
        renderMain();
      }) })));
    return;
  }
  const enabled = b.enabled;
  const status = !enabled ? ['muted', 'Off'] : !online ? ['muted', 'Starts with the server'] : b.ready ? ['good', `Ready on port ${b.port} (UDP)`] : ['warn', isRunning(s) ? 'Restart the server to start Geyser' : 'Starting…'];
  const portInput = h('input', { type: 'number', value: b.port, min: 1024, max: 65535, style: { width: '110px' } });
  const pub = b.publicAddress;
  put(box,
    h('div', { class: 'bedrock-intro' }, switchEl(enabled, guard(async e => { await call('geyser:setEnabled', s.id, e.target.checked); toast(isRunning(s) ? 'Saved. Restart the server to apply.' : 'Saved.'); renderMain(); })),
      h('div', { class: 'grow' }, h('strong', { text: 'Bedrock players can join' }), h('div', { class: `small ${status[0]}`, text: status[1] }))),
    enabled && h('div', { class: 'kv' },
      h('span', { text: 'On your Wi-Fi' }), h('span', null, h('span', { class: 'mono selectable', text: lanIp }), '  port ', h('span', { class: 'mono', text: String(b.port) })),
      v.method !== 'off' && [h('span', { text: 'From anywhere' }), pub ? h('span', null, h('span', { class: 'mono selectable', text: pub }), ' ', copyBtn(pub)) : h('span', { class: 'muted', text: v.method === 'upnp' ? (b.upnpError ? `Router refused the Bedrock port: ${b.upnpError}` : !online ? 'Appears when the server is running' : b.ready ? 'Opening the Bedrock port…' : 'Opens after the next restart') : v.method === 'playit' ? 'Needs a Bedrock tunnel' : 'Forward this UDP port the same way as Java' })],
      h('span', { text: 'Bedrock port' }), h('span', { class: 'row' }, portInput, h('button', { class: 'btn sm', text: 'Save', onclick: guard(async () => { await call('geyser:setPort', s.id, portInput.value); toast('Bedrock port saved. Restart to apply.'); renderMain(); }) }))),
    enabled && v.method === 'playit' && !b.tunnel && h('div', { class: 'row-btns' }, h('button', { class: 'btn sm primary', text: 'Create Bedrock Tunnel', onclick: guard(async e => { e.target.disabled = true; await call('geyser:createTunnel', s.id); toast('Bedrock tunnel created'); renderMain(); }) })),
    enabled && h('div', { class: 'muted small' }, 'Phones, tablets and Windows: Play → Servers → Add Server, and enter the address and port. Xbox, PlayStation and Switch can’t add servers directly; friends there can use the free ', linkBtn('BedrockTogether', 'https://bedrocktogether.net'), ' app or ', linkBtn('MCXboxBroadcast', 'https://github.com/MCXboxBroadcast/Broadcaster'), '.'),
    enabled && h('div', { class: 'muted small' }, 'Bedrock usernames show up with a “.” in front (for example .Steve) so they never clash with Java players.'));
}

// ================= Stats tab =================
S.statsRange = S.statsRange || 3600e3;
let statsTimer = null;
async function renderStatsTab(body, s) {
  clearInterval(statsTimer);
  let d;
  try { d = await call('stats:get', s.id); } catch (e) { put(body, h('div', { class: 'note err', text: e.message })); return; }
  const snap = s.snapshot;
  const m = snap.metrics; const fresh = m?.at && Date.now() - m.at < 60000;
  const tps = snap.state === 'online' && fresh ? m.tps : null;
  const mspt = snap.state === 'online' && fresh ? m.mspt : null;
  const [lvl, lvlText] = tpsLevel(tps);
  const tile = (k, v, sub, cls) => h('div', { class: 'card tile' }, h('div', { class: 'k', text: k }), h('div', { class: `v ${cls || ''}`, text: v }), sub && h('div', { class: 'muted small', text: sub }));
  const worldTile = tile('World size', '…', 'all worlds');
  call('stats:worldSize', s.id).then(n => { $('.v', worldTile).textContent = n ? fmtBytes(n) : '–'; }).catch(() => {});
  const noTps = d.supportsTps === 'none';
  const tiles = h('div', { class: 'tiles' },
    tile('TPS', tps == null ? '–' : tps.toFixed(1), noTps ? 'Needs Minecraft 1.20.3+ or Paper' : tps == null ? (snap.state === 'online' ? 'Measuring…' : 'Server offline') : `${lvlText} · 20 is perfect`, lvl),
    tile('Tick time', mspt == null ? '–' : `${mspt.toFixed(1)} ms`, 'Under 50 ms keeps up'),
    tile('Players', snap.state === 'online' ? String(snap.players.length) : '–', d.peak?.count ? `Peak ${d.peak.count} · ${fmtAgo(d.peak.at)}` : 'No peak yet'),
    tile('Total uptime', (d.uptimeMs || snap.startedAt) ? fmtDur((d.uptimeMs || 0) + (snap.startedAt ? Date.now() - snap.startedAt : 0)) : '–', `${d.starts} start${d.starts === 1 ? '' : 's'} · ${d.crashes} crash${d.crashes === 1 ? '' : 'es'}`),
    worldTile);

  const range = h('div', { class: 'seg' }, [[15 * 60e3, '15 min'], [3600e3, '1 hour'], [6 * 3600e3, '6 hours']].map(([ms, t]) => h('button', { class: S.statsRange === ms ? 'on' : '', text: t, onclick: () => { S.statsRange = ms; renderMain(); } })));
  const charts = h('div', { class: 'chart-grid' });
  const defs = [
    { key: 'tps', title: 'TPS', fmt: v => v.toFixed(1), yMax: 20, ref: 20, refLabel: 'perfect', hide: noTps },
    { key: 'mspt', title: 'Tick time (ms)', fmt: v => `${v.toFixed(1)} ms`, ref: 50, refLabel: '50 ms budget', minMax: 60, hide: noTps },
    { key: 'cpu', title: 'CPU (%)', fmt: v => `${Math.round(v)}%`, minMax: 100 },
    { key: 'mem', title: 'Memory', fmt: v => fmtMem(Math.round(v)), yMax: s.memoryMB || 2048, ref: s.memoryMB || 2048, refLabel: 'limit' },
    { key: 'players', title: 'Players online', fmt: v => String(Math.round(v)), minMax: 4, step: true },
  ].filter(x => !x.hide);
  const draws = [];
  for (const def of defs) { const c = lineChart(def); charts.append(c.el); draws.push(c.draw); }
  const drawAll = data => { const pts = data.filter(p => p.t >= Date.now() - S.statsRange); for (const dr of draws) dr(pts, S.statsRange); };

  const players = d.players || [];
  const table = players.length
    ? h('table', { class: 'table' }, h('thead', null, h('tr', null, ['Player', 'Status', 'Playtime', 'Sessions', 'First seen', 'Last seen'].map((t, i) => h('th', { text: t, style: i >= 2 ? { textAlign: 'right' } : null })))),
      h('tbody', null, players.map(p => {
        const img = h('img', { class: 'avatar-sm', src: `https://mc-heads.net/avatar/${encodeURIComponent(p.uuid || p.name)}/20`, alt: '' });
        img.onerror = () => img.replaceWith(h('span', { class: 'avatar-sm ph' }));
        return h('tr', null,
          h('td', { class: 'name' }, img, ' ', h('span', { class: 'selectable', text: p.name })),
          h('td', null, h('span', { class: `dot ${p.online ? 'online' : 'stopped'}` }), ' ', p.online ? 'Online' : 'Offline'),
          h('td', { class: 'num', text: fmtDur(p.playtimeMs || 0) }), h('td', { class: 'num', text: String(p.sessions || 0) }),
          h('td', { class: 'num', text: fmtAgo(p.firstSeen) }), h('td', { class: 'num', text: p.online ? 'now' : fmtAgo(p.lastSeen) }));
      })))
    : h('div', { class: 'empty', text: 'Nobody has joined yet. Players appear here with their playtime once they join.' });

  put(body,
    tiles,
    h('div', { class: 'section-head', style: { marginTop: '18px' } }, h('h2', { text: 'Performance' }), range),
    noTps && h('div', { class: 'note warn', text: `TPS can’t be measured on ${swInfo(s.software).label} ${s.mcVersion || ''}: vanilla added the tick command in 1.20.3. Paper and Purpur report it on every version.` }),
    charts,
    h('div', { class: 'muted small', style: { margin: '6px 0 18px' }, text: 'Sampled every 10 seconds while the server runs. History covers the last 6 hours this app has been open.' }),
    h('div', { class: 'section-head' }, h('h2', { text: `Players (${players.length})` }),
      h('button', { class: 'btn sm ghost', text: 'Reset Stats', onclick: guard(async () => { if (await confirmBox('Reset this server’s statistics?', 'Playtime, peaks, starts and crashes are cleared. The world isn’t touched.', ['Reset', 'Cancel'], true) === 0) { await call('stats:reset', s.id); renderMain(); } }) })),
    h('div', { class: 'card' }, table));
  requestAnimationFrame(() => drawAll(d.series || []));
  statsTimer = setInterval(async () => {
    if (S.tab !== 'stats' || current()?.id !== s.id || !document.body.contains(charts)) return clearInterval(statsTimer);
    try { const nd = await call('stats:get', s.id); drawAll(nd.series || []); } catch {}
  }, 10000);
}

/** Single-series SVG line chart with recessive grid, reference line and crosshair tooltip. */
function lineChart({ title, fmt, yMax, minMax = 1, ref, refLabel, step, key }) {
  const latest = h('span', { class: 'chart-latest' });
  const svgWrap = h('div', { class: 'chart-plot' });
  const tip = h('div', { class: 'chart-tip' });
  const el = h('div', { class: 'card chart' }, h('div', { class: 'chart-head' }, h('strong', { text: title }), latest), svgWrap, tip);
  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
  let state = null;
  function draw(points, rangeMs) {
    const W = Math.max(240, svgWrap.clientWidth || 300), H = 150, L = 44, R = 10, T = 10, B = 22;
    const now = Date.now(), t0 = now - rangeMs;
    const vals = points.map(p => p[key]).filter(v => v != null);
    const top = yMax || Math.max(minMax, Math.max(0, ...vals) * 1.15);
    const niceTop = yMax || (top <= 5 ? Math.ceil(top) : top <= 20 ? Math.ceil(top / 5) * 5 : Math.ceil(top / 10) * 10);
    const x = t => L + ((t - t0) / rangeMs) * (W - L - R);
    const y = v => T + (1 - v / niceTop) * (H - T - B);
    const svg = mk('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': `${title} over the last ${Math.round(rangeMs / 60000)} minutes` });
    for (let i = 0; i <= 3; i++) {
      const v = (niceTop / 3) * i, yy = y(v);
      svg.append(mk('line', { x1: L, x2: W - R, y1: yy, y2: yy, class: 'grid' }));
      const tl = mk('text', { x: L - 6, y: yy + 3.5, class: 'axis', 'text-anchor': 'end' }); tl.textContent = fmt(v).replace(/ ms$/, ''); svg.append(tl);
    }
    for (const t of [t0, t0 + rangeMs / 2, now]) {
      const tl = mk('text', { x: Math.min(W - R, Math.max(L, x(t))), y: H - 6, class: 'axis', 'text-anchor': t === t0 ? 'start' : t === now ? 'end' : 'middle' }); tl.textContent = t === now ? 'now' : fmtClock(t); svg.append(tl);
    }
    if (ref != null && ref <= niceTop) {
      svg.append(mk('line', { x1: L, x2: W - R, y1: y(ref), y2: y(ref), class: 'ref' }));
      const rl = mk('text', { x: W - R - 2, y: y(ref) - 4, class: 'axis ref-label', 'text-anchor': 'end' }); rl.textContent = refLabel; svg.append(rl);
    }
    // Break the line at gaps (server offline / not measured).
    let d = '', prevT = null;
    for (const p of points) {
      const v = p[key];
      if (v == null) { prevT = null; continue; }
      const px = x(p.t).toFixed(1), py = y(Math.min(v, niceTop)).toFixed(1);
      if (prevT == null || p.t - prevT > 35000) d += `M${px},${py}`;
      else d += step ? `H${px}V${py}` : `L${px},${py}`;
      prevT = p.t;
    }
    if (d) svg.append(mk('path', { d, class: 'line' }));
    const cross = mk('line', { y1: T, y2: H - B, class: 'cross', visibility: 'hidden' });
    const dot = mk('circle', { r: 4, class: 'dot-mark', visibility: 'hidden' });
    svg.append(cross, dot);
    const hit = mk('rect', { x: L, y: 0, width: W - L - R, height: H, fill: 'transparent' });
    svg.append(hit);
    const withVal = points.filter(p => p[key] != null);
    hit.addEventListener('mousemove', e => {
      if (!withVal.length) return;
      const r = svg.getBoundingClientRect();
      const t = t0 + ((e.clientX - r.left - L) / (W - L - R)) * rangeMs;
      let best = withVal[0];
      for (const p of withVal) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
      const bx = x(best.t), by = y(Math.min(best[key], niceTop));
      cross.setAttribute('x1', bx); cross.setAttribute('x2', bx); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', bx); dot.setAttribute('cy', by); dot.setAttribute('visibility', 'visible');
      tip.textContent = `${fmtClock(best.t)} · ${fmt(best[key])}`;
      tip.style.display = 'block';
      tip.style.left = `${Math.min(W - 120, Math.max(0, bx - 50))}px`;
      tip.style.top = `${Math.max(28, by + 14)}px`;
    });
    hit.addEventListener('mouseleave', () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; });
    clear(svgWrap).append(svg);
    if (!withVal.length) svgWrap.append(h('div', { class: 'chart-empty', text: 'No data yet: samples are taken every 10 s while the server runs.' }));
    const last = withVal[withVal.length - 1];
    latest.textContent = last ? fmt(last[key]) : '';
    state = { points, rangeMs };
  }
  new ResizeObserver(() => { if (state) draw(state.points, state.rangeMs); }).observe(svgWrap);
  return { el, draw };
}

// ================= Worlds tab =================
async function renderWorlds(body, s) {
  let r;
  try { r = await call('worlds:list', s.id); } catch (e) { put(body, h('div', { class: 'note err', text: e.message })); return; }
  const running = isRunning(s);
  const ver = h('div', { class: 'card detail version-card' },
    h('div', { class: 'grow' }, h('div', { class: 'muted small', text: 'Minecraft version' }), h('div', { class: 'big-num' }, `${swInfo(s.software).label} ${s.mcVersion || '?'}`)),
    h('button', { class: 'btn', text: 'Change Version…', disabled: running, title: running ? 'Stop the server first' : '', onclick: () => openChangeVersion(s) }));

  const rows = r.worlds.map(w => h('tr', null,
    h('td', { class: 'name' }, h('strong', { text: w.name && w.name !== w.folder ? `${w.name}` : w.folder }), w.name && w.name !== w.folder && h('span', { class: 'muted mono small', text: `  ${w.folder}` }),
      w.active && h('span', { class: 'pill online', style: { marginLeft: '8px' } }, 'Active'), w.missing && h('span', { class: 'muted small', text: '  (created on next start)' })),
    h('td', { text: w.version || '' }), h('td', { text: w.gameMode ? w.gameMode[0].toUpperCase() + w.gameMode.slice(1) : '' }),
    h('td', { class: 'num', text: w.size != null ? fmtBytes(w.size) : '' }),
    h('td', null, !w.missing && h('div', { class: 'row-actions always' },
      !w.active && h('button', { class: 'btn sm', text: 'Make Active', onclick: guard(async () => { const x = await call('worlds:setActive', s.id, w.folder); toast(x.restartNeeded ? `“${w.folder}” is now active. Restart the server to load it.` : `“${w.folder}” is now the active world.`); await loadProps(s.id); renderMain(); }) }),
      h('button', { class: 'btn sm ghost', text: 'Copy to Singleplayer', onclick: () => exportWorld(s, w) }),
      w.active && h('button', { class: 'btn sm ghost danger', text: 'Reset…', disabled: running, title: running ? 'Stop the server first' : '', onclick: () => resetWorld(s, w) }),
      !w.active && h('button', { class: 'btn sm ghost danger', text: 'Delete', onclick: guard(async () => { if (await confirmBox(`Move “${w.folder}” to the Trash?`, 'Its Nether and End folders go too. You can restore them from the Trash.', ['Move to Trash', 'Cancel'], true) === 0) { await call('worlds:trash', s.id, w.folder); renderMain(); } }) })))));

  put(body, ver,
    h('div', { class: 'section-head', style: { marginTop: '14px' } }, h('h2', { text: 'Worlds on this server' }),
      h('button', { class: 'btn sm primary', text: 'Bring In a Singleplayer World…', onclick: () => importWorldInto(s) })),
    h('div', { class: 'card' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', { text: 'World' }), h('th', { text: 'Version' }), h('th', { text: 'Mode' }), h('th', { text: 'Size', style: { textAlign: 'right' } }), h('th'))), h('tbody', null, rows))),
    h('div', { class: 'muted small', style: { marginTop: '8px' } }, 'Only the active world is played. Paper keeps the Nether and End in separate folders (world_nether, world_the_end); Blockyard treats them as one world. ',
      h('a', { href: '#', text: 'Open singleplayer saves folder', onclick: e => { e.preventDefault(); call('worlds:openSaves'); } }), '.'));
}

function importWorldInto(s) {
  const st = { world: null, playerChoice: null, makeOp: true, applySettings: true };
  const okBtn = h('button', { class: 'btn primary', text: 'Copy In', disabled: true });
  const folder = h('input', { type: 'text', value: '', placeholder: 'Folder name on the server', style: { width: '100%' } });
  const active = h('input', { type: 'checkbox', checked: !isRunning(s), disabled: isRunning(s) });
  const chooser = worldChooser(st, ok => { okBtn.disabled = !ok; if (st.world && !folder.dataset.touched) folder.value = st.world.folder.replace(/[^\w .-]/g, '_'); });
  folder.oninput = () => { folder.dataset.touched = '1'; };
  const m = modal({
    title: 'Bring in a singleplayer world', subtitle: 'It’s copied. The original stays in your saves.', size: 'wide',
    body: [chooser, h('div', { class: 'field-row', style: { marginTop: '12px' } },
      h('div', { class: 'field' }, h('label', { text: 'Name on the server' }), folder),
      h('label', { class: 'check', style: { alignSelf: 'end', marginBottom: '20px' } }, active, h('span', { text: isRunning(s) ? 'Make it the active world (stop the server first)' : 'Make it the active world' })))],
    foot: [h('button', { class: 'btn', text: 'Cancel', onclick: () => m.close() }), okBtn],
  });
  okBtn.onclick = guard(async () => {
    okBtn.disabled = true; okBtn.textContent = 'Copying…';
    try {
      await resolvePlayer(st);
      const r = await call('worlds:importSave', s.id, { worldDir: st.world.dir, targetName: folder.value.trim() || 'world', player: st.player, makeOp: st.player && st.makeOp, setActive: active.checked, applySettings: st.applySettings });
      m.close();
      toast(`Copied “${st.world.name}” as ${r.dest}${r.playerMoved ? ` with ${st.player.name}'s inventory` : ''}.`);
      await loadProps(s.id); renderMain();
    } finally { okBtn.disabled = false; okBtn.textContent = 'Copy In'; }
  });
}

async function exportWorld(s, w) {
  const accounts = await call('worlds:accounts').catch(() => []);
  const name = h('input', { type: 'text', value: `${s.name} (server copy)`, style: { width: '100%' } });
  const who = h('select', { style: { width: '100%' } }, accounts.map(a => h('option', { value: a.uuid, text: a.name })), h('option', { value: '', text: 'Nobody (start fresh in singleplayer)' }));
  const m = modal({
    title: `Copy “${w.folder}” to singleplayer`, subtitle: 'Makes a new singleplayer world. The server world isn’t changed.', size: 'small',
    body: [h('div', { class: 'field' }, h('label', { text: 'Singleplayer world name' }), name),
      h('div', { class: 'field' }, h('label', { text: 'Bring this player’s server inventory' }), who),
      isRunning(s) && h('div', { class: 'muted small', text: 'The server keeps running. Blockyard saves the world to disk first.' })],
    foot: [h('button', { class: 'btn', text: 'Cancel', onclick: () => m.close() }), h('button', { class: 'btn primary', text: 'Copy', onclick: guard(async e => {
      e.target.disabled = true; e.target.textContent = 'Copying…';
      try {
        const acc = accounts.find(a => a.uuid === who.value);
        const r = await call('worlds:exportToSaves', s.id, w.folder, { newName: name.value.trim(), player: acc || null });
        m.close(); toast(`Copied to singleplayer as “${r.name}”. Open Minecraft → Singleplayer.`);
      } finally { e.target.disabled = false; e.target.textContent = 'Copy'; }
    }) })],
  });
}

async function resetWorld(s, w) {
  const seed = h('input', { type: 'text', placeholder: 'Random', style: { width: '100%' } });
  const m = modal({
    title: `Reset “${w.folder}”?`, subtitle: 'A brand-new world is generated next time the server starts.', size: 'small',
    body: [h('div', { class: 'note warn', text: 'Blockyard backs up the current world first, then moves it to the Trash.' }), h('div', { class: 'field' }, h('label', { text: 'Seed for the new world (optional)' }), seed)],
    foot: [h('button', { class: 'btn', text: 'Cancel', onclick: () => m.close() }), h('button', { class: 'btn danger-fill', text: 'Back Up & Reset', onclick: guard(async e => {
      e.target.disabled = true; e.target.textContent = 'Backing up…';
      try { await call('worlds:reset', s.id, w.folder, { seed: seed.value.trim() || null }); m.close(); toast('World reset. Start the server to generate the new one.'); renderMain(); } finally { e.target.disabled = false; }
    }) })],
  });
}

async function openChangeVersion(s) {
  const sel = h('select', { style: { width: '100%' } }, h('option', { text: 'Loading versions…' }));
  const help = h('div', { class: 'help' });
  const ok = h('button', { class: 'btn primary', text: 'Back Up & Change', disabled: true });
  const m = modal({
    title: 'Change Minecraft version', subtitle: `${swInfo(s.software).label} ${s.mcVersion || ''}`, size: 'small',
    body: [h('div', { class: 'field' }, h('label', { text: 'New version' }), sel, help),
      h('div', { class: 'note warn', text: 'Worlds can only be upgraded, never downgraded. Blockyard backs up the world first. Plugins and mods may need updating for the new version.' })],
    foot: [h('button', { class: 'btn', text: 'Cancel', onclick: () => m.close() }), ok],
  });
  try {
    const list = (await call('software:versions', s.software)).filter(v => !s.mcVersion || cmpVer(v, s.mcVersion) >= 0);
    put(clear(sel), list.map(v => h('option', { value: v, text: v === s.mcVersion ? `${v} (current)` : v })));
    ok.disabled = list.length < 2 && list[0] === s.mcVersion;
    help.textContent = list[0] === s.mcVersion ? 'You’re already on the newest version.' : `Newest: ${list[0]}`;
  } catch (e) { clear(sel).append(h('option', { text: 'Couldn’t load versions' })); help.textContent = e.message; }
  ok.onclick = guard(async () => {
    const v = sel.value; m.close();
    const updated = await runTask({ title: `Changing to ${v}`, run: taskId => call('server:changeVersion', s.id, v, taskId), doneText: `Now on ${swInfo(s.software).label} ${v}.` });
    Object.assign(s, updated, { snapshot: s.snapshot });
    renderSidebar(); renderMain();
  });
}

// ================= Log files =================
async function openLogFiles(s) {
  const list = await call('logs:list', s.id).catch(() => []);
  const view = h('pre', { class: 'log-view selectable' });
  const filter = h('input', { type: 'search', placeholder: 'Filter lines…', style: { flex: 1 } });
  let text = '';
  const show = () => {
    const q = filter.value.trim().toLowerCase();
    const lines = q ? text.split('\n').filter(l => l.toLowerCase().includes(q)) : text.split('\n');
    view.textContent = lines.slice(-5000).join('\n') || (q ? 'No matching lines.' : '');
    view.scrollTop = q ? 0 : view.scrollHeight;
  };
  filter.oninput = show;
  const side = h('div', { class: 'log-files' }, list.length ? list.map((f, i) => h('div', { class: `log-file${i === 0 ? ' sel' : ''}`, onclick: async e => {
    side.querySelectorAll('.log-file').forEach(x => x.classList.remove('sel')); e.currentTarget.classList.add('sel');
    text = await call('logs:read', s.id, f.rel).catch(err => err.message); show();
  } }, h('div', { text: f.kind === 'crash' ? `💥 ${f.name}` : f.name }), h('div', { class: 'muted small', text: `${fmtDate(f.time)} · ${fmtBytes(f.size)}` }))) : h('div', { class: 'empty', text: 'No log files yet.' }));
  modal({ title: 'Log files', subtitle: 'Past console output (logs/) and crash reports (crash-reports/)', size: 'wide',
    body: h('div', { class: 'log-browser' }, side, h('div', { class: 'log-main' }, h('div', { class: 'row-btns' }, filter), view)) });
  if (list.length) { text = await call('logs:read', s.id, list[0].rel).catch(err => err.message); show(); }
}

// ================= Scheduled commands & Discord =================
function schedulesSection(s) {
  let list = (s.schedules || []).map(x => ({ ...x }));
  const box = h('div', { class: 'card detail' });
  const save = guard(async () => {
    const clean = list.filter(x => x.command.trim()).map(x => ({ ...x, command: x.command.trim().replace(/^\//, ''), every: Math.max(1, Math.round(+x.every || 0)) }));
    const u = await call('servers:update', s.id, { schedules: clean });
    Object.assign(s, u, { snapshot: s.snapshot }); list = clean.map(x => ({ ...x })); draw(); toast('Scheduled commands saved.');
  });
  function draw() {
    clear(box);
    put(box,
      list.length ? list.map((x, i) => h('div', { class: 'cmd-sched-row' },
        switchEl(x.enabled !== false, e => { x.enabled = e.target.checked; }),
        h('span', { text: 'Every' }), h('input', { type: 'number', min: 1, value: x.every, style: { width: '70px' }, oninput: e => { x.every = e.target.value; } }), h('span', { text: 'min run' }),
        h('input', { type: 'text', class: 'mono', value: x.command, placeholder: 'say Remember to vote!', style: { flex: 1 }, oninput: e => { x.command = e.target.value; } }),
        h('button', { class: 'btn sm ghost danger', text: 'Remove', onclick: () => { list.splice(i, 1); draw(); } })))
        : h('div', { class: 'muted small', text: 'Run console commands on a timer while the server is online: announcements, saves, reminders.' }),
      h('div', { class: 'row-btns' },
        h('button', { class: 'btn sm', text: '+ Add Command', onclick: () => { list.push({ id: Math.random().toString(36).slice(2, 9), every: 30, command: '', enabled: true }); draw(); } }),
        h('button', { class: 'btn sm ghost', text: '+ Announcement every 30 min', onclick: () => { list.push({ id: Math.random().toString(36).slice(2, 9), every: 30, command: 'say Join our Discord!', enabled: true }); draw(); } }),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn sm primary', text: 'Save', onclick: save })));
  }
  draw();
  return [h('h2', { text: 'Scheduled commands', style: { fontSize: '14px', margin: '30px 0 10px' } }), box];
}

function webhookSection(s) {
  const w = { url: '', events: {}, ...(s.webhook || {}) };
  const ev = { start: true, stop: true, crash: true, join: false, leave: false, ...w.events };
  const url = h('input', { type: 'text', class: 'mono', value: w.url, placeholder: 'https://discord.com/api/webhooks/…', style: { flex: 1 } });
  const box = h('div', { class: 'card detail' },
    h('div', { class: 'muted small' }, 'Post server events to a Discord channel. In Discord: channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.'),
    h('div', { class: 'row-btns' }, url, h('button', { class: 'btn sm', text: 'Send Test', onclick: guard(async () => { await call('webhook:test', url.value.trim()); toast('Test message sent to Discord.'); }) })),
    h('div', { class: 'row-btns wrap' }, [['start', 'Server online'], ['stop', 'Stopped'], ['crash', 'Crashed'], ['join', 'Player joins'], ['leave', 'Player leaves']].map(([k, t]) =>
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: ev[k], onchange: e => { ev[k] = e.target.checked; } }), h('span', { text: t })))),
    h('div', { class: 'row-btns' }, h('span', { class: 'grow' }),
      w.url && h('button', { class: 'btn sm ghost danger', text: 'Disconnect', onclick: guard(async () => { const u = await call('servers:update', s.id, { webhook: null }); Object.assign(s, u, { snapshot: s.snapshot }); toast('Discord disconnected.'); renderMain(); }) }),
      h('button', { class: 'btn sm primary', text: 'Save', onclick: guard(async () => {
        const v = url.value.trim();
        if (v && !/^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\//.test(v)) throw new Error('That doesn’t look like a Discord webhook URL.');
        const u = await call('servers:update', s.id, { webhook: v ? { url: v, events: ev } : null });
        Object.assign(s, u, { snapshot: s.snapshot }); toast('Discord notifications saved.');
      }) })));
  return [h('h2', { text: 'Discord notifications', style: { fontSize: '14px', margin: '30px 0 10px' } }), box];
}

// ================= Plugin / mod updates =================
function updatesBar(s) {
  const bar = h('div', { class: 'updates-bar' });
  const tracked = Object.keys(s.modrinth || {}).length;
  const check = guard(async () => {
    clear(bar).append(h('span', { class: 'muted', text: 'Checking Modrinth for updates…' }));
    const ups = await call('modrinth:checkUpdates', s.id);
    clear(bar);
    if (!ups.length) { put(bar, h('span', { class: 'muted', text: '✓ Everything installed from Modrinth is up to date.' }), h('button', { class: 'btn sm ghost', text: 'Check Again', onclick: check })); return; }
    put(bar, h('div', { class: 'grow' }, h('strong', { text: `${ups.length} update${ups.length === 1 ? '' : 's'} available` }), h('div', { class: 'muted small', text: ups.map(u => `${u.title} ${u.current} → ${u.latest}`).join(' · ') })),
      h('button', { class: 'btn sm primary', text: 'Update All', onclick: guard(async () => {
        await runTask({ title: 'Updating', subtitle: `${ups.length} from Modrinth`, run: taskId => call('modrinth:updateAll', s.id, ups.map(u => u.projectId), taskId), doneText: isRunning(s) ? 'Updated. Restart the server to load the new versions.' : 'Updated.' });
        const fresh = (await call('servers:list')).find(x => x.id === s.id); if (fresh) Object.assign(s, fresh, { snapshot: s.snapshot });
        renderMain();
      }) }));
  });
  put(bar, h('span', { class: 'muted grow', text: tracked ? `${tracked} installed from Modrinth.` : 'Plugins and mods installed from Browse Modrinth can be updated here.' }), tracked && h('button', { class: 'btn sm', text: 'Check for Updates', onclick: check }));
  return bar;
}

// ================= live events, menu, errors =================
api.on('server:metrics', ({ id, metrics }) => {
  const s = server(id); if (!s) return;
  s.snapshot.metrics = metrics;
  if (id === S.selected) renderStats();
});
api.on('bedrock:state', ({ id }) => { if (id === S.selected && S.tab === 'access') renderMain(); });
api.on('app:menu', action => {
  const s = current();
  if (action === 'new') return openCreate();
  if (action === 'new-world') return openCreate({ mode: 'world' });
  if (action === 'import') return openImport();
  if (action === 'settings') return openAppSettings();
  if (action.startsWith('tab:')) { if (!s) return; S.tab = action.slice(4); return renderMain(); }
  if (!s) return;
  if (action === 'start' && s.snapshot.state === 'stopped') return guard(() => call('server:start', s.id))();
  if (action === 'stop' && isRunning(s)) return guard(() => call('server:stop', s.id))();
  if (action === 'restart' && isRunning(s)) return guard(() => call('server:restart', s.id))();
  if (action === 'backup') return guard(async () => { await call('backups:create', s.id); toast('Backup saved.'); })();
});
window.addEventListener('error', e => { call('app:logError', 'window', `${e.message} @ ${e.filename}:${e.lineno}`).catch(() => {}); });
window.addEventListener('unhandledrejection', e => { call('app:logError', 'promise', String(e.reason?.stack || e.reason)).catch(() => {}); });

// ---------- update notice (GitHub Releases) ----------
async function checkForUpdate(force, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  try {
    const r = await call('app:checkUpdate', !!force);
    showUpdateNote(r);
    if (force) toast(r.available ? `Blockyard ${r.latest} is available` : `You’re on the latest version (${r.current})`);
  } catch (e) {
    if (force) toast(e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Check for Updates'; }
  }
}
function showUpdateNote(r) {
  document.getElementById('update-note')?.remove();
  if (!r || !r.available) return;
  const note = h('div', { id: 'update-note', class: 'update-note' },
    h('div', { class: 'update-title', text: `Blockyard ${r.latest} is out` }),
    h('div', { class: 'update-sub', text: `You have ${r.current}.` }),
    h('div', { class: 'update-actions' },
      h('button', { class: 'btn sm primary', text: 'Download', onclick: () => call('app:openRelease', r.url) }),
      h('button', { class: 'btn sm', text: 'Later', onclick: () => note.remove() })));
  document.querySelector('.side-footer')?.before(note);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(() => checkForUpdate(false), 4000));
else setTimeout(() => checkForUpdate(false), 4000);
