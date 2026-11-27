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
import { cachedLabel } from './labeler.js';
import { WIN, DATA_DIR, INSTALL_CLAUDE, shq, cdCommand } from './platform.js';
import { stopProcHelper } from './procwatch.js';
import { clearRecordTool, forgetTab, handleNotes, handleRecordTool, recordToolEnv, type LaneRequest } from './recordtool.js';
import { projectRoot, recordText, initRegistrar, registrarMsg, poke as pokeRegistrar, runNow as runRegistrar, setOn as setRegistrarOn, forgetDecision, closeFlag, takeNotes, dropNote } from './registrar.js';
import { scheduling, setScheduling } from './prefs.js';
import { findSessions } from './findsession.js';
import { sessionText } from './steward.js';
import { findTranscript, parseLine, type Entry } from './transcript.js';
import { addLater, digestLater, laterFor, takeLater, pruneOpen, renameLater, reviewTabs, wrapUp } from './later.js';
import { saveWorkspace, loadWorkspace, listWorkspaces, deleteWorkspace, renameWorkspace, pruneClosedWindowSaves, pruneAutoWorkspaces, type WorkspaceTab } from './workspaces.js';

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
const TYPES: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png' };

function staticFile(p: string): string | null {
  if (p === '/') return path.join(ROOT, 'public/index.html');
  const v = p.match(/^\/vendor\/([\w.-]+)$/);
  if (v) return VENDOR[v[1]!] ? path.join(NM, VENDOR[v[1]!]!) : null;
  const pub = p.match(/^\/([\w-]+\.(?:js|css|html|png))$/);
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

// ---------- registrar: what the sessions in each project are doing and have decided ----------
let regTimer: NodeJS.Timeout | null = null;
function scheduleRegistrar(): void {
  regTimer ??= setTimeout(() => { regTimer = null; for (const [ws, w] of clients) send(ws, registrarFor(w)); }, 200);
}
const registrarFor = (win: string) => registrarMsg(new Set([...tabs.values()].filter((t) => t.windowId === win).map((t) => t.id)));
initRegistrar(() => [...tabs.values()].flatMap((t) => (t.role ? [] : t.registrarInput() ?? [])), scheduleRegistrar);

function openTab(win: string, cwd: string, claudeArgs?: string[], lane?: { group: string; lane: string; charter: string }, role = ''): Tab {
  const id = String(nextId++);
  // Route by the tab's current window: tabs can be moved between windows.
  const tab: Tab = new Tab(id, win, cwd, (msg) => {
    toWindow(tab.windowId, { ...msg, tab: id });
    if (INBOX_EVENTS.has(String(msg.type))) scheduleInbox();
    if (msg.type === 'label' || msg.type === 'mode') scheduleRegistrar();
    if (msg.type === 'activity' && msg.busy === false) pokeRegistrar(); // a turn ended
    if (msg.type === 'mode' || msg.type === 'transcript-reset') scheduleAutosave(); // a session started or changed
  }, recordToolEnv(id, port, lane?.lane, lane?.charter, role));
  tab.role = role;
  tab.group = lane?.group || id;
  if (lane) { tab.lane = lane.lane; tab.charter = lane.charter; }
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
  scheduleRegistrar();
  scheduleAutosave();
  toWindow(to, { ...tab.snapshot(), tab: tab.id });
  toWindow(to, { type: 'focus-tab', tab: tab.id });
  // Target window not connected yet (just being opened): same grace as a window that went away.
  if (!windowHasClients(to) && !windowIdle.has(to)) windowIdle.set(to, setTimeout(() => windowGone(to), GRACE_MS));
  if (!windowTabs(from).length) toWindow(from, { type: 'window-empty' });
}

/** Each window's list of closed tabs (the ones closed in its workspace). */
function sendLater(only?: WebSocket): void {
  for (const [ws, w] of clients) if (!only || ws === only) send(ws, { type: 'later', items: laterFor(windowWorkspace.get(w) ?? ''), scheduling: scheduling() });
}

/** Tabs you closed (newest last), so Cmd+Z can bring one back with its session resumed. */
const closedTabs: (WorkspaceTab & { win: string })[] = [];

/** `remember`: you closed it yourself (not a whole window going away), so it can be reopened. */
function closeTab(id: string, remember = false, left = ''): void {
  const tab = tabs.get(id);
  if (!tab) return;
  if (remember && !tab.role) { // (the Steward is not a piece of work: it just closes)
    // Closed by you: no longer in progress. It goes on the Closed list and is digested in the background.
    const input = tab.cleanupInput();
    const item = addLater(tabRecord(tab), windowWorkspace.get(tab.windowId) ?? '', left);
    if (item && input) digestLater(item, input, () => sendLater());
    sendLater();
  }
  if (remember && !tab.role) { closedTabs.push({ ...tabRecord(tab), win: tab.windowId }); if (closedTabs.length > 20) closedTabs.shift(); }
  tabs.delete(id);
  resumeIds.delete(id);
  forgetTab(id);
  scheduleRegistrar();
  tab.dispose();
  toWindow(tab.windowId, { type: 'tab-closed', tab: id });
  scheduleInbox();
  scheduleAutosave();
}

/** Open a tab for a saved record: its folder, and its Claude session resumed if it had one. */
function restoreTab(win: string, rec: WorkspaceTab, group?: string): Tab {
  const lane = typeof rec.lane === 'string' && rec.lane ? rec.lane.slice(0, 40) : '';
  const tab = openTab(win, fs.existsSync(rec.cwd) ? rec.cwd : os.homedir(), undefined,
    group || lane ? { group: group ?? '', lane, charter: typeof rec.charter === 'string' ? rec.charter.slice(0, 3000) : '' } : undefined,
    rec.role === 'steward' ? 'steward' : '');
  // Workspace files can be edited by hand: only ever type a well-formed session id.
  const id = typeof rec.sessionId === 'string' && UUID.test(rec.sessionId) ? rec.sessionId : null;
  // Waits (up to 20 s) for the new tab's login shell to finish starting before typing.
  if (id && rec.label) tab.seedLabel(rec.label);
  const more = rec.role === 'steward' ? stewardArgs(win) : '';
  if (id) { resumeIds.set(tab.id, id); void tab.typeCommand(`claude --resume ${id}${more}`, 20_000); }
  else if (rec.claude) void tab.typeCommand(`claude${more}`, 20_000);
  return tab;
}

function reopenClosedTab(win: string): void {
  const rec = closedTabs.pop();
  if (!rec) { toWindow(win, { type: 'toast', text: 'No closed tab to reopen' }); return; }
  // Back under the tab it was a lane of, if that tab (or another of its lanes) is still open here.
  const tab = restoreTab(win, rec, windowTabs(win).some((t) => t.group === rec.group) ? rec.group : undefined);
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
  return { cwd: t.cwd, sessionId, title: t.title, claude: t.claudeRunning || (!!pending && !t.sessionId), label: t.savedLabel,
    id: t.id, group: t.group, ...(t.lane ? { lane: t.lane, charter: t.charter } : {}), ...(t.role ? { role: t.role } : {}) };
};
const worthSaving = (list: Tab[]) => list.some((t) => t.sessionId);

// ---------- autosave ----------
// A window becomes a workspace by being used: once it holds a Claude session it gets a name (from the
// project folder) and is saved as tabs come and go, with no Save step. Rename it to keep it for good;
// only the newest few the app named itself are kept. "Last session" is kept current the same way, so a
// crash loses nothing.
const windowWorkspace = new Map<string, string>(); // window id -> workspace it is saved as
const AUTO_NAME = /^(Last session$|Closed window )/;
const AUTO_KEPT = 8;
let autosaveTimer: NodeJS.Timeout | null = null;
function bindWorkspace(win: string, name: string): void {
  if (AUTO_NAME.test(name)) return;
  windowWorkspace.set(win, name);
  toWindow(win, { type: 'workspace-name', name });
  sendLater();
  for (const [ws, w] of clients) if (w === win) sendWelcome(ws); // its Resume list is the workspace's own
}
/** A name for a window nobody has named: the folder most of its sessions work in. */
function nameFor(win: string): string {
  const count = new Map<string, number>();
  for (const t of windowTabs(win)) if (t.sessionId) { const k = path.basename(projectRoot(t.cwd)) || 'Workspace'; count.set(k, (count.get(k) ?? 0) + 1); }
  const base = [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Workspace';
  const taken = new Set(listWorkspaces().map((w) => w.name.toLowerCase()));
  let name = base;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base} ${i}`;
  return name;
}
function autosave(): void {
  autosaveTimer = null;
  for (const win of new Set(clients.values())) {
    if (windowWorkspace.has(win) || !worthSaving(windowTabs(win))) continue;
    const name = nameFor(win);
    saveWorkspace({ name, active: 0, tabs: windowTabs(win).map(tabRecord), auto: true });
    bindWorkspace(win, name);
    pruneAutoWorkspaces(AUTO_KEPT, new Set(windowWorkspace.values()));
    toWindow(win, { type: 'toast', text: `This window is now the workspace "${name}". It saves itself as you work.` });
    toWindow(win, { type: 'workspaces', list: listWorkspaces() });
  }
  for (const [win, name] of windowWorkspace) if (windowTabs(win).length) saveWindow(win, name);
  const all = [...tabs.values()];
  if (worthSaving(all)) saveWorkspace({ name: 'Last session', active: 0, tabs: all.map(tabRecord) });
  // The start screen's "Resume a session" list leaves out open sessions, so it follows them.
  const ids = all.flatMap((t) => tabRecord(t).sessionId ?? []).sort();
  const open = ids.join();
  if (open !== welcomeOpen) { welcomeOpen = open; for (const ws of clients.keys()) sendWelcome(ws); }
  if (pruneOpen(new Set(ids))) sendLater(); // a closed tab that is open again is off the list
}
let welcomeOpen = '';
function scheduleAutosave(): void { autosaveTimer ??= setTimeout(autosave, 1500); }

function saveWindow(win: string, name: string, activeTab?: string, auto?: boolean): void {
  const list = windowTabs(win);
  saveWorkspace({ name, active: Math.max(0, list.findIndex((t) => t.id === activeTab)), tabs: list.map(tabRecord), auto });
}

/** Reopen a workspace's tabs in `win`, resuming each Claude session. Skips sessions already open. */
function openWorkspace(win: string, name: string): string | null {
  const w = loadWorkspace(name);
  if (!w) return `Workspace "${name}" not found`;
  const here = windowWorkspace.get(win);
  if (here && here !== w.name) return `Close "${here}" first (click its name in the top bar), then open "${w.name}"`;
  // Only sessions with Claude actually running count as open (an exited one can be resumed again).
  const openIds = new Set([...tabs.values()].filter((t) => t.claudeRunning).map((t) => t.sessionId).filter(Boolean));
  // A window holding only one untouched shell tab gets replaced rather than kept.
  const existing = windowTabs(win);
  const replace = existing.length === 1 && !existing[0]!.claudeRunning && !existing[0]!.sessionId ? existing[0] : null;
  const opened: Tab[] = [];
  const groups = new Map<string, string>(); // saved group key -> the group its tabs are in now
  for (const rec of w.tabs) {
    if (rec.sessionId && openIds.has(rec.sessionId)) continue;
    const tab = restoreTab(win, rec, rec.group ? groups.get(rec.group) : undefined);
    if (rec.group && !groups.has(rec.group)) groups.set(rec.group, tab.group);
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
  // Its workspace keeps the tabs it had; closing the window doesn't empty it.
  const bound = windowWorkspace.get(win);
  if (bound && windowTabs(win).length) saveWindow(win, bound);
  windowWorkspace.delete(win);
  if (!bound && worthSaving(windowTabs(win))) {
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

/**
 * A session asked for a lane (the open_lane tool): a sub-tab under the asking tab, in the same folder,
 * running Claude with the lane's charter, and the prompt typed into its input box but not sent.
 */
function openLane(from: string, r: LaneRequest): { text: string; isError?: boolean } {
  const parent = tabs.get(from);
  if (!parent) return { text: 'This tab is no longer open in Claude Code Super UI.', isError: true };
  const mates = [...tabs.values()].filter((t) => t.group === parent.group && t.windowId === parent.windowId);
  let tab = mates.find((t) => t.lane === r.lane && t.claudeRunning && t !== parent);
  const existing = !!tab;
  if (!tab) {
    if (mates.length >= 8) return { text: 'This tab already has 8 sessions under it. Ask the user to close one first.', isError: true };
    tab = openTab(parent.windowId, parent.registrarInput()?.cwd ?? parent.cwd, undefined, { group: parent.group, lane: r.lane, charter: r.charter });
    void tab.typeCommand('claude', 20_000);
  }
  const lane = tab;
  toWindow(lane.windowId, { type: 'focus-tab', tab: lane.id });
  draftWhenReady(lane, r.prompt, existing);
  return { text: existing
    ? `The "${r.lane}" lane was already open beside this session. The prompt is being typed into its input box; the user reviews it and presses Enter. Drop the task here.`
    : `Opened the "${r.lane}" lane as a sub-tab beside this session. The prompt is being typed into its input box once Claude starts; the user reviews it and presses Enter. Drop the task here.` };
}

/** Type `prompt` into a tab's Claude input box (unsent) once Claude is up and showing it, not a question such as "trust this folder?". */
function draftWhenReady(tab: Tab, prompt: string, alreadyUp = false, send = false): void {
  let tries = 0, ready = alreadyUp ? 3 : 0;
  const timer = setInterval(() => {
    if (!tabs.has(tab.id) || ++tries > 90) { clearInterval(timer); return; }
    if (!tab.claudeRunning || tab.hasDialog) { ready = 0; return; }
    if (++ready < 4) return; // up for about two seconds
    clearInterval(timer);
    tab.draft(prompt);
    if (send) setTimeout(() => { if (tabs.has(tab.id) && tab.claudeRunning && !tab.hasDialog) tab.input('\r'); }, 600);
  }, 500);
}

// ---------- session tools: restart, hand off, split ----------
const restarts = new Map<string, NodeJS.Timeout>();
/**
 * Restart the Claude in a tab once it is idle: quit it, then start it again in the same tab.
 * 'reload' resumes the same conversation (skills, MCP servers, hooks and settings are read afresh);
 * 'fresh' starts a new one. `then` is sent as the first message afterwards.
 */
function queueRestart(tab: Tab, mode: 'reload' | 'fresh', then = ''): { text: string; isError?: boolean } {
  if (!tab.claudeRunning) return { text: 'Claude is not running in this tab.', isError: true };
  if (mode === 'reload' && !tab.sessionId) return { text: 'This session has no conversation to resume yet. Send a message first, or use mode "fresh".', isError: true };
  clearInterval(restarts.get(tab.id));
  let idle = 0, tries = 0;
  const stop = () => { clearInterval(restarts.get(tab.id)); restarts.delete(tab.id); };
  const say = (text: string) => toWindow(tab.windowId, { type: 'toast', text });
  restarts.set(tab.id, setInterval(() => {
    if (!tabs.has(tab.id) || !tab.claudeRunning || ++tries > 1800) { stop(); return; }
    if (tab.working || tab.hasDialog) { idle = 0; return; }
    if (++idle < 3) return; // quiet for three seconds: the turn is over
    stop();
    const sid = tab.sessionId;
    if (mode === 'reload' && !sid) { say('Could not reload: this session has no conversation yet'); return; }
    if (!tab.endClaude()) return;
    void (async () => {
      for (let i = 0; i < 40 && tab.claudeRunning; i++) await new Promise((r) => setTimeout(r, 250));
      if (!tabs.has(tab.id)) return;
      if (tab.claudeRunning) { say('Claude did not quit, so the session was not restarted'); return; }
      if (mode === 'reload') resumeIds.set(tab.id, sid!);
      if (!(await tab.typeCommand(mode === 'reload' ? `claude --resume ${sid}` : 'claude', 15_000))) { say('Could not restart Claude in this tab: its shell is busy'); return; }
      say(mode === 'reload' ? 'Session reloaded: same conversation, fresh skills, MCP servers and settings' : 'Fresh session started');
      if (then) draftWhenReady(tab, then, false, true);
    })();
  }, 1000));
  return { text: `Queued. As soon as this turn ends, Claude Code quits and ${mode === 'reload' ? 'resumes this conversation with everything reloaded' : 'starts a new conversation in this tab'}` +
    `${then ? ', and your `then` message is sent' : ''}. Finish your reply briefly and stop now.` };
}

const HANDOFF = 'Write a handoff document for this conversation so a new session can carry on without it. Save it in this project (the place it already keeps such notes, otherwise docs/handoff/<date>-<topic>.md). ' +
  'Cover: the goal, what is done and where it lives (files, branches, links), decisions made and why, what is in progress, what is left, and anything that surprised us. Write it for a reader with none of this context. ' +
  'Then call mcp__registrar__restart_session with mode "fresh" and then set to "Read <that file> and continue from it."';

/** A second copy of a tab's conversation, as a sub-tab beside it, so the two can go separate ways. */
function splitSession(tab: Tab): void {
  const say = (text: string) => toWindow(tab.windowId, { type: 'toast', text });
  const sid = tab.sessionId;
  if (!tab.claudeRunning || !sid) { say('Nothing to split yet: this tab has no conversation'); return; }
  const mates = windowTabs(tab.windowId).filter((t) => t.group === tab.group);
  if (mates.length >= 8) { say('This tab already has 8 sessions under it'); return; }
  let name = 'split';
  for (let i = 2; mates.some((t) => t.lane === name); i++) name = `split-${i}`;
  const copy = openTab(tab.windowId, tab.registrarInput()?.cwd ?? tab.cwd, undefined, { group: tab.group, lane: name,
    charter: 'A copy of the conversation in the tab beside it, taken when the user split it in two. The user will say which direction this copy takes; the other tab keeps the rest.' });
  if (tab.savedLabel) copy.seedLabel(tab.savedLabel);
  void copy.typeCommand(`claude --resume ${sid} --fork-session`, 20_000);
  toWindow(tab.windowId, { type: 'focus-tab', tab: copy.id });
}

// ---------- the Steward ----------
/** The folder most of a window's sessions work in. */
function mainFolder(win: string): string {
  const count = new Map<string, number>();
  for (const t of windowTabs(win)) if (!t.role) { const c = t.registrarInput()?.cwd ?? t.cwd; count.set(c, (count.get(c) ?? 0) + (t.claudeRunning ? 2 : 1)); }
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? os.homedir();
}
/** Go to this window's Steward session, starting one if there is none. */
/**
 * Where a window's Steward runs: a folder of its own under the app's data folder, one per workspace.
 * Its conversations are the app's housekeeping, so they stay out of the project's session logs (and so
 * out of Resume and Find a session). The workspace's real folders are handed to it with --add-dir.
 */
function stewardDir(win: string): string {
  const name = (windowWorkspace.get(win) || 'window').replace(/[^\w .-]+/g, '_').trim().slice(0, 80) || 'window';
  const dir = path.join(DATA_DIR, 'steward', name);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* falls back below */ }
  return fs.existsSync(dir) ? dir : mainFolder(win);
}
/** The --add-dir flag giving a Steward the workspace's folders (it runs outside them). */
function stewardArgs(win: string): string {
  const dirs = [...new Set([mainFolder(win), ...workspaceFolders(win)])].filter((d) => !d.startsWith(DATA_DIR) && fs.existsSync(d)).slice(0, 8);
  return dirs.length ? ` --add-dir ${dirs.map(shq).join(' ')}` : '';
}
function openSteward(win: string): Tab {
  let tab = windowTabs(win).find((t) => t.role === 'steward');
  if (!tab) {
    tab = openTab(win, stewardDir(win), undefined, undefined, 'steward');
    tab.seedLabel({ label: 'Steward', summary: 'Organises this workspace: gathers tasks, opens and closes sessions, keeps its instructions current.' });
    void tab.typeCommand(`claude${stewardArgs(win)}`, 20_000);
  } else if (!tab.claudeRunning) void tab.typeCommand(`claude${stewardArgs(win)}`, 20_000);
  toWindow(win, { type: 'focus-tab', tab: tab.id });
  return tab;
}
/** One call to a Steward tool from the Steward session in tab `from`. Null if that tab is not a Steward. */
function stewardTool(from: string, name?: string, args: Record<string, unknown> = {}): { text: string; isError?: boolean } | null {
  const me = tabs.get(from);
  if (!me || me.role !== 'steward') return null;
  if (!name) return { text: '' };
  const win = me.windowId;
  const ws = windowWorkspace.get(win) ?? '';
  const open = () => windowTabs(win).filter((t) => !t.role);
  const state = (t: Tab) => (!t.claudeRunning ? 'plain shell, no Claude running' : t.hasDialog ? 'WAITING on the user' : t.working ? 'WORKING now' : 'idle');
  const err = (text: string) => ({ text, isError: true });
  const handle = String(args.id ?? '').trim();
  if (name === 'list_sessions') {
    const o = open().map((t) => `T${t.id} | ${t.savedLabel?.label || t.title || '(unnamed)'} | ${state(t)} | ${t.registrarInput()?.cwd ?? t.cwd}${t.lane ? ` | lane ${t.lane}` : ''}` +
      (t.savedLabel?.summary ? `\n    ${t.savedLabel.summary}` : ''));
    const c = laterFor(ws).map((i) => `C${i.id} | ${i.label} | closed ${new Date(i.closedAt).toISOString().slice(0, 10)} | ${i.cwd}` +
      (i.outcome ? `\n    Outcome: ${i.outcome}` : i.summary ? `\n    ${i.summary}` : '') + (i.loose ?? []).map((l) => `\n    Loose end: ${l}`).join(''));
    return { text: `Workspace: ${ws || '(this window is not a saved workspace yet)'}\nMain folder: ${mainFolder(win)}\n\nOpen sessions (${o.length}):\n${o.join('\n') || '(none)'}\n\nClosed sessions with loose ends (${c.length}):\n${c.join('\n') || '(none)'}` };
  }
  if (name === 'read_session') {
    if (/^T\d+$/.test(handle)) {
      const t = open().find((x) => x.id === handle.slice(1));
      const input = t?.registrarInput();
      if (!t) return err(`No open session ${handle}. Call list_sessions for the current handles.`);
      return { text: input ? `${sessionText(input.label, input.entries)}\n\nState: ${state(t)}` : `${handle} is a plain shell with no Claude session.` };
    }
    const it = laterFor(ws).find((i) => `C${i.id}` === handle);
    if (!it) return err(`No session ${handle}. Call list_sessions for the current handles.`);
    const file = findTranscript(it.sessionId);
    let entries: Entry[] = [];
    try { if (file) entries = fs.readFileSync(file, 'utf8').split('\n').flatMap(parseLine); } catch { /* unreadable */ }
    return { text: `${sessionText(it.label, entries)}\n\nState: closed${it.outcome ? `\nDigest: ${it.outcome}` : ''}${(it.loose ?? []).map((l) => `\nLoose end: ${l}`).join('')}` };
  }
  if (name === 'open_session') {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim().slice(0, 6000) : '';
    const label = typeof args.name === 'string' ? args.name.trim().slice(0, 60) : '';
    if (!prompt) return err('open_session needs a prompt.');
    let dir = typeof args.folder === 'string' && args.folder.trim() ? args.folder.trim() : mainFolder(win);
    try { if (!path.isAbsolute(dir) || !fs.statSync(dir).isDirectory()) return err(`"${dir}" is not a folder on this computer.`); } catch { return err(`"${dir}" is not a folder on this computer.`); }
    if (windowTabs(win).length >= 30) return err('This window already has 30 tabs. Close some first.');
    const tab = openTab(win, dir);
    if (label) tab.seedLabel({ label, summary: prompt.replace(/\s+/g, ' ').slice(0, 200) });
    void tab.typeCommand('claude', 20_000);
    draftWhenReady(tab, prompt);
    return { text: `Opened T${tab.id}${label ? ` "${label}"` : ''} in ${dir}. The brief is being typed into its input box; the user reads it and presses Enter to start. The work belongs to that session now.` };
  }
  if (name === 'close_sessions') {
    const ids = (Array.isArray(args.ids) ? args.ids : []).map((x) => String(x).trim());
    if (!ids.length) return err('close_sessions needs a list of handles.');
    const lines: string[] = [];
    for (const h of ids) {
      const t = open().find((x) => `T${x.id}` === h);
      if (!t) lines.push(`${h}: no such open session`);
      else if (t.hasDialog || t.working) lines.push(`${h} "${t.savedLabel?.label || t.title}": left open, it is ${t.hasDialog ? 'waiting on the user' : 'working'}`);
      else { lines.push(`${h} "${t.savedLabel?.label || t.title}": closed`); closeTab(t.id, true); }
    }
    return { text: lines.join('\n') };
  }
  if (name === 'reopen_session') {
    const it = laterFor(ws).find((i) => `C${i.id}` === handle);
    if (!it || !takeLater(it.id)) return err(`No closed session ${handle}.`);
    const t = restoreTab(win, { cwd: it.cwd, sessionId: it.sessionId, title: it.label, claude: true, label: { label: it.label, summary: it.summary } });
    sendLater();
    return { text: `Reopened "${it.label}" as T${t.id}; its conversation is resuming.` };
  }
  return err('Unknown tool.');
}

/** Resume a past session in this tab: go to its folder, then `claude --resume <id>`. */
function resumeIn(tab: Tab, id: string, dir: string): void {
  if (!UUID.test(id) || tab.claudeRunning) return;
  const has = [...tabs.values()].find((t) => tabRecord(t).sessionId === id);
  if (has) { toWindow(has.windowId, { type: 'focus-tab', tab: has.id, raise: true }); return; } // already open: go to it
  let ok = false;
  try { ok = path.isAbsolute(dir) && fs.statSync(dir).isDirectory(); } catch { /* gone */ }
  if (!ok) { toWindow(tab.windowId, { type: 'toast', text: 'That folder no longer exists' }); return; }
  const label = cachedLabel(id);
  if (label) tab.seedLabel(label);
  resumeIds.set(tab.id, id);
  void tab.typeCommand(cdCommand(dir, `claude --resume ${id}`));
}
/** The project folders a window's workspace covers: its tabs' (open and saved) and its closed tabs'. None for a window that is not a workspace. */
function workspaceFolders(win: string): string[] {
  const name = windowWorkspace.get(win);
  if (!name) return [];
  return [...new Set([...windowTabs(win).map((t) => tabRecord(t).cwd), ...(loadWorkspace(name)?.tabs.map((t) => t.cwd) ?? []), ...laterFor(name).map((i) => i.cwd)])];
}
function sendWelcome(ws: WebSocket, fresh = false): void {
  const open = new Set([...tabs.values()].flatMap((t) => tabRecord(t).sessionId ?? []));
  const win = clients.get(ws) ?? '';
  // In a workspace, the sessions offered are that workspace's own.
  void welcomeInfo(fresh, open, workspaceFolders(win)).then((info) => send(ws, { type: 'welcome', ...info, scope: windowWorkspace.get(win) ?? null, workspaces: listWorkspaces() }));
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
  if (url.pathname.startsWith('/notes/')) {
    // The hook in one of our tabs' Claude sessions, asking for its heads-ups as you send a message.
    handleNotes(req, res, url.pathname.slice(7), (id) => { const t = tabs.get(id); return t ? takeNotes(t.registrarInput()?.cwd ?? t.cwd, id) : ''; });
    return;
  }
  if (url.pathname.startsWith('/mcp/')) {
    // A Claude session in one of our tabs reading the registrar's record.
    handleRecordTool(req, res, url.pathname.slice(5), (id, about) => {
      const t = tabs.get(id);
      return t ? recordText(t.registrarInput()?.cwd ?? t.cwd, id, about) : null;
    }, openLane, stewardTool, (id, mode, then) => { const t = tabs.get(id); return t ? queueRestart(t, mode, then) : { text: 'This tab is no longer open.', isError: true }; });
    return;
  }
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
    send(ws, registrarFor(win));
    sendLater(ws);
    if (windowWorkspace.has(win)) send(ws, { type: 'workspace-name', name: windowWorkspace.get(win) });
    sendWelcome(ws);
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
        saveWindow(win, m.name.trim(), String(m.active ?? ''), false);
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
      if (m.type === 'rename-workspace' && typeof m.name === 'string') {
        const from = windowWorkspace.get(win);
        const to = m.name.trim().slice(0, 80);
        if (!from || !to || to === from) return;
        const clash = to.toLowerCase() !== from.toLowerCase() && listWorkspaces().some((w) => w.name.toLowerCase() === to.toLowerCase());
        if (clash || AUTO_NAME.test(to)) { send(ws, { type: 'toast', text: `There is already a workspace called "${to}"` }); return; }
        saveWindow(win, from);
        if (!renameWorkspace(from, to)) return;
        renameLater(from, to);
        for (const [w, n] of windowWorkspace) if (n === from) bindWorkspace(w, to);
        send(ws, { type: 'workspaces', list: listWorkspaces() });
        return;
      }
      if (m.type === 'close-workspace') {
        // Put the workspace away: save it, then swap its tabs for a fresh one. Its sessions resume when it is reopened.
        const name = windowWorkspace.get(win);
        if (!name) return;
        saveWindow(win, name);
        windowWorkspace.delete(win);
        toWindow(win, { type: 'workspace-name', name: null });
        const old = windowTabs(win);
        const fresh = openTab(win, os.homedir());
        for (const t of old) closeTab(t.id);
        toWindow(win, { type: 'focus-tab', tab: fresh.id });
        send(ws, { type: 'toast', text: `Closed "${name}". Reopen it from Workspaces and every conversation resumes.` });
        send(ws, { type: 'workspaces', list: listWorkspaces() });
        return;
      }
      if (m.type === 'delete-workspace' && typeof m.name === 'string') {
        deleteWorkspace(m.name);
        for (const [w, n] of windowWorkspace) if (n === m.name) { windowWorkspace.delete(w); toWindow(w, { type: 'workspace-name', name: null }); }
        send(ws, { type: 'workspaces', list: listWorkspaces() });
        return;
      }
      if (m.type === 'welcome') { sendWelcome(ws, !!m.fresh); return; }
      if (m.type === 'steward') { openSteward(win); return; }
      if (m.type === 'find-session' && typeof m.q === 'string' && m.q.trim()) { // described in words; a headless Sonnet run looks for it
        const q = m.q.trim().slice(0, 500);
        void findSessions(q, workspaceFolders(win)).then((results) => {
          const open = new Set([...tabs.values()].flatMap((t) => tabRecord(t).sessionId ?? []));
          send(ws, { type: 'found-sessions', q, failed: !results, results: (results ?? []).map((r) => ({ ...r, open: open.has(r.id) })) });
        });
        return;
      }
      if (m.type === 'later-schedule') { // the tray goes to the list, and the Steward is asked to put time for it on the calendar
        if (typeof m.prefs === 'string' && m.prefs.trim()) setScheduling(m.prefs);
        const r = wrapUp(windowWorkspace.get(win) ?? '');
        if (!r) { send(ws, { type: 'toast', text: 'Could not write the list; nothing was removed.' }); return; }
        sendLater();
        if (!r.added) return;
        const had = windowTabs(win).some((t) => t.role === 'steward' && t.claudeRunning);
        draftWhenReady(openSteward(win), `Put time on my calendar to finish the loose ends in ${r.file} (${r.added} unticked item${r.added === 1 ? '' : 's'}, most of them quick). ` +
          `How I like it scheduled: ${scheduling()} ` +
          'Read the file, group the items into as few blocks as will honestly cover them, and check my calendar for free time first. ' +
          'Name each event after what gets finished, and put the file path and its items in the description. Show me the blocks you plan before creating them.', had);
        return;
      }
      if (m.type === 'later-wrap') { // the whole tray goes to a list in the project, and the Steward is asked to consolidate it
        const r = wrapUp(windowWorkspace.get(win) ?? '');
        if (!r) { send(ws, { type: 'toast', text: 'Could not write the list; nothing was removed.' }); return; }
        sendLater();
        if (!r.added) return;
        const had = windowTabs(win).some((t) => t.role === 'steward' && t.claudeRunning);
        draftWhenReady(openSteward(win), `Consolidate the loose ends in ${r.file} (${r.added} just added from ${r.sessions} closed session${r.sessions === 1 ? '' : 's'}). ` +
          'Merge duplicates, strike the ones the project already shows are done (check the files, do not guess), and group what is left by what it touches. Rewrite the file that way. ' +
          'Then tell me in a few lines what is left and how you would get it finished: one session to work through the list, or time on my calendar. Do not start either until I say.', had, true);
        return;
      }
      if (m.type === 'later-done') { takeLater(String(m.id)); sendLater(); return; }
      if (m.type === 'later-open') { // back as a tab, its session resumed
        const it = takeLater(String(m.id));
        if (it) {
          const t = restoreTab(win, { cwd: it.cwd, sessionId: it.sessionId, title: it.label, claude: true, label: { label: it.label, summary: it.summary } });
          toWindow(win, { type: 'focus-tab', tab: t.id });
          sendLater();
        }
        return;
      }
      if (m.type === 'cleanup-review') { // read this window's sessions and suggest which to close
        const list = windowTabs(win).flatMap((t) => (t.role ? [] : t.cleanupInput() ?? []));
        void reviewTabs(list).then((rows) => send(ws, { type: 'cleanup', rows }));
        return;
      }
      if (m.type === 'cleanup-apply' && Array.isArray(m.close)) {
        for (const c of m.close as { tab?: unknown; left?: unknown }[]) {
          const t = tabs.get(String(c?.tab));
          if (t && t.windowId === win) closeTab(t.id, true, typeof c.left === 'string' ? c.left : '');
        }
        return;
      }
      if (m.type === 'tab-order' && Array.isArray(m.ids)) {
        // Tabs dragged into a new order: this window's tabs take that order, in the slots they already held.
        const mine = windowTabs(win);
        const next = (m.ids as unknown[]).map((id) => mine.find((t) => t.id === id)).filter((t): t is Tab => !!t);
        for (const t of mine) if (!next.includes(t)) next.push(t);
        const all = [...tabs.values()].map((t) => (t.windowId === win ? next.shift()! : t));
        tabs.clear();
        for (const t of all) tabs.set(t.id, t);
        scheduleAutosave();
        return;
      }
      if (m.type === 'reopen-tab') { reopenClosedTab(win); return; }
      if (m.type === 'registrar-on') { setRegistrarOn(!!m.on); return; }
      if (m.type === 'registrar-run') { runRegistrar(); return; }
      if (m.type === 'registrar-note-drop' && typeof m.folder === 'string') { dropNote(m.folder, String(m.id)); return; }
      if (m.type === 'registrar-forget' && typeof m.folder === 'string') { forgetDecision(m.folder, String(m.id)); return; }
      if (m.type === 'registrar-flag' && typeof m.folder === 'string') {
        // Dismiss a prior-art flag, or hand its note to the session it is for (typed, not sent).
        const f = closeFlag(m.folder, String(m.id), m.send ? 'sent' : 'dismissed');
        const target = f && m.send ? [...tabs.values()].find((t) => t.registrarInput()?.session === f.session) : null;
        if (f && target) { target.draft(f.note); toWindow(target.windowId, { type: 'focus-tab', tab: target.id, raise: true }); }
        return;
      }
      if (m.type === 'new-tab') {
        const from = tabs.get(String(m.from));
        const tab = openTab(win, from?.cwd ?? os.homedir());
        toWindow(win, { type: 'focus-tab', tab: tab.id });
        sendWelcome(ws); // its list of sessions to resume leaves out whatever is open now
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
      else if (m.type === 'resume-session' && typeof m.id === 'string' && typeof m.dir === 'string') resumeIn(tab, m.id, m.dir);
      else if (m.type === 'install-claude') void tab.typeCommand(INSTALL_CLAUDE);
      else if (m.type === 'lunatic') tab.setLunatic(!!m.on);
      else if (m.type === 'session-tool') {
        if (m.action === 'reload') { const r = queueRestart(tab, 'reload'); send(ws, { type: 'toast', text: r.isError ? r.text : tab.working ? 'Reload queued: it happens when this turn ends' : 'Reloading this session…' }); }
        else if (m.action === 'split') splitSession(tab);
        else if (m.action === 'handoff') {
          if (!tab.claudeRunning || tab.working || tab.hasDialog) send(ws, { type: 'toast', text: 'Wait until Claude is idle in this tab, then try again' });
          else tab.draft(HANDOFF);
        }
      }
      else if (m.type === 'close-tab') closeTab(tab.id, true);
      else if (m.type === 'redraw') tab.redraw();
      else if (m.type === 'send-queued') tab.sendQueuedNow();
      else if (m.type === 'move-tab' && typeof m.to === 'string') { for (const t of windowTabs(win).filter((x) => x.group === tab.group)) moveTab(t, m.to.slice(0, 64)); } // a tab moves with its lanes
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
  clearRecordTool();
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
  clearRecordTool();
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
