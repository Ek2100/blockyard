/* UI tests only: talks to blockyard-bridge over HTTP instead of Tauri. Loaded before bridge.js. */
(() => {
  const call = async (channel, ...args) => {
    const r = await (await fetch('/call', { method: 'POST', body: JSON.stringify({ channel, args }) })).json();
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  const listeners = new Map();
  const es = new EventSource('/events');
  es.onmessage = m => { const { event, payload } = JSON.parse(m.data); for (const cb of listeners.get(event) || []) cb(payload); };
  const api = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...a) => call(k, ...a)) });
  api.on = (event, cb) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(cb); return () => listeners.get(event).delete(cb); };
  api.pathForFile = f => f.path || null;
  api.dropTarget = null; // browser drag-and-drop (the app uses Tauri's file-drop events)
  window.blockyard = api;
})();
