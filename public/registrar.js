// Registrar: a record of what the Claude sessions in each project are doing and have decided, kept by
// an observer that reads their transcripts. It directs nothing. When a session looks like it is redoing
// something that already exists, or doing it differently, it raises a "prior art" flag with a note you
// can hand to that session.
const h = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const ago = (t) => {
  const m = Math.floor((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 60 * 48 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} days ago`;
};

/** @param {{ button: HTMLElement, send: (m: object) => void, tilde: (p: string) => string, onClose: () => void }} deps */
export function initRegistrar({ button, send, tilde, onClose }) {
  let state = { on: true, locked: false, projects: [] };
  const panel = h('div', 'inbox registrar');
  panel.hidden = true;
  document.body.append(panel);
  const count = h('span', 'inbox-count');
  button.append(count);

  function flagCard(p, f) {
    const c = h('div', 'reg-flag');
    c.append(h('div', null, f.text));
    c.append(h('div', 'reg-note', f.note));
    const acts = h('div', 'reg-acts');
    if (f.to) {
      const give = h('button', 'primary', `Put note in "${f.toLabel || 'that tab'}"`);
      give.title = 'Types the note into that session’s input box. Nothing is sent until you press Enter there.';
      give.onclick = () => { send({ type: 'registrar-flag', folder: p.folder, id: f.id, send: true }); close(); };
      acts.append(give);
    }
    const no = h('button', null, 'Dismiss');
    no.onclick = () => send({ type: 'registrar-flag', folder: p.folder, id: f.id, send: false });
    acts.append(no);
    c.append(acts);
    return c;
  }

  function render() {
    const flags = state.projects.reduce((n, p) => n + p.flags.length, 0);
    count.textContent = flags ? String(flags) : '';
    button.classList.toggle('attn', flags > 0);
    button.title = `Registrar: what your sessions are doing and have decided${flags ? `, ${flags} possible repeat${flags > 1 ? 's' : ''}` : ''}`;
    if (panel.hidden) return;
    const scroll = panel.scrollTop;
    panel.replaceChildren();

    const top = h('div', 'reg-top');
    top.append(h('span', null, state.locked ? 'Turned off by an environment variable.'
      : state.on ? 'Reads your sessions and keeps the record. It never directs them.' : 'Off. Nothing is being read.'));
    if (!state.locked) {
      if (state.on) {
        const now = h('button', null, state.projects.some((p) => p.checking) ? 'Checking…' : 'Check now');
        now.onclick = () => send({ type: 'registrar-run' });
        top.append(now);
      }
      const sw = h('button', null, state.on ? 'Turn off' : 'Turn on');
      sw.onclick = () => send({ type: 'registrar-on', on: !state.on });
      top.append(sw);
    }
    panel.append(top);

    if (!state.projects.length) panel.append(h('div', 'reg-empty', 'No Claude sessions are running.'));
    for (const p of state.projects) {
      panel.append(h('div', 'reg-proj', tilde(p.folder)));
      if (p.flags.length) {
        panel.append(h('h3', null, `Prior art (${p.flags.length})`));
        for (const f of p.flags) panel.append(flagCard(p, f));
      }
      panel.append(h('h3', null, `In flight (${p.sessions.length})`));
      for (const s of p.sessions) {
        const r = h('div', 'reg-row');
        const t = h('div', 'reg-text');
        const go = h('button', 'reg-go', s.label || 'untitled');
        go.title = 'Go to this tab';
        go.onclick = () => { send({ type: 'reveal', tab: s.tab }); close(); };
        t.append(go, h('span', 'reg-meta', s.doing || 'Not read yet.'));
        r.append(t);
        panel.append(r);
      }
      panel.append(h('h3', null, `Decisions on record (${p.decisions.length})`));
      if (!p.decisions.length) panel.append(h('div', 'reg-empty', 'None yet. They appear as sessions settle things.'));
      for (const d of p.decisions) {
        const r = h('div', 'reg-row');
        const t = h('div', 'reg-text', d.text);
        t.append(h('span', 'reg-meta', `${d.from} · ${ago(d.at)}`));
        const x = h('button', 'reg-x', '×');
        x.title = 'Remove from the record';
        x.onclick = () => send({ type: 'registrar-forget', folder: p.folder, id: d.id });
        r.append(t, x);
        panel.append(r);
      }
    }
    panel.scrollTop = scroll;
  }

  function open() { panel.hidden = false; button.classList.add('on'); render(); }
  function close() { if (panel.hidden) return; panel.hidden = true; button.classList.remove('on'); onClose(); }
  button.addEventListener('click', () => (panel.hidden ? open() : close()));
  document.addEventListener('pointerdown', (e) => { if (!panel.hidden && !panel.contains(e.target) && !button.contains(e.target)) close(); }, true);
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); e.stopPropagation(); });

  return {
    setState(s) { state = s; render(); },
    get isOpen() { return !panel.hidden; },
    close,
  };
}
