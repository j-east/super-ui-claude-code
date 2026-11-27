// claude-pane client: tab bar, shared launcher/status chrome, alerts, themes, socket.
import { THEMES, DEFAULT_THEME, applyTheme } from './themes.js';
import { TabView } from './tabview.js';
import { initWorkspaces } from './workspaces.js';
import { setWelcomeInfo, setWelcomeWorkspaces, setFound } from './welcome.js';
import { attachTabDrag, isDragging, consumeDragClick, endDrag } from './tabdrag.js';
import { Pane } from './pane.js';
import { initInbox } from './inbox.js';
import { initRegistrar } from './registrar.js';
import { initLater } from './later.js';

const $ = (id) => document.getElementById(id);
// Hosted by the native app? (WKWebView script bridge) Otherwise a plain browser window.
// (Mac app: WKWebView script bridge. Windows app: the Electron preload's bridge. Same messages.)
const native = window.webkit?.messageHandlers?.native ?? window.cpHost ?? null;
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
const paneOf = (v) => panes.find((p) => p.view === v) ?? (dockPane?.view === v ? dockPane : null);
/** The sessions that are tabs: every one but the Steward, which lives in its own panel on the right. */
const tabViews = () => [...views.values()].filter((v) => v.role !== 'steward');
const stewardView = () => [...views.values()].find((v) => v.role === 'steward') ?? null;
/** The session your typing goes to: the Steward while you are working in its panel, else the active tab. */
const kb = () => (dockFocus && dockPane?.view ? dockPane.view : active);
const shown = (v) => !!paneOf(v);

function focusPane(p) {
  if (focused && focused !== p) focused.setFocused(false);
  focused = p;
  setDockFocus(false);
  p.setFocused(panes.length > 1);
  active = p.view;
  if (active) { active.attention = null; active.term.focus(); touch(active.id); }
  renderTabs();
}
function touch(id) {
  const i = recent.indexOf(id); if (i >= 0) recent.splice(i, 1); recent.unshift(id);
  const v = views.get(id); if (v) lastInGroup.set(v.group, id);
}

// ---------- lanes: a tab and the sessions it opened share one row in the list ----------
// Tabs with the same `group` are one row on the left; the row's sessions are the strip across the top.
const lastInGroup = new Map(); // group -> the tab of it you looked at last
const groupOf = (v) => [...views.values()].filter((x) => x.group === v.group);
/** The session a row is named after: the one that opened the lanes, or the oldest left. */
const headOf = (members) => members.find((x) => x.id === x.group) ?? members[0];
const groupCount = () => new Set([...views.values()].map((v) => v.group)).size;
const stage = document.createElement('div');
stage.id = 'stage';
const lanesEl = document.createElement('div');
lanesEl.id = 'lanes'; lanesEl.hidden = true;
panesEl.replaceWith(stage);
stage.append(lanesEl, panesEl);
function renderLanes() {
  const members = active ? groupOf(active) : [];
  const show = members.length > 1;
  if (lanesEl.hidden === show) requestAnimationFrame(() => { for (const p of panes) p.view?.layout(); });
  lanesEl.hidden = !show;
  lanesEl.replaceChildren();
  if (!show) return;
  for (const v of members) {
    const c = document.createElement('div');
    c.className = 'lane' + (v === active ? ' active' : shown(v) ? ' shown' : '') + (v.attention ? ' attn' : '');
    const dot = document.createElement('span');
    dot.className = 'tdot' + (v.busy ? ' busy' : '') + (v.attention === 'input' ? ' input' : v.attention ? ' done' : '');
    const name = document.createElement('span');
    name.className = 'lane-name';
    name.textContent = v.lane || 'main';
    const what = document.createElement('span');
    what.className = 'lane-what';
    what.textContent = tabLabel(v) || '';
    const close = document.createElement('button');
    close.className = 'tclose'; close.textContent = '×'; close.title = 'Close this session (ends its shell)';
    close.onclick = (e) => { e.stopPropagation(); send({ type: 'close-tab', tab: v.id }); };
    c.title = `${v.lane ? `Lane: ${v.lane}` : 'The session that opened these lanes'}${tabLabel(v) ? `\n${tabLabel(v)}` : ''}`;
    c.onclick = () => activate(v.id);
    c.append(dot, name, what, close);
    lanesEl.append(c);
  }
}
/** The tab to fill a pane with: most recently shown one that isn't on screen. */
const nextUnshown = () => [...recent, ...views.keys()].map((id) => views.get(id)).find((v) => v && v.role !== 'steward' && !shown(v)) ?? null;

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
  if (v.role === 'steward') { openDock(true); return; }
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
  const done = new Set();
  for (const first of tabViews()) {
    if (done.has(first.group)) continue;
    done.add(first.group);
    // One row per group, named after its head; the row lights up for any of its sessions.
    const members = groupOf(first);
    const v = headOf(members);
    const attn = members.find((x) => x.attention === 'input')?.attention ?? members.find((x) => x.attention)?.attention ?? null;
    const busy = members.some((x) => x.busy);
    i++;
    const t = document.createElement('div');
    t.className = 'tab' + (members.includes(active) ? ' active' : members.some(shown) ? ' shown' : '') + (attn ? ' attn' : '');
    const n = i;
    t.onmouseenter = () => showTabCard(t, v, n);
    t.onmouseleave = hideTabCard;
    const dot = document.createElement('span');
    dot.className = 'tdot' + (busy ? ' busy' : '') + (attn === 'input' ? ' input' : attn ? ' done' : '');
    const name = document.createElement('span');
    name.className = 'ttext';
    const main = document.createElement('span');
    main.className = 'tname';
    const head = tabLabel(v) || v.title || v.name;
    main.textContent = (v.mode === 'claude' ? '✳ ' : '') + head + (v.lunatic ? ' 🌀' : '');
    name.append(main);
    const lanes = members.filter((x) => x !== v).map((x) => x.lane || 'session');
    if (head !== v.name || lanes.length) {
      const sub = document.createElement('span'); sub.className = 'tsub';
      sub.textContent = lanes.length ? `${v.name} · lanes: ${lanes.join(', ')}` : v.name;
      name.append(sub);
    }
    const close = document.createElement('button');
    close.className = 'tclose'; close.textContent = '×';
    close.title = members.length > 1 ? `Close this tab and its ${members.length - 1} lane${members.length > 2 ? 's' : ''} (ends their shells)` : 'Close tab (ends its shell)';
    close.onclick = (e) => { e.stopPropagation(); for (const x of members) send({ type: 'close-tab', tab: x.id }); };
    t.append(dot, name, close);
    t.dataset.id = v.id;
    t.onclick = () => { if (!consumeDragClick()) activate(members.includes(active) ? active.id : views.has(lastInGroup.get(v.group)) && views.get(lastInGroup.get(v.group)).group === v.group ? lastInGroup.get(v.group) : v.id); };
    attachTabDrag(t, { bar: box, onReorder: reorderTabs, onDetach: detachTab, onDone: renderTabs, onOut: dropHint });
    box.append(t);
  }
  box.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  $('bar-title').textContent = active ? (tabLabel(active) || active.title || active.name) : '';
  $('no-tabs').hidden = tabViews().length > 0;
  renderLanes();
  for (const p of panes) p.update();
  dockPane.update();
  const st = stewardView();
  $('steward-btn').classList.toggle('on', !dock.hidden);
  $('steward-btn').classList.toggle('attn', !!st?.attention && dock.hidden);
  dockDot.className = 'tdot' + (st?.busy ? ' busy' : '');
  const waiting = [...views.values()].filter((v) => v.attention).length;
  const base = !active ? 'Claude Code Super UI'
    : active.title ? `${active.title} · ${active.name}`
    : `${active.mode === 'claude' ? 'claude' : 'shell'} · ${active.name}`;
  document.title = waiting ? `(${waiting}) ${base}` : base;
  if (waiting !== lastBadge) { lastBadge = waiting; native?.postMessage({ type: 'badge', count: waiting }); }
}
let lastBadge = 0;

// ---------- tab hover card: the auto label's sentence, the session title, folder, state ----------
// `seeded`: a tab being reopened from a workspace shows its saved label while its session comes back.
const tabLabel = (v) => (v.mode === 'claude' || v.hasTranscript || v.seeded ? v.label?.label : '') || '';
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
    // Beside the tab list, level with the tab.
    tabCard.style.left = r.right + 8 + 'px';
    tabCard.style.top = Math.max(6, Math.min(r.top, innerHeight - tabCard.offsetHeight - 6)) + 'px';
  }, 350);
}
function hideTabCard() { clearTimeout(cardTimer); tabCard.hidden = true; }
// Tabs are re-rendered under the pointer (busy/label updates), so also hide on leaving the bar or pressing.
$('tabs').addEventListener('mouseleave', hideTabCard);
$('tabs').addEventListener('pointerdown', hideTabCard);

/** New tab order after a drag within the bar (also what ⌘1..9 follow). */
function reorderTabs(ids) {
  // A row stands for its whole group: its lanes travel with it, in their own order.
  const all = [...views.values()];
  const order = ids.map((id) => views.get(id)).filter(Boolean).flatMap((v) => all.filter((x) => x.group === v.group));
  for (const v of all) if (!order.includes(v)) order.push(v);
  views.clear();
  for (const v of order) views.set(v.id, v);
  send({ type: 'tab-order', ids: order.map((v) => v.id) }); // so the workspace and a reload keep it
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
  if (native) { native.postMessage({ type: 'tab-dropped', tab: id, only: groupCount() === 1 }); return; }
  if (groupCount() === 1) return; // browser: nothing to split off
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
// The tab list on the left collapses to a rail of status dots.
function setSidebar(collapsed) {
  document.body.classList.toggle('side-collapsed', collapsed);
  try { localStorage.setItem('sideCollapsed', collapsed ? '1' : '0'); } catch { /* private mode */ }
  hideTabCard();
  requestAnimationFrame(() => { for (const p of panes) p.view?.layout(); });
}
const toggleSidebar = () => setSidebar(!document.body.classList.contains('side-collapsed'));
$('side-btn').onclick = toggleSidebar;
document.body.classList.toggle('side-collapsed', localStorage.getItem('sideCollapsed') === '1');

// Drag the edge of the tab list to resize it; double-click to go back to the default width.
{
  const grip = $('side-grip');
  const relayout = () => { for (const p of panes) p.view?.layout(); };
  const setW = (w) => {
    if (w) document.body.style.setProperty('--side-w', `${w}px`); else document.body.style.removeProperty('--side-w');
  };
  const saved = Number(localStorage.getItem('sideWidth'));
  if (saved >= 150 && saved <= 600) setW(saved);
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add('side-drag');
    const left = $('sidebar').getBoundingClientRect().left;
    let w = 0;
    const move = (ev) => {
      w = Math.round(Math.max(150, Math.min(ev.clientX - left, 600, window.innerWidth - 360)));
      setW(w);
    };
    const stop = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', stop);
      grip.removeEventListener('pointercancel', stop);
      document.body.classList.remove('side-drag');
      if (w) { try { localStorage.setItem('sideWidth', String(w)); } catch { /* private mode */ } }
      relayout();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', stop);
    grip.addEventListener('pointercancel', stop);
  });
  grip.addEventListener('dblclick', () => {
    setW(0);
    try { localStorage.removeItem('sideWidth'); } catch { /* private mode */ }
    relayout();
  });
}

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
  tilde: (p) => (home && p.startsWith(home) ? '~' + p.slice(home.length) : p),
  onClose: () => active?.term.focus(),
});
const inbox = initInbox({
  button: $('inbox-btn'), send, myWindow: params.get('w'),
  tilde: (p) => (home && p.startsWith(home) ? '~' + p.slice(home.length) : p),
  onClose: () => active?.term.focus(),
});
const registrar = initRegistrar({
  button: $('reg-btn'), send,
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
  const ids = tabViews().map((v) => v.id);
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
  reopenTab: () => send({ type: 'reopen-tab' }),
  /** The host's folder dialog answered: go there in that tab. */
  cd: (tab, dir) => send({ type: 'cd', tab: String(tab), dir: String(dir) }),
  /** ⌘Z: bring back the tab you last closed. False while you're typing in a text field (then it's a normal undo). */
  undo: () => { if (typingInField()) return false; send({ type: 'reopen-tab' }); return true; },
  saveWorkspace: () => saveWorkspace(),
  openWorkspaceMenu: () => openWsMenu(),
  /** Type text into the active tab as a paste (bracketed if the program asked for it). */
  /** Move a tab into another window (called by the native app after a drag-out). */
  moveTab: (tab, to) => send({ type: 'move-tab', tab: String(tab), to: String(to) }),
  /** Native app: the mouse button went up (possibly outside the window, which the page never sees). */
  endDrag: (outside) => endDrag({ outside: !!outside }),
  paste: (text) => { const v = kb(); if (v) { v.term.paste(String(text)); v.term.focus(); } },
};
// Coming back from sleep / a hidden window: repaint the terminal.
document.addEventListener('visibilitychange', () => { if (!document.hidden) panes.forEach((p) => p.view?.redraw()); });

// ---------- keyboard ----------
/** A real text field (workspace name…), as opposed to the terminal's hidden input. */
const typingInField = () => {
  const a = document.activeElement;
  return !!a && (a.tagName === 'INPUT' || (a.tagName === 'TEXTAREA' && !a.closest('.xterm')) || a.isContentEditable);
};
document.addEventListener('keydown', (e) => {
  if (workspaces.isOpen || later.isOpen) return; // the modal handles its own keys
  if (e.metaKey && !e.shiftKey && e.key === 'z' && !typingInField()) { send({ type: 'reopen-tab' }); e.preventDefault(); e.stopPropagation(); return; } // ⌘Z reopen closed tab
  if (e.metaKey && e.key === 'i') { inbox.toggle(); e.preventDefault(); e.stopPropagation(); return; } // ⌘I inbox
  if (inbox.isOpen) { if (e.key === 'Escape') { inbox.close(); e.preventDefault(); e.stopPropagation(); } return; }
  if (registrar.isOpen) { if (e.key === 'Escape') { registrar.close(); e.preventDefault(); e.stopPropagation(); } return; }
  if (e.metaKey && !e.shiftKey && e.key === 'b' && !typingInField()) { toggleSidebar(); e.preventDefault(); e.stopPropagation(); return; } // ⌘B tab list
  if (e.metaKey && e.key === '\\') { split(); e.preventDefault(); e.stopPropagation(); return; } // ⌘\ split / unsplit
  if (e.metaKey && /^[1-9]$/.test(e.key)) {          // ⌘1..9: switch tab
    const v = tabViews()[Number(e.key) - 1];
    if (v) { activate(v.id); e.preventDefault(); e.stopPropagation(); }
    return;
  }
  if (e.ctrlKey && e.shiftKey && !e.metaKey) {
    const k = e.key.toLowerCase();
    if (k === 'b') { toggleSidebar(); e.preventDefault(); e.stopPropagation(); return; }
    if (k === 't') { send({ type: 'new-tab', from: active?.id }); e.preventDefault(); e.stopPropagation(); return; }
    if (k === 'a') { jumpToAttention(); e.preventDefault(); e.stopPropagation(); return; }
  }
  // Typing anywhere goes to the active terminal, even if it's collapsed or you clicked the transcript.
  const to = kb();
  if (!to || typingInField() || to.host.contains(document.activeElement) || e.metaKey || e.target.tagName === 'SELECT') return;
  to.term.focus();
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey) { send({ type: 'input', tab: to.id, data: e.key }); e.preventDefault(); }
  else if (e.key === 'Enter') { send({ type: 'input', tab: to.id, data: '\r' }); e.preventDefault(); }
}, true);
document.addEventListener('mouseup', (e) => {
  if (workspaces.isOpen || later.isOpen || inbox.isOpen || registrar.isOpen || e.target.closest('select, button, input, dialog, .inbox')) return;
  if (!String(window.getSelection())) kb()?.term.focus();
});

// ---------- socket ----------
let ws;
function send(m) { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); }

// ---------- the Steward: a panel on the right, not a tab ----------
// It is a session like the others underneath, but it is about the workspace, so it sits beside the
// work instead of in the list with it. The button opens and closes the panel; the session keeps running.
const dock = document.createElement('aside');
dock.id = 'steward-dock'; dock.hidden = true;
dock.innerHTML = `<div id="dock-grip" title="Drag to resize. Double-click to reset."></div>
  <header class="dock-head"><span class="tdot"></span><b>✦ Steward</b><span class="dock-sub">organises this workspace</span>
    <button class="dock-new" title="End this Steward conversation and start a clean one">Start over</button>
    <button class="dock-x" title="Hide the Steward. It keeps running.">×</button></header>`;
$('main').append(dock);
const dockDot = dock.querySelector('.tdot');
let dockFocus = false;
function setDockFocus(on) { dockFocus = on; dock.classList.toggle('kb', on); }
const dockPane = new Pane(dock, { send, onFocus: () => setDockFocus(true) });
stage.addEventListener('pointerdown', () => setDockFocus(false), true);
$('sidebar').addEventListener('pointerdown', () => setDockFocus(false), true);
let stewardRestart = false;
function openDock(focus) {
  const v = stewardView();
  if (!v) return;
  dock.hidden = false;
  try { localStorage.setItem('stewardOpen', '1'); } catch { /* private mode */ }
  dockPane.show(v, focus);
  if (focus) setDockFocus(true);
  renderTabs();
}
function closeDock(remember = true) {
  dockPane.view?.setActive(false);
  dock.hidden = true;
  setDockFocus(false);
  if (remember) { try { localStorage.setItem('stewardOpen', '0'); } catch { /* private mode */ } }
  active?.term.focus();
  renderTabs();
}
$('steward-btn').onclick = () => { if (dock.hidden) send({ type: 'steward' }); else closeDock(); }; // the server starts it if needed, then focuses it
dock.querySelector('.dock-x').onclick = () => closeDock();
dock.querySelector('.dock-new').onclick = () => {
  const v = stewardView();
  if (!v || !confirm('Start a new Steward conversation? This one ends; its log is kept.')) return;
  stewardRestart = true;
  send({ type: 'close-tab', tab: v.id });
};
{
  const grip = dock.querySelector('#dock-grip');
  const setW = (w) => { if (w) document.body.style.setProperty('--dock-w', `${w}px`); else document.body.style.removeProperty('--dock-w'); };
  const saved = Number(localStorage.getItem('dockWidth'));
  if (saved >= 320 && saved <= 900) setW(saved);
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add('side-drag');
    const right = dock.getBoundingClientRect().right;
    let w = 0;
    const move = (ev) => { w = Math.round(Math.max(320, Math.min(right - ev.clientX, 900, window.innerWidth - 480))); setW(w); };
    const stop = () => {
      grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', stop); grip.removeEventListener('pointercancel', stop);
      document.body.classList.remove('side-drag');
      if (w) { try { localStorage.setItem('dockWidth', String(w)); } catch { /* private mode */ } }
    };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', stop); grip.addEventListener('pointercancel', stop);
  });
  grip.addEventListener('dblclick', () => { setW(0); try { localStorage.removeItem('dockWidth'); } catch { /* private mode */ } });
}

// ---------- session tools menu ----------
const sessionMenu = document.createElement('div');
sessionMenu.id = 'session-menu'; sessionMenu.hidden = true;
document.body.append(sessionMenu);
for (const [action, name, sub] of [
  ['reload', 'Reload', 'Restart Claude and resume this conversation, with skills, MCP servers and settings read afresh. Waits for the current turn to end.'],
  ['handoff', 'Hand off and start fresh', 'Types a request for a handoff document, after which the session restarts clean and reads it. You press Enter.'],
  ['split', 'Split in two', 'Opens a copy of this conversation beside it, so each can take one direction.'],
]) {
  const b = document.createElement('button');
  const t = document.createElement('b'); t.textContent = name;
  const s = document.createElement('span'); s.textContent = sub;
  b.append(t, s);
  b.onclick = () => { sessionMenu.hidden = true; if (active) send({ type: 'session-tool', tab: active.id, action }); active?.term.focus(); };
  sessionMenu.append(b);
}
$('session-btn').onclick = (e) => {
  e.stopPropagation();
  if (!active || active.mode !== 'claude') { toast('Open a tab with Claude running first'); return; }
  const r = $('session-btn').getBoundingClientRect();
  sessionMenu.style.top = r.bottom + 4 + 'px';
  sessionMenu.style.right = Math.max(8, innerWidth - r.right) + 'px';
  sessionMenu.hidden = !sessionMenu.hidden;
};
document.addEventListener('click', (e) => { if (!sessionMenu.contains(e.target)) sessionMenu.hidden = true; });

const later = initLater({ send, box: $('later'), tidyBtn: $('tidy-btn'), claudeTabs: () => [...views.values()].filter((v) => v.mode === 'claude' && !v.role).length });

function onMessage(m) {
  if (m.type === 'hello') {
    home = m.home;
    document.documentElement.dataset.os = m.platform === 'win32' ? 'win' : 'mac';
    for (const v of views.values()) v.dispose();
    views.clear(); active = null; recent.length = 0;
    while (panes.length > 1) unsplit(panes[1]);
    panes[0].clear();
    dockPane.clear(); dock.hidden = true; setDockFocus(false);
    return;
  }
  if (m.type === 'workspaces') { workspaces.setList(m.list); setWelcomeWorkspaces(m.list); for (const v of views.values()) v.refreshEmpty(); return; }
  if (m.type === 'inbox') { inbox.setItems(m.items); return; }
  if (m.type === 'later') { later.setItems(m.items, m.scheduling); return; }
  if (m.type === 'cleanup') { later.setRows(m.rows); return; }
  if (m.type === 'registrar') { registrar.setState(m); return; }
  if (m.type === 'welcome') { setWelcomeInfo(m); for (const v of views.values()) v.refreshEmpty(); return; }
  if (m.type === 'found-sessions') { setFound(m); for (const v of views.values()) v.refreshEmpty(); return; }
  if (m.type === 'toast') { toast(m.text); return; }
  if (m.type === 'pick-folder') { native?.postMessage({ type: 'choose-folder', tab: m.tab, cwd: m.cwd }); return; }
  if (m.type === 'workspace-name') { // this window is a workspace: the button becomes it, and opens its properties
    workspaces.setCurrent(m.name);
    $('ws-btn').textContent = m.name ? `▤ ${m.name}` : '▤ Workspaces';
    $('ws-btn').classList.toggle('named', !!m.name);
    $('ws-btn').title = m.name ? `Workspace "${m.name}", saved automatically. Click to rename it or close it (⌥⌘S)`
      : 'Reopen a saved workspace, or name this window (⌥⌘S / ⌥⌘O)';
    return;
  }
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
    const v = new TabView(m.tab, { send, theme: theme.term, home, screen: m.screen, pane: m.role === 'steward' ? dockPane : focused });
    views.set(m.tab, v);
    v.group = m.group ?? m.tab; v.lane = m.lane ?? ''; v.role = m.role ?? '';
    v.setMode(m.mode, m.cwd);
    v.reset(m.entries);
    v.setQueue(m.queue ?? []);
    v.lunatic = m.lunatic; v.busy = m.busy; v.snapRows = m.snapRows ?? 0; v.label = m.label ?? null; v.setDialog(m.dialog ?? null);
    if (v.role === 'steward') { // into its panel: opened if you asked for it, or if it was open last time
      const asked = pendingFocus === m.tab;
      if (asked) pendingFocus = null;
      if (asked || localStorage.getItem('stewardOpen') === '1') openDock(asked); else renderTabs();
      return;
    }
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
    case 'label': v.label = m.label; v.seeded = !!m.seeded; renderTabs(); return;
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
      if (v.role === 'steward') {
        dockPane.clear();
        if (stewardRestart) { stewardRestart = false; send({ type: 'steward' }); } else closeDock(false);
        renderTabs();
        return;
      }
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
