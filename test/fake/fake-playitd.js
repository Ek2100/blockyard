#!/usr/bin/env node
// Speaks playitd's IPC protocol (v3): NDJSON over a Unix socket. Tunnels come from tunnels.json next to the secret.
const net = require('net');
const fs = require('fs');
const path = require('path');

const arg = n => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
const secretPath = arg('--secret-path');
const socketPath = arg('--socket-path');
const tunnelsFile = path.join(path.dirname(secretPath), 'tunnels.json');
const clients = new Set();

const hasSecret = () => fs.existsSync(secretPath) && /secret_key = "[0-9a-f]+"/.test(fs.readFileSync(secretPath, 'utf8'));
const tunnels = () => { try { return JSON.parse(fs.readFileSync(tunnelsFile, 'utf8')); } catch { return []; } };
function lifecycle() {
  if (!hasSecret()) return { state: 'waiting_for_secret' };
  return { state: 'running', data: { version: '2.0.2', tunnels: tunnels(), pending_tunnels: [], notices: [], account_status: 'guest', agent_id: '11111111-2222-3333-4444-555555555555', login_link: 'https://playit.gg/login/guest-account/abc', start_time: Date.now() } };
}
const status = () => ({ phase: hasSecret() ? 'running' : 'waiting_for_secret', pid: process.pid, uptime_secs: 1, version: '2.0.2', socket_path: socketPath, secret_path: secretPath, has_secret: hasSecret(), protocol: { ipc_version: 3, capabilities: [] }, last_error: null });
const write = (sock, obj) => sock.write(JSON.stringify(obj) + '\n');
const broadcast = event => { for (const c of clients) write(c, { message_kind: 'event', data: { ipc_version: 3, event } }); };

const server = net.createServer(sock => {
  write(sock, { message_kind: 'hello', data: { protocol: { ipc_version: 3, capabilities: ['stream_events', 'secret_provisioning'] } } });
  let buf = '';
  sock.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const { request_id, request } = JSON.parse(line);
      const respond = response => write(sock, { message_kind: 'response', data: { ipc_version: 3, request_id, response } });
      if (request.type === 'subscribe') { clients.add(sock); respond({ type: 'subscribe', data: { protocol: { ipc_version: 3, capabilities: [] }, snapshot: { status: status(), lifecycle: lifecycle(), stats: { bytes_in: 0, bytes_out: 0, active_tcp: 0, active_udp: 0 } } } }); }
      else if (request.type === 'set_secret') {
        if (!/^[0-9a-f]+$/.test(request.secret)) { respond({ type: 'error', data: { code: 'invalid_secret', message: 'bad secret', retryable: false, details: null } }); continue; }
        fs.writeFileSync(secretPath, `secret_key = "${request.secret}"\n`);
        respond({ type: 'set_secret', data: { accepted: true, message: null } });
        setTimeout(() => { broadcast({ type: 'status', data: status() }); broadcast({ type: 'lifecycle', data: lifecycle() }); }, 50);
      } else if (request.type === 'stop') { respond({ type: 'stop', data: { accepted: true, message: null } }); setTimeout(() => process.exit(0), 20); }
      else respond({ type: 'error', data: { code: 'invalid_request_type', message: 'nope', retryable: false, details: null } });
    }
  });
  sock.on('close', () => clients.delete(sock));
  sock.on('error', () => {});
});
try { fs.rmSync(socketPath, { force: true }); } catch {}
server.listen(socketPath);
let last = JSON.stringify(tunnels());
setInterval(() => { const now = JSON.stringify(tunnels()); if (now !== last) { last = now; broadcast({ type: 'lifecycle', data: lifecycle() }); } }, 100);
setInterval(() => broadcast({ type: 'log', data: { level: 'info', target: 'playitd', message: 'tick', timestamp: Date.now() } }), 1000);
process.on('SIGTERM', () => process.exit(0));
