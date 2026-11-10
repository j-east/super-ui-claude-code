// Claude Code Super UI: Electron host (the Windows app; also runs on macOS for testing).
// Does what native/main.swift does on the Mac: starts the Node server (build/server.js) as a child
// process, shows each window's UI, and provides menus, notifications, folder dialogs and quit warnings.
const { app, BrowserWindow, Menu, Notification, dialog, shell, screen, ipcMain, powerMonitor } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NAME = 'Claude Code Super UI';
const MAC = process.platform === 'darwin';
const SERVER = path.join(__dirname, '..', 'build', 'server.js');
app.setName(NAME);
if (process.platform === 'win32') app.setAppUserModelId('world.pathwriter.claude-super-ui'); // notifications need it

// ---------- server child process ----------
let child = null;
let baseUrl = null;      // http://127.0.0.1:<port>/?t=<token>
let stopping = false;
const ready = [];
const whenReady = (f) => { if (baseUrl) f(baseUrl); else ready.push(f); };

function startServer() {
  const logDir = app.getPath('logs');
  const logFile = path.join(logDir, 'claude-super-ui.log');
  let log = null;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    // Private (it holds the page URL with its access token) and rotated at 5 MB.
    try { if (fs.statSync(logFile).size > 5_000_000) fs.renameSync(logFile, logFile + '.1'); } catch { /* no log yet */ }
    log = fs.createWriteStream(logFile, { flags: 'a', mode: 0o600 });
    log.write(`--- ${new Date().toISOString()} app launch\n`);
  } catch { /* run without a log */ }

  child = spawn(process.execPath, [SERVER], {
    cwd: os.homedir(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CLAUDE_PANE_APP: '1', CLAUDE_PANE_HOST: 'electron', CLAUDE_PANE_T0: String(Date.now() / 1000) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let buf = '';
  const onData = (d) => {
    log?.write(d);
    if (baseUrl) return;
    buf += d;
    const m = buf.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+/);
    if (m) { baseUrl = m[0]; ready.splice(0).forEach((f) => f(baseUrl)); }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const failed = (what) => {
    if (stopping) return;
    stopping = true;
    dialog.showErrorBox(`${NAME}: the server stopped`, `${what}\n\nDetails are in ${logFile}`);
    app.exit(1);
  };
  child.on('error', (e) => failed(`Couldn't start it: ${e.message}`));
  child.on('exit', (code) => failed(`It exited with code ${code}.`));
}

const api = (pathname, extra = '') => {
  const u = new URL(baseUrl);
  return `${u.origin}${pathname}?t=${u.searchParams.get('t')}${extra}`;
};

/** Ask the server to save and stop; kill it if it doesn't. */
async function stopServer() {
  stopping = true;
  if (!child || child.exitCode !== null) return;
  const gone = new Promise((r) => child.once('exit', r));
  try { if (baseUrl) await fetch(api('/api/quit'), { method: 'POST', signal: AbortSignal.timeout(1500) }); } catch { /* kill below */ }
  await Promise.race([gone, new Promise((r) => setTimeout(r, 2000))]);
  if (child.exitCode === null) child.kill();
}

/** Titles of tabs where Claude is mid-task (all windows, or one). Empty if the server can't say. */
async function busyTabs(windowId) {
  if (!baseUrl) return [];
  try {
    const r = await fetch(api('/api/busy', windowId ? `&w=${encodeURIComponent(windowId)}` : ''), { signal: AbortSignal.timeout(1500) });
    const d = await r.json();
    return Array.isArray(d.busy) ? d.busy.map(String) : [];
  } catch { return []; }
}

function busyQuestion(busy, action) {
  const n = busy.length;
  return {
    type: 'warning',
    message: n === 1 ? 'Claude is still working in 1 tab' : `Claude is still working in ${n} tabs`,
    detail: busy.slice(0, 8).map((t) => `• ${t}`).join('\n') + (n > 8 ? `\n…and ${n - 8} more` : '') +
      `\n\nIf you ${action === 'Quit' ? 'quit' : 'close it'} now, those tasks stop where they are.`,
    buttons: [action === 'Quit' ? 'Quit Anyway' : 'Close Anyway', 'Cancel'],
    defaultId: 1, cancelId: 1, noLink: true,
  };
}

// ---------- windows ----------
const panes = new Map(); // window id -> { id, win, waiting, closeConfirmed }
const paneOf = (win) => [...panes.values()].find((p) => p.win === win) ?? null;
const keyPane = () => paneOf(BrowserWindow.getFocusedWindow()) ?? [...panes.values()].at(-1) ?? null;
const js = (p, code) => (p && !p.win.isDestroyed() ? p.win.webContents.executeJavaScript(code, true).catch(() => undefined) : Promise.resolve(undefined));
const q = (s) => JSON.stringify(String(s));

/** `detached`: opened to receive a tab dragged out of another window (no starter shell tab). */
function openWindow({ detached = false, bounds = null } = {}) {
  const id = crypto.randomUUID();
  const last = [...panes.values()].at(-1)?.win.getBounds();
  const win = new BrowserWindow({
    width: 1180, height: 820, minWidth: 520, minHeight: 360,
    ...(bounds ?? (last ? { x: last.x + 28, y: last.y + 28 } : {})),
    title: NAME, backgroundColor: '#262624', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: false },
  });
  const p = { id, win, waiting: 0, closeConfirmed: false };
  panes.set(id, p);
  win.once('ready-to-show', () => win.show());

  // Links (target=_blank or anything off our server) open in the default browser.
  const ours = (u) => { try { return new URL(u).origin === new URL(baseUrl).origin; } catch { return false; } };
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!ours(url)) { e.preventDefault(); if (/^https?:/.test(url)) void shell.openExternal(url); } });
  // The page's process crashed (or was killed for memory): reload it. The server keeps the tabs alive.
  win.webContents.on('render-process-gone', () => { if (!win.isDestroyed()) win.webContents.reload(); });

  // Closing a window ends its tabs: ask first if Claude is mid-task in any of them.
  win.on('close', (e) => {
    if (p.closeConfirmed || quitting) return;
    e.preventDefault();
    void busyTabs(id).then(async (busy) => {
      if (busy.length) {
        const r = await dialog.showMessageBox(win, busyQuestion(busy, 'Close Window'));
        if (r.response !== 0) return;
      }
      p.closeConfirmed = true;
      win.close();
    });
  });
  win.on('closed', () => { panes.delete(id); updateBadge(); });

  whenReady((url) => { void win.loadURL(`${url}&w=${id}${detached ? '&detached=1' : ''}`); });
  return p;
}

function updateBadge() {
  let total = 0;
  for (const p of panes.values()) total += p.waiting;
  if (MAC) app.setBadgeCount(total);
  else for (const p of panes.values()) if (!p.win.isDestroyed()) p.win.flashFrame(p.waiting > 0 && !p.win.isFocused());
}

/** A tab was dragged out of `src`'s tab bar and released. Over another of our windows: move it there.
 *  Anywhere else: give it a new window under the mouse (unless it was the window's only tab). */
function tabDropped(src, tab, only) {
  const pt = screen.getCursorScreenPoint();
  const inside = (b) => pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + b.height;
  if (!inside(src.win.getBounds())) {
    const target = BrowserWindow.getAllWindows().map(paneOf).find((t) => t && t !== src && t.win.isVisible() && inside(t.win.getBounds()));
    if (target) { void js(src, `window.cp?.moveTab(${q(tab)}, ${q(target.id)})`); target.win.focus(); return; }
  }
  if (only) return; // nothing to split off
  const b = src.win.getBounds();
  const p = openWindow({ detached: true, bounds: { x: pt.x - 90, y: pt.y - 16, width: b.width, height: b.height } }); // tab bar under the cursor
  void js(src, `window.cp?.moveTab(${q(tab)}, ${q(p.id)})`);
}

// Page -> app messages (the same ones the Mac app's script bridge takes).
ipcMain.on('cp-host', (e, d) => {
  const p = paneOf(BrowserWindow.fromWebContents(e.sender));
  if (!p || !d || typeof d.type !== 'string') return;
  switch (d.type) {
    case 'notify': {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title: String(d.title ?? ''), body: String(d.body ?? '') });
      // Clicking a notification: bring that window forward and switch to the tab.
      n.on('click', () => { if (p.win.isDestroyed()) return; if (p.win.isMinimized()) p.win.restore(); p.win.show(); p.win.focus(); void js(p, `window.cp?.activate(${q(d.tab)})`); });
      n.show();
      return;
    }
    case 'badge': p.waiting = Number(d.count) || 0; updateBadge(); return;
    case 'tab-dropped': tabDropped(p, String(d.tab ?? ''), !!d.only); return;
    case 'raise': if (p.win.isMinimized()) p.win.restore(); p.win.show(); p.win.focus(); return; // the inbox in another window asked for a tab here
    case 'close-window': p.closeConfirmed = true; p.win.close(); return; // its last tab moved out
    case 'choose-folder': {
      const opts = { title: 'Folder for Claude Code', properties: ['openDirectory', 'createDirectory'] };
      if (typeof d.cwd === 'string' && fs.existsSync(d.cwd)) opts.defaultPath = d.cwd;
      void dialog.showOpenDialog(p.win, opts).then((r) => {
        if (!r.canceled && r.filePaths[0]) void js(p, `window.cp?.cd(${q(d.tab)}, ${q(r.filePaths[0])})`);
      });
      return;
    }
  }
});

// ---------- menus ----------
function buildMenu() {
  // Windows: Ctrl+letter belongs to the terminal (Ctrl+C!), so app shortcuts are Ctrl+Shift+letter.
  const k = (key) => (MAC ? `Cmd+${key}` : `Ctrl+Shift+${key}`);
  const cp = (code) => () => void js(keyPane(), `window.cp?.${code}`);
  const newTab = () => { if (keyPane()) void js(keyPane(), 'window.cp?.newTab()'); else openWindow(); };
  const closeTab = async () => {
    const p = keyPane();
    if (!p) return;
    const closed = await js(p, 'window.cp ? window.cp.closeTab() : false');
    if (closed !== true) p.win.close();
  };
  const template = [
    ...(MAC ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'New Tab', accelerator: k('T'), click: newTab },
      { label: 'New Window', accelerator: MAC ? 'Cmd+Shift+N' : 'Ctrl+Shift+N', click: () => openWindow() },
      { type: 'separator' },
      { label: 'Save Workspace…', accelerator: MAC ? 'Cmd+Alt+S' : 'Ctrl+Shift+S', click: cp('saveWorkspace()') },
      { label: 'Open Workspace…', accelerator: MAC ? 'Cmd+Alt+O' : 'Ctrl+Shift+O', click: cp('openWorkspaceMenu()') },
      { type: 'separator' },
      { label: 'Close Tab', accelerator: k('W'), click: () => void closeTab() },
      { label: 'Reopen Closed Tab', accelerator: MAC ? 'Cmd+Shift+T' : 'Ctrl+Shift+Z', click: cp('reopenTab()') },
      { label: 'Close Window', accelerator: MAC ? 'Cmd+Shift+W' : 'Alt+F4', click: () => keyPane()?.win.close() },
      ...(MAC ? [] : [{ type: 'separator' }, { role: 'quit', label: 'Exit' }]),
    ] },
    { label: 'Edit', submenu: [
      { role: 'copy', accelerator: k('C') },
      { role: 'paste', accelerator: k('V') },
      { role: 'selectAll', accelerator: k('A') },
    ] },
    { label: 'View', submenu: [
      { label: 'Next Tab', accelerator: MAC ? 'Cmd+Shift+]' : 'Ctrl+Tab', click: cp('nextTab()') },
      { label: 'Previous Tab', accelerator: MAC ? 'Cmd+Shift+[' : 'Ctrl+Shift+Tab', click: cp('prevTab()') },
      { label: 'Jump to Waiting Tab', accelerator: k('J'), click: cp('jumpToAttention()') },
      { type: 'separator' },
      { label: 'Split View', accelerator: k('\\'), click: cp('toggleSplit()') },
      { label: 'Inbox', accelerator: k('I'), click: cp('toggleInbox()') },
      { label: 'Redraw Terminal', accelerator: MAC ? 'Cmd+Shift+L' : 'Ctrl+Shift+L', click: cp('redraw()') },
      { label: 'Reload Window', accelerator: k('R'), click: () => keyPane()?.win.webContents.reload() },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { label: 'Developer Tools', accelerator: 'F12', click: () => keyPane()?.win.webContents.toggleDevTools() },
    ] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- app ----------
let quitting = false;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => openWindow());
  app.whenReady().then(() => {
    buildMenu();
    startServer();
    openWindow();
    // Wake from sleep: repaint every window's terminal once things settle.
    powerMonitor.on('resume', () => setTimeout(() => { for (const p of panes.values()) void js(p, 'window.cp?.redraw()'); }, 1500));
  });
  app.on('activate', () => { if (!panes.size) openWindow(); });
  // Windows: closing the last window exits. macOS: the app stays in the Dock.
  app.on('window-all-closed', () => { if (!MAC) app.quit(); });

  // Quitting ends every tab: ask first if Claude is mid-task anywhere, then let the server save and stop.
  app.on('before-quit', (e) => {
    if (quitting) return;
    e.preventDefault();
    void (async () => {
      // (Closing the last window on Windows already asked about that window's tabs.)
      const busy = panes.size ? await busyTabs(null) : [];
      if (busy.length) {
        const r = await dialog.showMessageBox(busyQuestion(busy, 'Quit'));
        if (r.response !== 0) return;
      }
      quitting = true;
      await stopServer();
      app.quit();
    })();
  });
}
