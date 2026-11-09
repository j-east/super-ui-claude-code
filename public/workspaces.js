// Workspaces modal: save this window's tabs under a name, reopen or delete saved ones.
// The server owns the files; this only renders the list it sends and posts commands back.

const h = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const when = (iso) => {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24 && d.getDate() === new Date().getDate()) return `today ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

/**
 * @param {{ send: (m: object) => void, tabs: () => {title: string, active: boolean}[], activeId: () => string | undefined,
 *           onClose: () => void }} deps
 */
export function initWorkspaces({ send, tabs, activeId, onClose }) {
  let list = [];
  const dlg = h('dialog', 'ws-dialog');
  dlg.innerHTML = `
    <header><h2>Workspaces</h2><button class="ws-x" title="Close (Esc)">×</button></header>
    <section class="ws-save">
      <label for="ws-name">Save this window</label>
      <div class="ws-current"></div>
      <form class="ws-form"><input id="ws-name" autocomplete="off" spellcheck="false" placeholder="Workspace name">
        <button class="primary" type="submit">Save</button></form>
      <div class="ws-replace" hidden>Replaces the saved workspace with this name.</div>
    </section>
    <section class="ws-saved"><h3>Saved</h3><div class="ws-list"></div></section>`;
  document.body.append(dlg);
  const $ = (s) => dlg.querySelector(s);
  const input = $('#ws-name');
  const saveBtn = $('.ws-form button');

  const exists = () => list.some((w) => w.name.toLowerCase() === input.value.trim().toLowerCase());
  const syncSave = () => {
    const ex = exists();
    saveBtn.textContent = ex ? 'Replace' : 'Save';
    saveBtn.disabled = !input.value.trim();
    $('.ws-replace').hidden = !ex;
  };
  input.addEventListener('input', syncSave);

  $('.ws-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    send({ type: 'save-workspace', name, active: activeId() });
    close();
  });
  $('.ws-x').onclick = () => close();
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); }); // backdrop
  dlg.addEventListener('close', () => onClose());
  // Keep keys inside the modal (the app forwards stray typing to the terminal).
  dlg.addEventListener('keydown', (e) => e.stopPropagation());

  function renderCurrent() {
    const t = tabs();
    const cur = $('.ws-current');
    cur.replaceChildren();
    if (!t.length) { cur.textContent = 'No tabs open.'; return; }
    cur.append(h('span', 'ws-muted', `${t.length} tab${t.length === 1 ? '' : 's'}: `));
    cur.append(h('span', null, t.map((x) => x.title).join(' · ')));
  }

  function renderList() {
    const box = $('.ws-list');
    box.replaceChildren();
    if (!list.length) { box.append(h('div', 'ws-empty', 'Nothing saved yet. Save this window above to reopen its sessions later.')); return; }
    for (const w of list) {
      const card = h('div', 'ws-card');
      const info = h('button', 'ws-info');
      info.title = 'Open these tabs in this window and resume their Claude sessions';
      const top = h('div', 'ws-top');
      top.append(h('b', null, w.name), h('span', 'ws-muted', `${w.tabs} tab${w.tabs === 1 ? '' : 's'} · ${when(w.savedAt)}`));
      const titles = h('ul', 'ws-titles');
      for (const t of w.titles.slice(0, 4)) titles.append(h('li', null, t));
      if (w.titles.length > 4) titles.append(h('li', 'ws-muted', `+${w.titles.length - 4} more`));
      info.append(top, titles);
      info.onclick = () => { send({ type: 'open-workspace', name: w.name }); close(); };

      const actions = h('div', 'ws-actions');
      const open = h('button', 'primary', 'Open');
      open.onclick = info.onclick;
      const del = h('button', 'ws-del', 'Delete');
      let armed;
      del.onclick = () => {
        if (!armed) { // two-step delete instead of a confirm() popup
          del.textContent = 'Really delete?'; del.classList.add('armed');
          armed = setTimeout(() => { armed = null; del.textContent = 'Delete'; del.classList.remove('armed'); }, 3000);
          return;
        }
        clearTimeout(armed);
        send({ type: 'delete-workspace', name: w.name });
      };
      actions.append(open, del);
      card.append(info, actions);
      box.append(card);
    }
  }

  function open({ focusSave = false } = {}) {
    if (!dlg.open) {
      const t = tabs();
      input.value = t.find((x) => x.active)?.title || t[0]?.title || 'workspace';
      renderCurrent();
      renderList();
      syncSave();
      dlg.showModal();
      send({ type: 'list-workspaces' });
    }
    if (focusSave) { input.focus(); input.select(); }
    else ($('.ws-info') ?? input).focus();
  }
  function close() { if (dlg.open) dlg.close(); }

  return {
    open,
    close,
    get isOpen() { return dlg.open; },
    setList(l) { list = l; if (dlg.open) { renderList(); syncSave(); } },
  };
}
