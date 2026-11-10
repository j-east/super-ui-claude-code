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

// The app in miniature: transcript on top, terminal below, and a spark for Claude.
const HERO = `
<svg class="wl-hero" viewBox="0 0 320 190" role="img" aria-label="A window with a conversation above and a terminal below">
  <defs>
    <radialGradient id="wl-glow" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="var(--accent)" stop-opacity=".38"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <circle cx="246" cy="50" r="62" fill="url(#wl-glow)"/>
  <rect x="42" y="22" width="220" height="150" rx="12" fill="var(--panel)" stroke="var(--line)" stroke-width="1.5"/>
  <circle cx="58" cy="36" r="3" fill="var(--line)"/><circle cx="68" cy="36" r="3" fill="var(--line)"/><circle cx="78" cy="36" r="3" fill="var(--line)"/>
  <rect x="96" y="31" width="54" height="10" rx="5" fill="var(--bg)" stroke="var(--line)"/>
  <rect x="154" y="31" width="40" height="10" rx="5" fill="none" stroke="var(--line)"/>
  <line x1="42" y1="48" x2="262" y2="48" stroke="var(--line)" stroke-width="1.5"/>
  <rect x="170" y="58" width="78" height="14" rx="7" fill="var(--user)" stroke="var(--line)"/>
  <rect x="58" y="80" width="120" height="6" rx="3" fill="var(--muted)" opacity=".55"/>
  <rect x="58" y="92" width="150" height="6" rx="3" fill="var(--muted)" opacity=".4"/>
  <rect x="58" y="104" width="92" height="6" rx="3" fill="var(--muted)" opacity=".28"/>
  <rect x="42.75" y="122" width="218.5" height="38" fill="var(--code)"/>
  <path d="M42.75 160 a11.25 11.25 0 0 0 11.25 11.25 h196 a11.25 11.25 0 0 0 11.25 -11.25 z" fill="var(--code)"/>
  <line x1="42" y1="122" x2="262" y2="122" stroke="var(--line)" stroke-width="1.5"/>
  <rect x="134" y="119.5" width="36" height="5" rx="2.5" fill="var(--line)"/>
  <path d="M58 139 l6 5 -6 5" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="72" y="140.5" width="44" height="7" rx="2" fill="var(--text)" opacity=".8"/>
  <rect class="wl-caret" x="120" y="139" width="6" height="10" fill="var(--accent)"/>
  <g class="wl-spark" stroke="var(--accent)" stroke-width="5" stroke-linecap="round">
    <line x1="246" y1="24" x2="246" y2="76"/><line x1="220" y1="50" x2="272" y2="50"/>
    <line x1="227.6" y1="31.6" x2="264.4" y2="68.4"/><line x1="264.4" y1="31.6" x2="227.6" y2="68.4"/>
  </g>
</svg>`;

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
  head.innerHTML = HERO;
  head.append(h('h1', null, 'Claude Code Super UI'), h('p', 'wl-tag', 'The conversation up top. The real terminal below.'));
  root.append(head);

  if (missing) {
    const card = h('div', 'wl-setup');
    card.append(h('b', null, 'Setup: Claude Code isn’t installed yet'),
      h('p', null, 'This app runs Claude Code in the terminal below, so it needs to be on this Mac. ' +
        'Install runs Anthropic’s installer in this tab’s terminal:'),
      h('code', null, 'curl -fsSL https://claude.ai/install.sh | bash'));
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
    btn('', 'Continue last', 'claude -c', () => act({ type: 'launch', kind: 'continue' })),
    btn('', 'Resume…', 'pick an old session', () => act({ type: 'launch', kind: 'resume' })));
  root.append(main);

  const recents = (info?.recents ?? []).filter((r) => r.cwd !== view.cwd);
  if (recents.length) {
    const box = h('div', 'wl-recents');
    box.append(h('div', 'wl-h', 'Recent folders'));
    for (const r of recents) {
      const row = h('div', 'wl-recent');
      row.title = `cd ${r.cwd}`;
      const name = h('b', null, r.cwd.split('/').pop() || '/');
      const go = h('button', 'wl-go', '✳ Launch');
      go.title = 'Go there and start Claude';
      go.addEventListener('click', (e) => { e.stopPropagation(); act({ type: 'cd', dir: r.cwd, launch: true }); });
      row.append(name, h('span', 'wl-rpath', view.tilde(r.cwd)), h('span', 'wl-ago', ago(r.at)), go);
      row.addEventListener('click', () => act({ type: 'cd', dir: r.cwd }));
      box.append(row);
    }
    root.append(box);
  }

  const foot = h('div', 'wl-foot');
  const ws = h('button', 'wl-link', '▤ Open a saved workspace');
  ws.addEventListener('click', () => window.cp?.openWorkspaceMenu());
  foot.append(ws, h('span', null, '⌘T new tab'), h('span', null, '⌘\\ split view'), h('span', null, '⌘I inbox'));
  if (info?.claude?.version) foot.append(h('span', 'wl-ver', `Claude Code ${info.claude.version.replace(/\s*\(Claude Code\)/, '')}`));
  root.append(foot);
  return root;
}
