// claude-pane client: tab bar, shared launcher/status chrome, alerts, themes, socket.
import { THEMES, DEFAULT_THEME, applyTheme } from './themes.js';
import { TabView } from './tabview.js';
import { initWorkspaces } from './workspaces.js';
import { attachTabDrag, isDragging, consumeDragClick, endDrag } from './tabdrag.js';
import { Pane } from './pane.js';
import { initInbox } from './inbox.js';

const $ = (id) => document.getElementById(id);
// Hosted by the native app? (WKWebView script bridge) Otherwise a plain browser window.
const native = window.webkit?.messageHandlers?.native ?? null;
// Each window owns its own tabs on the server; keep the id across reloads.
const params = new URLSearchParams(location.search);
if (!params.get('w')) { params.set('w', crypto.randomUUID()); history.replaceState(null, '', `?${params}`); }
const views = new Map(); // tab id -> TabView
// The window shows one pane, or two side by side (split). `focused` is the one the tab bar and keyboard
// act on; `active` is the tab shown in it.
const panesEl = $('panes');
const panes = [];
let focused = null;
let active = null;
const recent = []; // tab ids, most recently shown first (what a new split pane shows)
let home = '';
let pendingFocus = null;

// ---------- themes ----------
let themeName = localStorage.getItem('theme') || DEFAULT_THEME;
const themeSel = $('theme');
for (const [k, t] of Object.entries(THEMES)) themeSel.append(new Option(t.label, k));
themeSel.value = THEMES[themeName] ? themeName : DEFAULT_THEME;
let theme = applyTheme(themeSel.value, []);
themeSel.onchange = () => {
  localStorage.setItem('theme', themeSel.value);
  theme = applyTheme(themeSel.value, [...views.values()].map((v) => v.term));
  active?.term.focus();
};

// ---------- panes ----------
function newPane() {
  const p = new Pane(panesEl, { send, onFocus: (q) => { if (q !== focused) focusPane(q); } });
  panes.push(p);
  panesEl.classList.toggle('split', panes.length > 1);
  $('split-btn').classList.toggle('on', panes.length > 1);
  return p;
}
const paneOf = (v) => panes.find((p) => p.view === v) ?? null;
const shown = (v) => !!paneOf(v);

function focusPane(p) {
  if (focused && focused !== p) focused.setFocused(false);
  focused = p;
  p.setFocused(panes.length > 1);
  active = p.view;
  if (active) { active.attention = null; active.term.focus(); touch(active.id); }
  renderTabs();
}
function touch(id) { const i = recent.indexOf(id); if (i >= 0) recent.splice(i, 1); recent.unshift(id); }
/** The tab to fill a pane with: most recently shown one that isn't on screen. */
const nextUnshown = () => [...recent, ...views.keys()].map((id) => views.get(id)).find((v) => v && !shown(v)) ?? null;

/** Split in two (the new right pane shows `id`, or the most recent other tab, or a new tab); or unsplit. */
function split(id) {
  const v = id ? views.get(id) : null;
  if (panes.length > 1) {
    if (!id) { unsplit(focused === panes[0] ? panes[1] : panes[0]); return; }
    if (!v) return;
    const holder = paneOf(v);
    if (holder === panes[1]) focusPane(holder);
    else if (holder) unsplitOrSwap(holder, panes[1], v);
    else { panes[1].show(v); focusPane(panes[1]); }
    return;
  }
  const left = panes[0];
  if (v && left.view === v) {
    // Dragging the tab that's showing to the right: the left half gets the most recent other tab.
    const other = nextUnshown();
    if (!other) return; // only one tab: nothing to put beside it
    const p = newPane();
    p.show(v);
    left.show(other, false);
    focusPane(p);
  } else {
    const show = v ?? nextUnshown();
    const p = newPane();
    if (show) { p.show(show); focusPane(p); }
    else { focusPane(p); pendingFocus = 'next'; send({ type: 'new-tab', from: left.view?.id }); }
  }
  for (const q of panes) q.setFocused(q === focused);
}
/** Remove a pane: its tabs move (hidden) to the remaining one. */
function unsplit(gone) {
  if (panes.length < 2) return;
  const keep = panes.find((p) => p !== gone);
  gone.view?.setActive(false);
  for (const v of views.values()) if (v.pane === gone) v.mount(keep);
  panes.splice(panes.indexOf(gone), 1);
  gone.dispose();
  panesEl.classList.remove('split');
  $('split-btn').classList.remove('on');
  keep.setFocused(false);
  focused = null;
  focusPane(keep);
  keep.view?.layout();
}

// ---------- tabs ----------
/** Show a tab: if it's already on screen in the other half, focus that half; else show it in the focused pane. */
function activate(id) {
  const v = views.get(id);
  if (!v) return;
  const holder = paneOf(v);
  if (holder) { if (holder !== focused) focusPane(holder); else { active = v; renderTabs(); } return; }
  focused.show(v);
  focusPane(focused);
}

function renderTabs() {
  if (isDragging()) return; // re-rendered when the drag ends
  const box = $('tabs');
  box.replaceChildren();
  let i = 0;
  for (const v of views.values()) {
    i++;
    const t = document.createElement('div');
    t.className = 'tab' + (v === active ? ' active' : shown(v) ? ' shown' : '') + (v.attention ? ' attn' : '');
    const n = i;
    t.onmouseenter = () => showTabCard(t, v, n);
    t.onmouseleave = hideTabCard;
    const dot = document.createElement('span');
    dot.className = 'tdot' + (v.busy ? ' busy' : '') + (v.attention === 'input' ? ' input' : v.attention ? ' done' : '');
    const name = document.createElement('span');
    name.className = 'tname';
    name.textContent = (v.mode === 'claude' ? '✳ ' : '') + (tabLabel(v) || v.title || v.name) + (v.lunatic ? ' 🌀' : '');
    const close = document.createElement('button');
    close.className = 'tclose'; close.textContent = '×'; close.title = 'Close tab (ends its shell)';
    close.onclick = (e) => { e.stopPropagation(); send({ type: 'close-tab', tab: v.id }); };
    t.append(dot, name, close);
    t.dataset.id = v.id;
    t.onclick = () => { if (!consumeDragClick()) activate(v.id); };
    attachTabDrag(t, { bar: box, onReorder: reorderTabs, onDetach: detachTab, onDone: renderTabs, onOut: dropHint });
    box.append(t);
  }
  box.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  $('no-tabs').hidden = views.size > 0;
  for (const p of panes) p.update();
  const waiting = [...views.values()].filter((v) => v.attention).length;
  const base = !active ? 'Claude Code Super UI'
    : active.title ? `${active.title} · ${active.name}`
    : `${active.mode === 'claude' ? 'claude' : 'shell'} · ${active.name}`;
  document.title = waiting ? `(${waiting}) ${base}` : base;
  if (waiting !== lastBadge) { lastBadge = waiting; native?.postMessage({ type: 'badge', count: waiting }); }
}
let lastBadge = 0;

// ---------- tab hover card: the auto label's sentence, the session title, folder, state ----------
const tabLabel = (v) => (v.mode === 'claude' || v.hasTranscript ? v.label?.label : '') || '';
const tabCard = document.createElement('div');
tabCard.id = 'tab-card'; tabCard.hidden = true;
document.body.append(tabCard);
let cardTimer;
function showTabCard(t, v, n) {
  clearTimeout(cardTimer);
  cardTimer = setTimeout(() => {
    if (isDragging()) return;
    const row = (cls, text) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; return d; };
    tabCard.replaceChildren();
    const head = tabLabel(v) || v.title || v.name;
    tabCard.append(row('tc-head', head));
    if (tabLabel(v) && v.label.summary) tabCard.append(row('tc-sum', v.label.summary));
    if (v.title && v.title !== head) tabCard.append(row('tc-title', v.title));
    const state = v.mode !== 'claude' ? 'Shell' : v.attention === 'input' ? 'Waiting for you'
      : v.busy ? 'Working…' : v.attention ? 'Finished' : 'Ready';
    tabCard.append(row('tc-meta', `${state} · ${v.tilde(v.cwd)}${n <= 9 ? ` · ⌘${n}` : ''}`));
    tabCard.hidden = false;
    const r = t.getBoundingClientRect();
    tabCard.style.top = r.bottom + 6 + 'px';
    tabCard.style.left = Math.max(6, Math.min(r.left, innerWidth - tabCard.offsetWidth - 6)) + 'px';
  }, 350);
}
function hideTabCard() { clearTimeout(cardTimer); tabCard.hidden = true; }
// Tabs are re-rendered under the pointer (busy/label updates), so also hide on leaving the bar or pressing.
$('tabs').addEventListener('mouseleave', hideTabCard);
$('tabs').addEventListener('pointerdown', hideTabCard);

/** New tab order after a drag within the bar (also what ⌘1..9 follow). */
function reorderTabs(ids) {
  const order = ids.map((id) => [id, views.get(id)]).filter(([, v]) => v);
  views.clear();
  for (const [id, v] of order) views.set(id, v);
}

/**
 * A tab pulled out of the bar. Released inside this window: shown in the half it was dropped on
 * (dropping on the right half of an unsplit window splits it). Released outside: into the window it
 * was dropped on, or a new window.
 */
function dropTarget(at) {
  if (!at) return null;
  const r = panesEl.getBoundingClientRect();
  if (at.x < r.left || at.x > r.right || at.y < r.top || at.y > r.bottom) return null;
  if (panes.length > 1) return { pane: panes.find((p) => { const b = p.el.getBoundingClientRect(); return at.x >= b.left && at.x <= b.right; }) ?? panes[1] };
  return at.x > r.left + r.width / 2 ? { split: true, rect: { left: r.left + r.width / 2, top: r.top, width: r.width / 2, height: r.height } } : null;
}
function detachTab(id, at) {
  const t = dropTarget(at);
  if (t?.split) { split(id); return; }
  if (t?.pane) {
    const v = views.get(id);
    if (v) { const holder = paneOf(v); if (holder && holder !== t.pane) unsplitOrSwap(holder, t.pane, v); else { t.pane.show(v); focusPane(t.pane); } }
    return;
  }
  if (at && !t) return; // released inside the window, but not on a drop target (e.g. the left half): nothing
  if (native) { native.postMessage({ type: 'tab-dropped', tab: id, only: views.size === 1 }); return; }
  if (views.size === 1) return; // browser: nothing to split off
  const w = crypto.randomUUID();
  window.open(`/?t=${params.get('t')}&w=${w}&detached=1`, '_blank', 'popup,width=1180,height=820');
  send({ type: 'move-tab', tab: id, to: w });
}
/** A tab dragged from one half onto the other: swap the two halves' tabs. */
function unsplitOrSwap(from, to, v) {
  const other = to.view;
  if (other) from.show(other, false); else from.clear();
  to.show(v);
  focusPane(to);
}
const dropEl = document.createElement('div');
dropEl.id = 'drop-hint'; dropEl.hidden = true;
document.body.append(dropEl);
/** While a tab is pulled out of the bar: outline where it would land. */
function dropHint(at) {
  const t = dropTarget(at);
  const r = t?.rect ?? t?.pane?.el.getBoundingClientRect();
  dropEl.hidden = !r;
  if (r) Object.assign(dropEl.style, { left: r.left + 6 + 'px', top: r.top + 6 + 'px', width: r.width - 12 + 'px', height: r.height - 12 + 'px' });
}

$('new-tab').onclick = () => send({ type: 'new-tab', from: active?.id });
$('no-tabs-new').onclick = () => send({ type: 'new-tab' });

$('split-btn').onclick = () => split();
// Too many tabs to fit: the mouse wheel scrolls the tab bar sideways (like VS Code).
$('tabs').addEventListener('wheel', (e) => {
  const box = $('tabs');
  if (box.scrollWidth <= box.clientWidth) return;
  box.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  e.preventDefault();
}, { passive: false });

// ---------- alerts ----------
document.addEventListener('click', () => {
  if (!native && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
}, { once: true });

function alertTab(v, reason, label) {
  if (shown(v) && document.hasFocus()) return;
  v.attention = reason;
  renderTabs();
  const title = `${v.name}: ${reason === 'input' ? 'needs your input' : 'finished'}`;
  const body = label ? `Waiting on: ${label}` : v.tilde(v.cwd);
  if (native) native.postMessage({ type: 'notify', title, body, tab: v.id });
  else if ('Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(title, { body, tag: `claude-pane-${v.id}` });
    n.onclick = () => { window.focus(); activate(v.id); n.close(); };
  }
}
window.addEventListener('focus', () => {
  let changed = false;
  for (const p of panes) if (p.view?.attention) { p.view.attention = null; changed = true; }
  if (changed) renderTabs();
});
function jumpToAttention() {
  const next = [...views.values()].find((v) => v.attention && !shown(v)) ?? [...views.values()].find((v) => v.attention && v !== active);
  if (next) activate(next.id);
}

// ---------- workspaces ----------
const workspaces = initWorkspaces({
  send,
  tabs: () => [...views.values()].map((v) => ({ title: v.title || v.name, active: v === active })),
  activeId: () => active?.id,
  onClose: () => active?.term.focus(),
});
const inbox = initInbox({
  button: $('inbox-btn'), send, myWindow: params.get('w'),
  tilde: (p) => (home && p.startsWith(home) ? '~' + p.slice(home.length) : p),
  onClose: () => active?.term.focus(),
});
const saveWorkspace = () => workspaces.open({ focusSave: true });
const openWsMenu = () => workspaces.open();
$('ws-btn').onclick = () => openWsMenu();

let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
}

// ---------- commands (also called by the native app's menus) ----------
function cycle(step) {
  const ids = [...views.keys()];
  if (!ids.length || !active) return;
  activate(ids[(ids.indexOf(active.id) + step + ids.length) % ids.length]);
}
window.cp = {
  newTab: () => send({ type: 'new-tab', from: active?.id }),
  /** Close the active tab; false if there was none (the app then closes the window). */
  closeTab: () => { if (!active) return false; send({ type: 'close-tab', tab: active.id }); return true; },
  nextTab: () => cycle(1),
  prevTab: () => cycle(-1),
  activate: (id) => activate(String(id)),
  jumpToAttention: () => jumpToAttention(),
  redraw: () => panes.forEach((p) => p.view?.redraw()),
  toggleSplit: () => split(),
  toggleInbox: () => inbox.toggle(),
  saveWorkspace: () => saveWorkspace(),
  openWorkspaceMenu: () => openWsMenu(),
  /** Type text into the active tab as a paste (bracketed if the program asked for it). */
  /** Move a tab into another window (called by the native app after a drag-out). */
  moveTab: (tab, to) => send({ type: 'move-tab', tab: String(tab), to: String(to) }),
  /** Native app: the mouse button went up (possibly outside the window, which the page never sees). */
  endDrag: (outside) => endDrag({ outside: !!outside }),
  paste: (text) => { if (active) { active.term.paste(String(text)); active.term.focus(); } },
};
// Coming back from sleep / a hidden window: repaint the terminal.
document.addEventListener('visibilitychange', () => { if (!document.hidden) panes.forEach((p) => p.view?.redraw()); });

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  if (workspaces.isOpen) return; // the modal handles its own keys
  if (e.metaKey && e.key === 'i') { inbox.toggle(); e.preventDefault(); e.stopPropagation(); return; } // ⌘I inbox
  if (inbox.isOpen) { if (e.key === 'Escape') { inbox.close(); e.preventDefault(); e.stopPropagation(); } return; }
  if (e.metaKey && e.key === '\\') { split(); e.preventDefault(); e.stopPropagation(); return; } // ⌘\ split / unsplit
  if (e.metaKey && /^[1-9]$/.test(e.key)) {          // ⌘1..9: switch tab
    const v = [...views.values()][Number(e.key) - 1];
    if (v) { activate(v.id); e.preventDefault(); e.stopPropagation(); }
    return;
  }
  if (e.ctrlKey && e.shiftKey && !e.metaKey) {
    const k = e.key.toLowerCase();
    if (k === 't') { send({ type: 'new-tab', from: active?.id }); e.preventDefault(); e.stopPropagation(); return; }
    if (k === 'a') { jumpToAttention(); e.preventDefault(); e.stopPropagation(); return; }
  }
  // Typing anywhere goes to the active terminal, even if it's collapsed or you clicked the transcript.
  if (!active || active.host.contains(document.activeElement) || e.metaKey || e.target.tagName === 'SELECT') return;
  active.term.focus();
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey) { send({ type: 'input', tab: active.id, data: e.key }); e.preventDefault(); }
  else if (e.key === 'Enter') { send({ type: 'input', tab: active.id, data: '\r' }); e.preventDefault(); }
}, true);
document.addEventListener('mouseup', (e) => {
  if (workspaces.isOpen || inbox.isOpen || e.target.closest('select, button, dialog, .inbox')) return;
  if (!String(window.getSelection())) active?.term.focus();
});

// ---------- socket ----------
let ws;
function send(m) { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); }

function onMessage(m) {
  if (m.type === 'hello') {
    home = m.home;
    for (const v of views.values()) v.dispose();
    views.clear(); active = null; recent.length = 0;
    while (panes.length > 1) unsplit(panes[1]);
    panes[0].clear();
    return;
  }
  if (m.type === 'workspaces') { workspaces.setList(m.list); return; }
  if (m.type === 'inbox') { inbox.setItems(m.items); return; }
  if (m.type === 'toast') { toast(m.text); return; }
  if (m.type === 'window-empty') { // last tab moved out: close this window like Chrome does
    if (native) native.postMessage({ type: 'close-window' }); else window.close();
    return;
  }
  if (m.type === 'focus-tab') {
    if (views.has(m.tab)) activate(m.tab); else if (pendingFocus !== 'next') pendingFocus = m.tab;
    if (m.raise) { if (native) native.postMessage({ type: 'raise' }); else window.focus(); } // asked for from another window's inbox
    return;
  }
  if (m.type === 'tab-open') {
    views.get(m.tab)?.dispose();
    const v = new TabView(m.tab, { send, theme: theme.term, home, screen: m.screen, pane: focused });
    views.set(m.tab, v);
    v.setMode(m.mode, m.cwd);
    v.reset(m.entries);
    v.setQueue(m.queue ?? []);
    v.lunatic = m.lunatic; v.busy = m.busy; v.snapRows = m.snapRows ?? 0; v.label = m.label ?? null; v.setDialog(m.dialog ?? null);
    // An empty focused pane (fresh window, or a split waiting for its new tab) takes it.
    if (!focused.view || pendingFocus === m.tab || pendingFocus === 'next') { pendingFocus = null; activate(m.tab); } else renderTabs();
    return;
  }
  const v = views.get(m.tab);
  if (!v) return;
  switch (m.type) {
    case 'output': v.term.write(m.data); return;
    case 'transcript-reset': v.reset(m.entries); renderTabs(); break;
    case 'transcript-append': v.append(m.entries); renderTabs(); break;
    case 'mode': v.setMode(m.mode, m.cwd); if (shown(v)) v.layout(); renderTabs(); break;
    case 'activity': v.busy = m.busy; renderTabs(); break;
    case 'lunatic': v.lunatic = m.on; renderTabs(); break;
    case 'attention': alertTab(v, m.reason, m.label); break;
    case 'live': v.setLive(m.text); return;
    case 'label': v.label = m.label; renderTabs(); return;
    case 'dialog': v.setDialog(m.dialog); return;
    case 'snap': v.snapRows = m.rows; paneOf(v)?.autoSnap(); return;
    case 'queue': v.setQueue(m.items); return;
    case 'auto-answer': v.note(`🌀 Lunatic mode picked: ${m.label}`, 'note lunatic-note'); break;
    case 'tab-moved': // moved to another window: drop the view here, the tab lives on there
    case 'tab-closed': {
      endDrag({ cancel: true }); // never leave a drag ghost / frozen tab bar behind
      const holder = paneOf(v);
      v.dispose(); views.delete(m.tab);
      const ri = recent.indexOf(m.tab); if (ri >= 0) recent.splice(ri, 1);
      if (holder) {
        holder.view = null;
        const next = nextUnshown();
        if (next) { holder.show(next, holder === focused); if (holder === focused) focusPane(holder); }
        else if (panes.length > 1) unsplit(holder); // nothing left to show there: back to one pane
        else { holder.clear(); active = null; }
      }
      renderTabs();
      return;
    }
  }
  paneOf(v)?.update();
}

function connect() {
  const t = params.get('t');
  const det = params.get('detached') === '1' ? '&detached=1' : '';
  ws = new WebSocket(`ws://${location.host}/ws?t=${t}&w=${encodeURIComponent(params.get('w'))}${det}`);
  ws.onmessage = (ev) => onMessage(JSON.parse(ev.data));
  ws.onclose = () => { for (const p of panes) p.statusEl.textContent = 'disconnected, retrying…'; setTimeout(connect, 1000); };
}
focusPane(newPane());
connect();
