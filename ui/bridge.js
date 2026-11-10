/* Connects the UI to Blockyard's engine. In the app this goes through Tauri; the UI tests load
   bridge-http.js instead, which talks to the same engine over a local test server. */
(() => {
  if (window.blockyard) return; // a test bridge was loaded first
  const T = window.__TAURI__;
  const call = (channel, ...args) => T.core.invoke('call', { channel, args }).catch(e => { throw new Error(String((e && e.message) || e)); });
  const api = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...a) => call(k, ...a)) });

  // Events: returns an unsubscribe function, like before.
  api.on = (event, cb) => {
    let un = null; let dead = false;
    T.event.listen(event, e => cb(e.payload)).then(f => { if (dead) f(); else un = f; });
    return () => { dead = true; if (un) un(); };
  };

  // Files dropped from Finder / File Explorer: Tauri reports paths and the drop point.
  const targets = new Set();
  api.dropTarget = (el, onPaths) => { targets.add({ el, onPaths }); };
  const at = p => {
    const r = window.devicePixelRatio || 1;
    const hit = p && document.elementFromPoint(p.x / r, p.y / r);
    for (const t of targets) { if (!t.el.isConnected) { targets.delete(t); continue; } if (hit && t.el.contains(hit)) return t; }
    return null;
  };
  const clearOver = () => document.querySelectorAll('.drag').forEach(e => e.classList.remove('drag'));
  T.event.listen('tauri://drag', e => { clearOver(); at(e.payload.position)?.el.classList.add('drag'); });
  T.event.listen('tauri://drag-leave', clearOver);
  T.event.listen('tauri://drag-drop', e => { clearOver(); const t = at(e.payload.position); if (t && e.payload.paths?.length) t.onPaths(e.payload.paths); });

  // Let the custom title bar move the window on macOS.
  const tagDrag = () => document.querySelectorAll('.side-drag, .welcome-drag, .header, .header .title, .header h1, .header .subtitle').forEach(el => el.setAttribute('data-tauri-drag-region', ''));
  new MutationObserver(tagDrag).observe(document.documentElement, { childList: true, subtree: true });

  window.blockyard = api;
})();
