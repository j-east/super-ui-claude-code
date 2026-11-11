// The start screen of a tab that has no Claude session yet: pick a folder, launch Claude, jump back
// into a recent folder, and a setup card when Claude Code isn't installed.

const h = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** Latest answer from the server: { claude: {path, version} | null, recents: [{cwd, at}] }; null until it arrives. */
let info = null;
export const setWelcomeInfo = (i) => { info = i; };
/** Saved workspaces changed (one was saved or deleted). */
export const setWelcomeWorkspaces = (list) => { if (info) info.workspaces = list; };

function ago(at) {
  const m = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)} h ago`;
  const d = Math.round(m / 60 / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

const btn = (cls, label, sub, onClick) => {
  const b = h('button', 'wl-btn ' + cls);
  b.append(h('b', null, label));
  if (sub) b.append(h('span', null, sub));
  b.addEventListener('click', onClick);
  return b;
};

/** Build the screen for one tab. `view`: its TabView (send, cwd, tilde, term). */
export function welcomeEl(view) {
  const root = h('div', 'welcome');
  const act = (m) => { view.send(m); view.term?.focus(); };
  const missing = info && !info.claude;

  const head = h('div', 'wl-head');
  const icon = h('img', 'wl-icon');
  icon.src = '/icon.png'; icon.alt = '';
  const titles = h('div', 'wl-titles-box');
  titles.append(h('h1', null, 'Claude Code Super UI'), h('p', 'wl-tag', 'The conversation up top. The real terminal below.'));
  head.append(icon, titles);
  root.append(head);

  if (missing) {
    const card = h('div', 'wl-setup');
    card.append(h('b', null, 'Setup: Claude Code isn’t installed yet'),
      h('p', null, 'This app runs Claude Code in the terminal below, so it needs to be on this computer. ' +
        'Install runs Anthropic’s installer in this tab’s terminal:'),
      h('code', null, info.install || 'curl -fsSL https://claude.ai/install.sh | bash'));
    const row = h('div', 'wl-row');
    row.append(btn('primary', 'Install Claude Code', null, () => act({ type: 'install-claude' })),
      btn('', 'Check again', null, () => view.send({ type: 'welcome', fresh: true })));
    card.append(row, h('p', 'wl-fine', 'When it finishes, press Check again, then Launch Claude and sign in with /login.'));
    root.append(card);
  }

  const where = h('div', 'wl-where');
  const path = h('span', 'wl-path', view.tilde(view.cwd) || '…');
  path.title = view.cwd;
  where.append(h('span', null, '📁'), path);
  root.append(where);

  const main = h('div', 'wl-row');
  main.append(
    btn(missing ? '' : 'primary', '✳ Launch Claude', 'runs claude here', () => act({ type: 'launch', kind: 'new' })),
    btn('', 'Choose folder…', 'runs cd for you', () => view.send({ type: 'choose-folder' })),
    btn('', 'Resume…', 'pick an old session', () => act({ type: 'launch', kind: 'resume' })));
  root.append(main);

  const cols = h('div', 'wl-cols');
  // Saved workspaces first: reopening one resumes every session in it.
  const saved = info?.workspaces ?? [];
  if (saved.length) {
    const box = h('div', 'wl-recents');
    box.append(h('div', 'wl-h', 'Workspaces'));
    for (const w of saved.slice(0, 4)) {
      const row = h('div', 'wl-recent');
      const titles = w.titles.filter(Boolean).join(' · ');
      row.title = `Reopen ${w.tabs} tab${w.tabs === 1 ? '' : 's'} and resume their sessions` + (titles ? `:\n${w.titles.filter(Boolean).join('\n')}` : '');
      row.append(h('b', null, w.name), h('span', 'wl-rpath wl-titles', `${w.tabs} tab${w.tabs === 1 ? '' : 's'}${titles ? ' · ' + titles : ''}`),
        h('span', 'wl-ago', ago(Date.parse(w.savedAt))));
      row.addEventListener('click', () => view.send({ type: 'open-workspace', name: w.name }));
      box.append(row);
    }
    if (saved.length > 4) {
      const more = h('button', 'wl-link wl-more', `All ${saved.length} workspaces…`);
      more.addEventListener('click', () => window.cp?.openWorkspaceMenu());
      box.append(more);
    }
    cols.append(box);
  }

  const recents = (info?.recents ?? []).filter((r) => r.cwd !== view.cwd);
  if (recents.length) {
    const box = h('div', 'wl-recents');
    box.append(h('div', 'wl-h', 'Recent folders'));
    for (const r of recents) {
      const row = h('div', 'wl-recent');
      row.title = `cd ${r.cwd}`;
      const name = h('b', null, r.cwd.split(/[\\/]/).filter(Boolean).pop() || r.cwd);
      const go = h('button', 'wl-go', '✳ Launch');
      go.title = 'Go there and start Claude';
      go.addEventListener('click', (e) => { e.stopPropagation(); act({ type: 'cd', dir: r.cwd, launch: true }); });
      row.append(name, h('span', 'wl-rpath', view.tilde(r.cwd)), h('span', 'wl-ago', ago(r.at)), go);
      row.addEventListener('click', () => act({ type: 'cd', dir: r.cwd }));
      box.append(row);
    }
    cols.append(box);
  }

  if (cols.children.length) root.append(cols);

  const foot = h('div', 'wl-foot');
  const k = document.documentElement.dataset.os === 'win' ? 'Ctrl+Shift+' : '⌘';
  foot.append(h('span', null, `${k}T new tab`), h('span', null, `${k}\\ split view`), h('span', null, `${k}I inbox`));
  if (info?.claude?.version) foot.append(h('span', 'wl-ver', `Claude Code ${info.claude.version.replace(/\s*\(Claude Code\)/, '')}`));
  root.append(foot);
  return root;
}
