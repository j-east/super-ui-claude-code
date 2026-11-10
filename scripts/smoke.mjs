// End-to-end check of the server on this machine, with a stand-in for Claude Code: a tab's shell
// starts, its folder is tracked, a command can be typed into it, and a running `claude` is noticed
// and noticed again when it exits. Runs in CI on Windows, where nothing else tests those parts.
//   node scripts/smoke.mjs      (after `npm run build`)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
// .native: Windows hands out short names (RUNNER~1) for the temp folder; the shell reports the long one.
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-smoke-')));
const home = path.join(tmp, 'home'), bin = path.join(tmp, 'bin'), work = path.join(tmp, 'my work');
for (const d of [home, bin, work]) fs.mkdirSync(d, { recursive: true });

// The stand-in: a process named claude that stays up until told to stop.
if (WIN) fs.copyFileSync(process.execPath, path.join(bin, 'claude.exe')); // node's prompt, under claude's name
else fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('data', (d) => { if (String(d).includes('.exit')) process.exit(0); });\nconsole.log('fake claude up');\n`, { mode: 0o755 });

const PORT = '47991';
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'),
  PATH: bin + path.delimiter + process.env.PATH, CLAUDE_PANE_PORT: PORT, CLAUDE_PANE_NO_LABELS: '1', CLAUDE_PANE_NO_OPEN: '1' };
if (!WIN) env.SHELL = '/bin/zsh';
const srv = spawn(process.execPath, [path.join(ROOT, 'build', 'server.js')], { env, cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
srv.stdout.on('data', (d) => { out += d; });
srv.stderr.on('data', (d) => { out += d; });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const msgs = [];
let screen = '';
let token = '';
async function until(what, test, ms = 30_000) {
  const t0 = Date.now();
  for (;;) {
    const r = test();
    if (r) { console.log(`ok   ${what} (${Date.now() - t0} ms)`); return r; }
    if (Date.now() - t0 > ms) {
      console.log(`FAIL ${what}`);
      console.log('--- messages:', JSON.stringify(msgs.filter((m) => m.type !== 'output').slice(-12), null, 1));
      console.log('--- terminal tail:', JSON.stringify(screen.slice(-1500)));
      console.log('--- server:', out.replace(/t=[0-9a-f]+/g, 't=…'));
      try { console.log('--- detection:', await (await fetch(`http://127.0.0.1:${PORT}/api/debug?t=${token}`, { signal: AbortSignal.timeout(15_000) })).text()); } catch (e) { console.log('--- detection: unavailable', String(e)); }
      srv.kill(); process.exit(1);
    }
    await wait(100);
  }
}

await until('server is listening', () => out.match(/t=([0-9a-f]+)/));
token = out.match(/t=([0-9a-f]+)/)[1];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?t=${token}&w=smoke`, { origin: `http://127.0.0.1:${PORT}` });
ws.on('message', (raw) => { const m = JSON.parse(String(raw)); msgs.push(m); if (m.type === 'output') screen += m.data; });
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
const send = (m) => ws.send(JSON.stringify(m));
const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const last = (type) => msgs.filter((m) => m.type === type).at(-1);

const hello = await until('hello names the platform', () => last('hello'));
if (hello.platform !== process.platform) throw new Error('wrong platform in hello');
const tab = (await until('first tab opens', () => last('tab-open'))).tab;
await until('shell printed a prompt', () => screen.length > 0);
const welcome = await until('setup info arrives', () => last('welcome'));
console.log(`     claude found at: ${welcome.claude?.path ?? '(none)'}; install command: ${welcome.install}`);

// Folder with a space in it: exercises quoting and (on Windows) the prompt's folder report.
send({ type: 'cd', tab, dir: work });
await until('cd is typed and the new folder is noticed', () => same(last('mode')?.cwd, work), 45_000);

send({ type: 'launch', tab, kind: 'new' });
const mode = await until('claude starting is noticed', () => (last('mode')?.mode === 'claude' ? last('mode') : null), 45_000);
if (!same(mode.cwd, work)) throw new Error(`claude's folder is ${mode.cwd}, expected ${work}`);

// While "claude" runs, nothing may be typed for you.
const before = screen.length;
send({ type: 'cd', tab, dir: tmp });
await until('typing into a running claude is refused', () => msgs.some((m) => m.type === 'toast' && /running/.test(m.text)));
if (screen.slice(before).includes('cd ')) throw new Error('a command was typed into claude');

send({ type: 'input', tab, data: '.exit\r' });
await until('claude exiting is noticed', () => last('mode')?.mode === 'shell', 45_000);

// Workspaces land in the per-user data folder for this platform.
send({ type: 'save-workspace', name: 'Smoke' });
const dir = WIN ? path.join(home, 'AppData', 'Roaming', 'claude-pane', 'workspaces') : path.join(home, 'Library', 'Application Support', 'claude-pane', 'workspaces');
await until('workspace file is written', () => fs.existsSync(path.join(dir, 'Smoke.json')));

const quit = await fetch(`http://127.0.0.1:${PORT}/api/quit?t=${token}`, { method: 'POST' });
await until('server stops when asked', () => quit.ok && srv.exitCode !== null, 10_000);
console.log('all good');
process.exit(0);
