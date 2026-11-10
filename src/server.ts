// claude-pane ("Claude Code Super UI"): tabs of login shells in ptys, served as a local
// split-pane UI. When you start `claude` in a tab, its transcript renders on top.
// Each UI window (?w=<id>) owns its own tabs. Hosted by the native app (CLAUDE_PANE_APP=1)
// or standalone with a Chrome app window. Usage: claude-pane [claude args...]
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { Tab } from './tab.js';
import { handoff, writeInstance, clearInstance } from './instance.js';
import { welcomeInfo } from './setup.js';
import { WIN, INSTALL_CLAUDE, shq, cdCommand } from './platform.js';
import { stopProcHelper } from './procwatch.js';
import { saveWorkspace, loadWorkspace, listWorkspaces, deleteWorkspace, pruneClosedWindowSaves, type WorkspaceTab } from './workspaces.js';

// Works from src/ (tsx) and build/ (compiled): both sit one level below the repo root.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM = path.join(ROOT, 'node_modules');
// Fixed port keeps the page origin stable, so notification permission and saved theme persist.
const PREFERRED_PORT = Number(process.env.CLAUDE_PANE_PORT) || 47823;
const T0 = Number(process.env.CLAUDE_PANE_T0) * 1000 || performance.timeOrigin;
const since = () => `${Math.round(Date.now() - T0)}ms`;
const token = crypto.randomBytes(16).toString('hex');
const autoArgs = process.argv.slice(2).filter((a) => a !== '--new' && a !== '');
const startCwd = process.cwd();
// Native app mode: the Swift app owns windows and our lifetime; no Chrome, no handoff, no idle exit.
const APP_MODE = process.env.CLAUDE_PANE_APP === '1';
// Hosted by the Electron app (Windows, or macOS for testing it): it shows the folder dialog itself.
const HOST_DIALOGS = process.env.CLAUDE_PANE_HOST === 'electron';

// ---------- static files ----------
const VENDOR: Record<string, string> = {
  'xterm.js': '@xterm/xterm/lib/xterm.js',
  'xterm.css': '@xterm/xterm/css/xterm.css',
  'addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js',
  'marked.js': 'marked/lib/marked.umd.js',
  'purify.js': 'dompurify/dist/purify.min.js',
  'hljs.js': '@highlightjs/cdn-assets/highlight.min.js',
  'hljs-dark.css': '@highlightjs/cdn-assets/styles/github-dark.min.css',
  'hljs-light.css': '@highlightjs/cdn-assets/styles/github.min.css',
};
const TYPES: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };

function staticFile(p: string): string | null {
  if (p === '/') return path.join(ROOT, 'public/index.html');
  const v = p.match(/^\/vendor\/([\w.-]+)$/);
  if (v) return VENDOR[v[1]!] ? path.join(NM, VENDOR[v[1]!]!) : null;
  const pub = p.match(/^\/([\w-]+\.(?:js|css|html))$/);
  return pub ? path.join(ROOT, 'public', pub[1]!) : null;
}

// ---------- tabs ----------
const tabs = new Map<string, Tab>();
const clients = new Map<WebSocket, string>(); // socket -> window id
const windowIdle = new Map<string, NodeJS.Timeout>();
let nextId = 1;
let lastWindow: string | null = null;
let firstTab = true;
const send = (ws: WebSocket, msg: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
const toWindow = (win: string, msg: unknown) => { for (const [ws, w] of clients) if (w === win) send(ws, msg); };
const windowHasClients = (win: string) => [...clients.values()].includes(win);

// ---------- inbox: every Claude session in every window, for all windows ----------
const INBOX_EVENTS = new Set(['dialog', 'activity', 'label', 'mode', 'transcript-reset']);
let inboxTimer: NodeJS.Timeout | null = null;
const inboxMsg = () => ({ type: 'inbox', items: [...tabs.values()].flatMap((t) => t.inboxItem() ?? []) });
function scheduleInbox(): void {
  inboxTimer ??= setTimeout(() => { inboxTimer = null; const m = inboxMsg(); for (const ws of clients.keys()) send(ws, m); }, 150);
}

function openTab(win: string, cwd: string, claudeArgs?: string[]): Tab {
  const id = String(nextId++);
  // Route by the tab's current window: tabs can be moved between windows.
  const tab: Tab = new Tab(id, win, cwd, (msg) => {
    toWindow(tab.windowId, { ...msg, tab: id });
    if (INBOX_EVENTS.has(String(msg.type))) scheduleInbox();
    if (msg.type === 'mode' || msg.type === 'transcript-reset') scheduleAutosave(); // a session started or changed
  });
  tabs.set(id, tab);
  scheduleAutosave();
  tab.onExit(() => closeTab(id, true));
  toWindow(win, { ...tab.snapshot(), tab: id });
  if (claudeArgs?.length) setTimeout(() => void tab.typeCommand(`claude ${claudeArgs.map(shq).join(" ")}`, 20_000), 0);
  return tab;
}

/** Move a live tab (shell, claude, transcript and all) to another window, e.g. dragged out into a new one. */
const movedFrom = new Map<string, string>(); // tab id -> window it came from, until its new window connects
function moveTab(tab: Tab, to: string): void {
  const from = tab.windowId;
  if (!to || to === from) return;
  tab.windowId = to;
  if (windowHasClients(to)) movedFrom.delete(tab.id); else movedFrom.set(tab.id, from);
  toWindow(from, { type: 'tab-moved', tab: tab.id });
  scheduleInbox();
  scheduleAutosave();
  toWindow(to, { ...tab.snapshot(), tab: tab.id });
  toWindow(to, { type: 'focus-tab', tab: tab.id });
  // Target window not connected yet (just being opened): same grace as a window that went away.
  if (!windowHasClients(to) && !windowIdle.has(to)) windowIdle.set(to, setTimeout(() => windowGone(to), GRACE_MS));
  if (!windowTabs(from).length) toWindow(from, { type: 'window-empty' });
}

/** Tabs you closed (newest last), so Cmd+Z can bring one back with its session resumed. */
const closedTabs: (WorkspaceTab & { win: string })[] = [];

/** `remember`: you closed it yourself (not a whole window going away), so it can be reopened. */
function closeTab(id: string, remember = false): void {
  const tab = tabs.get(id);
  if (!tab) return;
  if (remember) { closedTabs.push({ ...tabRecord(tab), win: tab.windowId }); if (closedTabs.length > 20) closedTabs.shift(); }
  tabs.delete(id);
  resumeIds.delete(id);
  tab.dispose();
  toWindow(tab.windowId, { type: 'tab-closed', tab: id });
  scheduleInbox();
  scheduleAutosave();
}

/** Open a tab for a saved record: its folder, and its Claude session resumed if it had one. */
function restoreTab(win: string, rec: WorkspaceTab): Tab {
  const tab = openTab(win, fs.existsSync(rec.cwd) ? rec.cwd : os.homedir());
  // Workspace files can be edited by hand: only ever type a well-formed session id.
  const id = typeof rec.sessionId === 'string' && UUID.test(rec.sessionId) ? rec.sessionId : null;
  // Waits (up to 20 s) for the new tab's login shell to finish starting before typing.
  if (id) { resumeIds.set(tab.id, id); void tab.typeCommand(`claude --resume ${id}`, 20_000); }
  else if (rec.claude) void tab.typeCommand('claude', 20_000);
  return tab;
}

function reopenClosedTab(win: string): void {
  const rec = closedTabs.pop();
  if (!rec) { toWindow(win, { type: 'toast', text: 'No closed tab to reopen' }); return; }
  const tab = restoreTab(win, rec);
  toWindow(win, { type: 'focus-tab', tab: tab.id });
}

// ---------- workspaces ----------
const windowTabs = (win: string) => [...tabs.values()].filter((t) => t.windowId === win);
// A restored tab's session id until `claude --resume` is actually up, so a save in between doesn't lose it.
const resumeIds = new Map<string, string>();
const tabRecord = (t: Tab): WorkspaceTab => {
  const pending = resumeIds.get(t.id);
  if (pending && t.sessionId) resumeIds.delete(t.id);
  const sessionId = t.sessionId ?? pending ?? null;
  return { cwd: t.cwd, sessionId, title: t.title, claude: t.claudeRunning || (!!pending && !t.sessionId) };
};
const worthSaving = (list: Tab[]) => list.some((t) => t.sessionId);

// ---------- autosave ----------
// A window you saved as (or opened from) a named workspace keeps that workspace up to date as tabs come
// and go. "Last session" is kept current the same way, so a crash loses nothing.
const windowWorkspace = new Map<string, string>(); // window id -> workspace it is saved as
const AUTO_NAME = /^(Last session$|Closed window )/;
let autosaveTimer: NodeJS.Timeout | null = null;
function bindWorkspace(win: string, name: string): void {
  if (AUTO_NAME.test(name)) return;
  windowWorkspace.set(win, name);
  toWindow(win, { type: 'workspace-name', name });
}
function autosave(): void {
  autosaveTimer = null;
  for (const [win, name] of windowWorkspace) if (windowTabs(win).length) saveWindow(win, name);
  const all = [...tabs.values()];
  if (worthSaving(all)) saveWorkspace({ name: 'Last session', active: 0, tabs: all.map(tabRecord) });
}
function scheduleAutosave(): void { autosaveTimer ??= setTimeout(autosave, 1500); }

function saveWindow(win: string, name: string, activeTab?: string): void {
  const list = windowTabs(win);
  saveWorkspace({ name, active: Math.max(0, list.findIndex((t) => t.id === activeTab)), tabs: list.map(tabRecord) });
}

/** Reopen a workspace's tabs in `win`, resuming each Claude session. Skips sessions already open. */
function openWorkspace(win: string, name: string): string | null {
  const w = loadWorkspace(name);
  if (!w) return `Workspace "${name}" not found`;
  // Only sessions with Claude actually running count as open (an exited one can be resumed again).
  const openIds = new Set([...tabs.values()].filter((t) => t.claudeRunning).map((t) => t.sessionId).filter(Boolean));
  // A window holding only one untouched shell tab gets replaced rather than kept.
  const existing = windowTabs(win);
  const replace = existing.length === 1 && !existing[0]!.claudeRunning && !existing[0]!.sessionId ? existing[0] : null;
  const opened: Tab[] = [];
  for (const rec of w.tabs) {
    if (rec.sessionId && openIds.has(rec.sessionId)) continue;
    const tab = restoreTab(win, rec);
    opened.push(tab);
  }
  if (!opened.length) return 'Everything in that workspace is already open';
  if (replace) closeTab(replace.id);
  bindWorkspace(win, w.name);
  const focus = opened[Math.min(w.active, opened.length - 1)] ?? opened[0]!;
  toWindow(win, { type: 'focus-tab', tab: focus.id });
  return null;
}

/** A window that stays disconnected (closed, not reloading) loses its tabs. */
function windowGone(win: string): void {
  // Tabs moved here whose window never connected (it failed to open): give them back.
  for (const t of windowTabs(win)) {
    const from = movedFrom.get(t.id);
    movedFrom.delete(t.id);
    if (from && windowHasClients(from)) moveTab(t, from);
  }
  windowWorkspace.delete(win); // its named workspace keeps the tabs it had; closing the window doesn't empty it
  if (worthSaving(windowTabs(win))) {
    const stamp = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    saveWindow(win, `Closed window ${stamp}`);
    pruneClosedWindowSaves(5);
  }
  for (const t of [...tabs.values()]) if (t.windowId === win) closeTab(t.id);
  windowIdle.delete(win);
  if (lastWindow === win) lastWindow = null;
  if (!APP_MODE && !clients.size && !tabs.size) shutdown(); // standalone: last window gone
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const asq = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function chooseFolder(tab: Tab): void {
  // Ask whichever app is frontmost (the UI window) to show the native picker, so it appears on top.
  const script = `tell application (path to frontmost application as text) to POSIX path of ` +
    `(choose folder with prompt "Folder for Claude Code" default location (POSIX file ${asq(tab.cwd)}))`;
  execFile('osascript', ['-e', script], (err, stdout) => {
    const dir = stdout.trim().replace(/\/$/, '') || '/';
    if (!err && stdout.trim()) void tab.typeCommand(cdCommand(dir));
  });
}

/** Welcome screen: go to one of the recent folders (and optionally start Claude there). */
function cdTo(tab: Tab, dir: string, launch: boolean): void {
  let ok = false;
  try { ok = path.isAbsolute(dir) && fs.statSync(dir).isDirectory(); } catch { /* gone */ }
  if (!ok) { toWindow(tab.windowId, { type: 'toast', text: 'That folder no longer exists' }); return; }
  void tab.typeCommand(cdCommand(dir, launch ? 'claude' : undefined));
}

// ---------- window ----------
let port = 0;
const pageUrl = (win?: string) => `http://127.0.0.1:${port}/?t=${token}${win ? `&w=${win}` : ''}`;
function openWindow(win: string): void {
  if (process.env.CLAUDE_PANE_NO_OPEN || APP_MODE) return;
  const chrome = '/Applications/Google Chrome.app';
  if (fs.existsSync(chrome)) execFile('open', ['-na', chrome, '--args', `--app=${pageUrl(win)}`]);
  else execFile('open', [pageUrl(win)]);
}
const pendingCwd = new Map<string, string>(); // window id -> folder for its first tab

// ---------- http ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/api/busy') {
    // The app asks before quitting / closing a window: which tabs have Claude mid-task?
    if (url.searchParams.get('t') !== token) { res.writeHead(403).end(); return; }
    const win = url.searchParams.get('w');
    const busy = [...tabs.values()].filter((t) => t.working && (!win || t.windowId === win))
      .map((t) => t.labelText || t.title);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ busy }));
    return;
  }
  if (url.pathname === '/api/debug') {
    // What process detection sees for each tab (support, and the smoke test's failure report).
    if (url.searchParams.get('t') !== token) { res.writeHead(403).end(); return; }
    void Promise.all([...tabs.values()].map(async (t) => ({ tab: t.id, ...(await t.debug()) }))).then((d) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(d, null, 1));
    });
    return;
  }
  if (url.pathname === '/api/quit' && req.method === 'POST') {
    // The app is quitting. (On Windows a child can't be asked to stop with a signal, only killed.)
    if (url.searchParams.get('t') !== token) { res.writeHead(403).end(); return; }
    res.writeHead(200).end('bye');
    setTimeout(shutdown, 20);
    return;
  }
  if (url.pathname === '/api/open' && req.method === 'POST') {
    // A second launch handing off: open a tab here instead of a second instance.
    if (url.searchParams.get('t') !== token) { res.writeHead(403).end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 10_000) req.destroy(); });
    req.on('end', () => {
      let cwd = os.homedir();
      try { const c = JSON.parse(body).cwd; if (typeof c === 'string' && fs.statSync(c).isDirectory()) cwd = c; } catch { /* default */ }
      const target = lastWindow && windowHasClients(lastWindow) ? lastWindow : clients.values().next().value;
      if (target) {
        const tab = openTab(target, cwd);
        toWindow(target, { type: 'focus-tab', tab: tab.id });
        if (!APP_MODE) execFile('osascript', ['-e', 'tell application "Google Chrome" to activate']);
      } else if (APP_MODE) {
        res.writeHead(503).end('no window open'); return; // the app opens windows, not us: let the caller run on its own
      } else {
        const win = crypto.randomUUID();
        pendingCwd.set(win, cwd);
        openWindow(win);
      }
      res.writeHead(200).end('ok');
    });
    return;
  }
  const file = staticFile(url.pathname);
  if (!file || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

// ---------- websocket ----------
let everConnected = false;
// Long enough to survive a reload or a sleep/wake reconnect.
const GRACE_MS = APP_MODE ? 60_000 : 15_000;
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, sock, head) => {
  const url = new URL(req.url ?? '/', 'http://x');
  // The ptys are live shells: require the token and our own origin.
  if (url.searchParams.get('t') !== token || req.headers.origin !== `http://127.0.0.1:${port}`) {
    sock.destroy(); return;
  }
  const win = (url.searchParams.get('w') ?? 'default').slice(0, 64);
  const detached = url.searchParams.get('detached') === '1'; // opened to receive a dragged-out tab
  wss.handleUpgrade(req, sock, head, (ws) => {
    if (!everConnected) console.log(`[timing] window connected +${since()}`);
    everConnected = true;
    clients.set(ws, win);
    lastWindow = win;
    for (const t of windowTabs(win)) movedFrom.delete(t.id);
    clearTimeout(windowIdle.get(win));
    windowIdle.delete(win);
    send(ws, { type: 'hello', home: os.homedir(), platform: process.platform });
    const mine = [...tabs.values()].filter((t) => t.windowId === win);
    for (const tab of mine) send(ws, { ...tab.snapshot(), tab: tab.id });
    send(ws, inboxMsg());
    if (windowWorkspace.has(win)) send(ws, { type: 'workspace-name', name: windowWorkspace.get(win) });
    void welcomeInfo().then((info) => send(ws, { type: 'welcome', ...info, workspaces: listWorkspaces() }));
    if (!mine.length && !detached) {
      // New window: first ever tab starts where we were launched (and auto-runs claude args).
      const cwd = pendingCwd.get(win) ?? (firstTab ? startCwd : os.homedir());
      pendingCwd.delete(win);
      openTab(win, cwd, firstTab ? autoArgs : undefined);
      firstTab = false;
    }
    ws.on('message', (raw) => {
      let m: any; try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type === 'list-workspaces') { send(ws, { type: 'workspaces', list: listWorkspaces() }); return; }
      if (m.type === 'save-workspace' && typeof m.name === 'string' && m.name.trim()) {
        saveWindow(win, m.name.trim(), String(m.active ?? ''));
        bindWorkspace(win, m.name.trim());
        send(ws, { type: 'toast', text: `Saved workspace "${m.name.trim()}"` });
        send(ws, { type: 'workspaces', list: listWorkspaces() });
        return;
      }
      if (m.type === 'open-workspace' && typeof m.name === 'string') {
        const err = openWorkspace(win, m.name);
        if (err) send(ws, { type: 'toast', text: err });
        return;
      }
      if (m.type === 'delete-workspace' && typeof m.name === 'string') {
        deleteWorkspace(m.name);
        for (const [w, n] of windowWorkspace) if (n === m.name) { windowWorkspace.delete(w); toWindow(w, { type: 'workspace-name', name: null }); }
        send(ws, { type: 'workspaces', list: listWorkspaces() });
        return;
      }
      if (m.type === 'welcome') { void welcomeInfo(!!m.fresh).then((info) => send(ws, { type: 'welcome', ...info, workspaces: listWorkspaces() })); return; }
      if (m.type === 'reopen-tab') { reopenClosedTab(win); return; }
      if (m.type === 'new-tab') {
        const from = tabs.get(String(m.from));
        const tab = openTab(win, from?.cwd ?? os.homedir());
        toWindow(win, { type: 'focus-tab', tab: tab.id });
        return;
      }
      const tab = tabs.get(String(m.tab));
      if (!tab) return;
      // The inbox acts on tabs in any window: answer a dialog, or bring a tab's window forward.
      if (m.type === 'dialog-pick' && typeof m.sig === 'string') { tab.pickDialog(m.index | 0, m.sig); return; }
      if (m.type === 'dialog-cancel' && typeof m.sig === 'string') { tab.cancelDialog(m.sig); return; }
      if (m.type === 'reveal') { toWindow(tab.windowId, { type: 'focus-tab', tab: tab.id, raise: true }); return; }
      if (tab.windowId !== win) return;
      if (m.type === 'input' && typeof m.data === 'string') tab.input(m.data);
      else if (m.type === 'resize') tab.resize(m.cols | 0, m.rows | 0);
      else if (m.type === 'choose-folder') {
        // The Electron host has its own folder dialog; the Mac app and a plain browser use AppleScript's.
        if (HOST_DIALOGS) send(ws, { type: 'pick-folder', tab: tab.id, cwd: tab.cwd }); else chooseFolder(tab);
      }
      else if (m.type === 'launch') void tab.typeCommand(m.kind === 'continue' ? 'claude -c' : m.kind === 'resume' ? 'claude --resume' : 'claude');
      else if (m.type === 'cd' && typeof m.dir === 'string') cdTo(tab, m.dir, !!m.launch);
      else if (m.type === 'install-claude') void tab.typeCommand(INSTALL_CLAUDE);
      else if (m.type === 'lunatic') tab.setLunatic(!!m.on);
      else if (m.type === 'close-tab') closeTab(tab.id, true);
      else if (m.type === 'redraw') tab.redraw();
      else if (m.type === 'send-queued') tab.sendQueuedNow();
      else if (m.type === 'move-tab' && typeof m.to === 'string') moveTab(tab, m.to.slice(0, 64));
    });
    ws.on('close', () => {
      clients.delete(ws);
      // Window closed (not just reloading or asleep): end its tabs after a grace period.
      if (!windowHasClients(win)) windowIdle.set(win, setTimeout(() => windowGone(win), GRACE_MS));
    });
  });
});

function listen(p: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(p, '127.0.0.1', () => { server.off('error', reject); resolve((server.address() as { port: number }).port); });
  });
}

function shutdown(): void {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  const all = [...tabs.values()];
  if (worthSaving(all)) saveWorkspace({ name: 'Last session', active: 0, tabs: all.map(tabRecord) });
  for (const tab of tabs.values()) tab.dispose();
  stopProcHelper();
  clearInstance();
  process.exit(0);
}
// Keep running on unexpected errors, but don't flood the log with one that repeats every tick.
const lastLogged = new Map<string, number>();
process.on('uncaughtException', (err) => {
  const key = String(err?.stack ?? err).slice(0, 300);
  if (Date.now() - (lastLogged.get(key) ?? 0) < 60_000) return;
  if (lastLogged.size > 200) lastLogged.clear();
  lastLogged.set(key, Date.now());
  console.error('claude-pane error:', err);
});
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);

async function main(): Promise<void> {
  console.log(`[timing] node started +${since()}`);
  if (!APP_MODE && !autoArgs.length && await handoff(startCwd)) {
    console.log(`[timing] handed off to running instance +${since()}`);
    process.exit(0);
  }
  try { port = await listen(PREFERRED_PORT); } catch { port = await listen(0); }
  writeInstance(port, token);
  console.log(`claude-pane: ${pageUrl()}\n[timing] listening +${since()}`);
  if (APP_MODE) {
    // The app is our parent; if it dies without stopping us, don't leave shells running.
    // (Windows doesn't re-parent orphans, so there we check that the app's process is still there.)
    const parent = process.ppid;
    const parentGone = () => { if (!WIN) return process.ppid === 1; try { process.kill(parent, 0); return false; } catch { return true; } };
    setInterval(() => { if (parentGone()) shutdown(); }, 2000);
  } else {
    openWindow(crypto.randomUUID());
    // Never got a window (e.g. browser failed to open): don't linger forever.
    setTimeout(() => { if (!everConnected) shutdown(); }, 60_000);
  }
}
void main();
