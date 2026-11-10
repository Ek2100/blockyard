#!/usr/bin/env node
// Launch test for the real desktop app (run in CI on every platform, and before every release).
// Starts the built app with a throwaway data folder holding one server (the fake Minecraft server),
// lets it load the UI, start that server, wait for it to come online and stop it, then checks the result.
//   node scripts/smoke-test.js <path to the app's executable>
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const exe = path.resolve(process.argv[2] || '');
if (!fs.existsSync(exe)) { console.error(`No app at ${exe}`); process.exit(2); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'by-smoke-'));
const data = path.join(tmp, 'data');
const srv = path.join(tmp, 'servers', 'Smoke Test');
fs.mkdirSync(data, { recursive: true });
fs.mkdirSync(srv, { recursive: true });
fs.copyFileSync(path.join(__dirname, '..', 'test', 'fake', 'server.jar'), path.join(srv, 'server.jar'));
fs.writeFileSync(path.join(srv, 'eula.txt'), 'eula=true\n');
fs.writeFileSync(path.join(srv, 'server.properties'), 'server-port=25699\n');
// Java for the fake server: the one CI set up (JAVA_HOME), or whatever is on PATH.
const javaPath = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : '';
fs.writeFileSync(path.join(data, 'servers.json'), JSON.stringify({
  servers: [{ id: 'smoke', name: 'Smoke Test', dir: srv, software: 'vanilla', kind: 'none', mcVersion: '1.21.4', javaMajor: 21, memoryMB: 512, launchArgs: ['-jar', 'server.jar'], jvmArgs: '', javaPath, onboarded: true }],
  settings: { keepAwake: false, checkUpdates: false },
}));
const out = path.join(tmp, 'result.txt');
const env = { ...process.env, BLOCKYARD_DATA_DIR: data, BLOCKYARD_SMOKE_TEST: out, RUST_BACKTRACE: '1' };
const [cmd, args] = process.platform === 'linux' && !process.env.DISPLAY ? ['xvfb-run', ['-a', exe]] : [exe, []];
console.log(`Launching ${exe}`);
const child = spawn(cmd, args, { env, stdio: 'inherit' });
const killer = setTimeout(() => { console.error('The app didn\'t finish within 3 minutes.'); child.kill('SIGKILL'); }, 180000);
child.on('exit', code => {
  clearTimeout(killer);
  const result = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '(no result: the app quit or crashed before loading its UI)';
  const logs = path.join(data, 'logs', 'blockyard.log');
  console.log(`Result: ${result}\nExit code: ${code}`);
  if (fs.existsSync(logs)) console.log('--- app log ---\n' + fs.readFileSync(logs, 'utf8').slice(-4000));
  process.exit(code === 0 && result.startsWith('ok') ? 0 : 1);
});
