/* Blockyard 2: safe public access (whitelist, invites, warnings), sleep mode, modpacks, open at login. */

// ================= Public Access: safety =================
/** The "who can actually get in" card shown when the server is open to the internet. */
function safetyCard(s, v) {
  const sf = v.safety || {};
  const card = h('div', { class: `card safety ${sf.warnings?.length ? 'warn' : 'ok'}` });
  const wl = switchEl(!!sf.whitelist, guard(async e => {
    const on = e.target.checked;
    if (!on) {
      const r = await confirmBox('Turn off the whitelist?', 'Anyone who finds your server’s address could join, and bots scan the internet for open servers all the time. Strangers often show up within hours and can grief your builds.', ['Turn Off', 'Keep It On'], true);
      if (r !== 0) { e.target.checked = true; return; }
    }
    S.accessView.set(s.id, await call('access:setWhitelist', s.id, on));
    toast(on ? 'Whitelist on: only invited players can join.' : 'Whitelist off.');
    renderMain();
  }));
  put(card,
    h('div', { class: 'safety-head' }, h('div', { class: 'hero-icon', text: sf.warnings?.length ? '⚠️' : '🛡️' }),
      h('div', { class: 'grow' },
        h('strong', { text: sf.whitelist ? 'Only people you invite can join' : 'Anyone with the address can join' }),
        h('div', { class: 'muted small', text: sf.whitelist ? `${sf.whitelistCount} on the whitelist${sf.opsCount ? ` · ${sf.opsCount} operator${sf.opsCount === 1 ? '' : 's'}` : ''}. Invite friends to let them in.` : 'Turn the whitelist on so strangers can’t join.' })),
      h('label', { class: 'check' }, wl, h('span', { text: 'Whitelist' }))),
    (sf.warnings || []).map(w => h('div', { class: 'note err', text: w })),
    h('div', { class: 'row-btns' },
      h('button', { class: 'btn primary', text: '✉︎  Invite a Friend', onclick: () => inviteDialog(s) }),
      h('button', { class: 'btn ghost', text: 'Manage players', onclick: () => { S.tab = 'players'; renderMain(); } })),
    h('details', { class: 'risks' }, h('summary', { text: 'What are the risks of opening my server?' }),
      h('ul', null,
        h('li', null, h('strong', { text: 'Strangers and griefers. ' }), 'Bots scan the whole internet for Minecraft servers, so a public server is usually found within hours. The whitelist keeps them out; keep it on.'),
        h('li', null, h('strong', { text: 'Pretend players. ' }), 'Keep online-mode on (the default) so Minecraft checks that every player really owns their account.'),
        h('li', null, h('strong', { text: 'Your computer. ' }), `The server runs as you, so a security hole in the server software or a malicious plugin could reach your files. Keep the server and plugins up to date, and only install plugins and mods from places you trust (Blockyard checks Modrinth downloads).`),
        h('li', null, h('strong', { text: 'Your address. ' }), 'With router port forwarding, the address you share is your home internet address. playit.gg hides it behind theirs.'),
        h('li', null, h('strong', { text: 'Only while it runs. ' }), 'Blockyard opens your router only while the server is running (or sleeping) and closes it when you stop it.'))));
  return card;
}

/** Look up a Java (or ".Bedrock") player, whitelist them and hand back a message to send. */
function inviteDialog(s) {
  const name = h('input', { type: 'text', placeholder: 'Their Minecraft username', autofocus: true, style: { width: '100%' } });
  const out = h('div');
  const go = guard(async () => {
    const n = name.value.trim();
    if (!n) return name.focus();
    btn.disabled = true; btn.textContent = 'Adding…';
    try {
      const r = await call('players:invite', s.id, n);
      clear(out).append(
        h('div', { class: 'note ok', text: `${r.name} is on the whitelist.` }),
        h('div', { class: 'field' }, h('label', { text: 'Send them this' }), h('textarea', { class: 'invite-text selectable', rows: 3, readonly: true, value: r.text })),
        h('div', { class: 'row-btns' }, h('button', { class: 'btn primary', text: 'Copy Message', onclick: () => { call('clipboard:write', r.text); toast('Copied. Paste it to your friend.'); } }),
          h('button', { class: 'btn', text: 'Invite Someone Else', onclick: () => { name.value = ''; clear(out); name.focus(); } })));
      S.accessView.set(s.id, await call('access:get', s.id));
    } catch (e) { clear(out).append(h('div', { class: 'note err', text: e.message })); }
    finally { btn.disabled = false; btn.textContent = 'Add to Whitelist'; }
  });
  name.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  const btn = h('button', { class: 'btn primary', text: 'Add to Whitelist', onclick: go });
  const m = modal({ title: 'Invite a Friend', subtitle: 'They’re added to the whitelist so they can join. Bedrock players: type their name with a “.” in front while the server runs.', size: 'small',
    body: [h('div', { class: 'field' }, h('label', { text: 'Username' }), h('div', { class: 'row' }, name, btn)), out],
    foot: [h('button', { class: 'btn', text: 'Done', onclick: () => { m.close(); if (S.tab === 'access') renderMain(); } })] });
  setTimeout(() => name.focus(), 50);
}

/** After switching to "Friends anywhere", say what Blockyard did to keep it safe. */
function announceSecured(view) {
  const sec = view && view.secured;
  if (!sec || !sec.whitelistOn) return;
  toast(sec.added?.length ? `Whitelist turned on, so only invited players can join. Added: ${sec.added.join(', ')}.` : 'Whitelist turned on, so only invited players can join. Invite friends to let them in.');
}

/** Windows: Java has to be allowed through the firewall or nobody outside can connect. */
function windowsFirewallRow(s) {
  if (!IS_WIN) return null;
  return h('div', { class: 'note' }, h('strong', { text: 'Windows Firewall: ' }),
    'the first time the server starts, Windows asks whether Java may use the network. Click “Allow”. If you missed it, ',
    h('a', { href: '#', text: 'allow Java now', onclick: guard(async e => { e.preventDefault(); await call('access:allowFirewall', s.id); toast('Java is allowed through Windows Firewall.'); }) }),
    ' (Windows asks for permission).');
}

// ================= Automation: sleep mode + open at login =================
function sleepRows(s, a, save, sw) {
  const mins = Number(a.sleepWhenEmpty) || 0;
  const sel = h('select', { disabled: !mins, onchange: e => save({ sleepWhenEmpty: +e.target.value }) },
    [5, 10, 15, 30, 60].map(n => h('option', { value: n, text: `${n} minutes`, selected: (mins || 15) === n })));
  const login = h('input', { type: 'checkbox' });
  call('app:autostart').then(on => { login.checked = !!on; }, () => { login.disabled = true; });
  login.onchange = guard(async () => { login.checked = await call('app:autostart', login.checked); toast(login.checked ? 'Blockyard will open when you log in.' : 'Blockyard won’t open at login.'); });
  return [
    h('div', { class: 'auto-row' }, sw(!!mins, e => { sel.disabled = !e.target.checked; save({ sleepWhenEmpty: e.target.checked ? +sel.value || 15 : 0 }); }),
      h('div', { class: 'grow' }, h('strong', { text: 'Sleep when nobody’s online for ' }), sel,
        h('div', { class: 'muted small', text: 'Stops the server to free memory and power, then starts it again when a whitelisted player tries to join (they reconnect after about a minute). Friends see “asleep” in their server list.' }))),
    h('div', { class: 'auto-row' }, h('label', { class: 'switch' }, login, h('span')),
      h('div', null, h('strong', { text: 'Open Blockyard when I log in' }), h('div', { class: 'muted small', text: `Together with “Start when Blockyard opens”, your server comes back by itself whenever ${THIS_PC} restarts.` }))),
  ];
}

// ================= Modpacks =================
async function openModpack() {
  const st = { file: null, project: null, pack: null, name: '', memory: Math.min(8192, Math.max(4096, Math.floor((S.info.totalMemMB * 0.5) / 1024) * 1024)), port: S.info.suggestedPort || 25565, parent: S.info.defaultParent, eula: false, anywhere: true };
  let busy = false;
  const body = h('div', { class: 'wizard' });
  const foot = h('div', { class: 'modal-foot-inner' });
  const m = modal({ title: 'Install a Modpack', subtitle: 'Mods, settings and the right mod loader, set up for a server. Client-only mods (shaders, minimaps) are skipped.', size: 'wide', body, foot, dismissable: () => !busy });

  function pick() {
    clear(body); clear(foot);
    const results = h('div', { class: 'mr-list' });
    const q = h('input', { type: 'search', placeholder: 'Search Modrinth modpacks…', style: { flex: 1 } });
    let timer;
    const search = async () => {
      clear(results).append(h('div', { class: 'muted', text: 'Searching…' }));
      try {
        const r = await call('modrinth:searchModpacks', { query: q.value, sort: q.value ? 'relevance' : 'downloads' });
        clear(results);
        if (!r.hits.length) results.append(h('div', { class: 'empty', text: 'No modpacks found.' }));
        for (const hit of r.hits) {
          results.append(h('div', { class: 'mr-item' },
            hit.icon ? h('img', { class: 'mr-icon', src: hit.icon, alt: '' }) : h('div', { class: 'mr-icon ph', text: '📦' }),
            h('div', { class: 'grow' }, h('div', { class: 'mr-title' }, h('strong', { text: hit.title }), h('span', { class: 'muted small', text: ` by ${hit.author}` })), h('div', { class: 'muted small', text: hit.description })),
            h('button', { class: 'btn sm primary', text: 'Choose', onclick: () => { st.project = hit.id; st.file = null; st.pack = { name: hit.title, summary: hit.description }; st.name = uniqueName(hit.title); details(); } })));
        }
      } catch (e) { clear(results).append(h('div', { class: 'note err', text: e.message })); }
    };
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 350); });
    put(body,
      h('div', { class: 'row', style: { display: 'flex', gap: '8px', marginBottom: '10px' } }, q,
        h('button', { class: 'btn', text: 'Open .mrpack File…', onclick: guard(async () => {
          const f = (await call('dialog:pickFiles', { title: 'Choose a Modrinth modpack (.mrpack)', filters: [{ name: 'Modrinth modpack', extensions: ['mrpack'] }] }))[0];
          if (!f) return;
          st.pack = await call('servers:readModpack', f); st.file = f; st.project = null; st.name = uniqueName(st.pack.name); details();
        }) })),
      results);
    put(foot, h('span', { class: 'grow' }), h('button', { class: 'btn', text: 'Cancel', onclick: () => m.close() }));
    search();
  }

  function details() {
    clear(body); clear(foot);
    const p = st.pack;
    const total = S.info.totalMemMB;
    const memLabel = h('strong', { text: fmtMem(st.memory) });
    const mem = h('input', { type: 'range', min: 2048, max: Math.max(4096, Math.floor((total * 0.75) / 512) * 512), step: 512, value: st.memory, oninput: e => { st.memory = +e.target.value; memLabel.textContent = fmtMem(st.memory); } });
    const createBtn = h('button', { class: 'btn primary', text: 'Install Modpack', disabled: !st.eula });
    put(body,
      h('div', { class: 'card detail' }, h('strong', { text: p.name }), p.version && h('span', { class: 'muted', text: `  ${p.version}` }),
        p.mcVersion && h('div', { class: 'muted small', text: `Minecraft ${p.mcVersion} · ${swInfo(p.software).label}${p.loader ? ' ' + p.loader : ''} · ${p.files} files${p.skipped ? ` · ${p.skipped} client-only skipped` : ''}` }),
        p.summary && h('div', { class: 'muted small', text: p.summary })),
      h('div', { class: 'field' }, h('label', { text: 'Server name' }), h('input', { type: 'text', value: st.name, style: { width: '100%' }, oninput: e => { st.name = e.target.value; } })),
      h('div', { class: 'field' }, h('label', null, 'Memory: ', memLabel), mem, h('div', { class: 'help', text: `${YOUR_PC} has ${fmtMem(total)}. Modpacks usually want 6–8 GB.` })),
      h('div', { class: 'choice-col' },
        h('div', { class: `choice${st.anywhere ? ' sel' : ''}`, onclick: () => { st.anywhere = true; details(); } }, h('span', { class: 'radio' }), h('div', { class: 'choice-icon', text: '🌍' }), h('div', null, h('strong', { text: 'Friends anywhere' }), h('div', { class: 'muted small', text: 'Opens your router automatically and turns the whitelist on, so only people you invite can join.' }))),
        h('div', { class: `choice${!st.anywhere ? ' sel' : ''}`, onclick: () => { st.anywhere = false; details(); } }, h('span', { class: 'radio' }), h('div', { class: 'choice-icon', text: '🏠' }), h('div', null, h('strong', { text: 'Only people on my Wi-Fi' }), h('div', { class: 'muted small', text: 'Nothing is opened to the internet.' })))),
      h('label', { class: 'check eula' }, h('input', { type: 'checkbox', checked: st.eula, onchange: e => { st.eula = e.target.checked; createBtn.disabled = !st.eula; } }),
        h('span', null, 'I agree to the ', linkBtn('Minecraft EULA', 'https://aka.ms/MinecraftEULA'), ' (required by Mojang)')));
    createBtn.onclick = () => install();
    put(foot, h('button', { class: 'btn', text: 'Back', onclick: pick }), h('span', { class: 'grow' }), createBtn);
  }

  async function install() {
    busy = true;
    clear(body); clear(foot);
    const status = h('div', { class: 'task-status', text: 'Starting…' });
    const bar = h('div', { class: 'progress indet' }, h('i'));
    const logBox = h('div', { class: 'task-log selectable' });
    body.append(status, bar, logBox);
    const taskId = 'pack-' + Date.now();
    const off = api.on('task:progress', ev => {
      if (ev.taskId !== taskId) return;
      if (!ev.verbose) status.textContent = ev.message;
      if (ev.pct != null) { bar.classList.remove('indet'); bar.firstChild.style.width = `${Math.round(ev.pct * 100)}%`; }
      logBox.append(ev.message + '\n'); logBox.scrollTop = logBox.scrollHeight;
    });
    try {
      const created = await call('servers:createModpack', { file: st.file, project: st.project, name: st.name.trim(), parentDir: st.parent, port: st.port, memoryMB: st.memory, eula: st.eula }, taskId);
      if (st.anywhere) announceSecured(await call('access:set', created.id, { method: 'upnp', auto: true }));
      S.servers.push(created);
      off(); busy = false; m.close();
      S.tab = 'console'; await select(created.id);
      toast(`${created.name} is ready. Press Start.`);
    } catch (e) {
      off(); busy = false;
      status.textContent = 'Something went wrong';
      body.prepend(h('div', { class: 'note err selectable', text: e.message }));
      put(foot, h('span', { class: 'grow' }), h('button', { class: 'btn', text: 'Close', onclick: () => m.close() }), h('button', { class: 'btn primary', text: 'Back', onclick: details }));
    }
  }
  pick();
}
