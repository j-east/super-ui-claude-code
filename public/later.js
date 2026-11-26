// The "Unfinished" tray under the tabs (closed Claude tabs that left loose ends, or are still being
// read; a tab that left nothing open never shows here) and the
// Clean up dialog (the open tabs with checkboxes; the ones that look finished come ticked).
// The server owns the list and does the reading; this renders what it sends.

const h = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const ago = (at) => {
  const m = Math.round((Date.now() - at) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
};
const STATUS = { done: 'Done', nearly: 'Nearly done', active: 'Still going', unknown: 'Not judged' };

/** @param {{ send: (m: object) => void, box: HTMLElement, claudeTabs: () => number }} deps */
export function initLater({ send, box, claudeTabs }) {
  let items = [];
  let open = localStorage.getItem('later-open') !== '0';

  // ---------- the list ----------
  const head = h('div', 'later-head');
  const toggle = h('button', 'later-toggle');
  const clean = h('button', 'later-clean', 'Tidy tabs…');
  clean.title = 'Look over the open tabs and close the ones that are finished';
  const wrap = h('button', 'later-wrap', 'Finish these in one session');
  wrap.title = 'Opens one new session with all of these loose ends as its job, and empties this tray. The list is kept in todo/loose-ends.md so nothing is lost; the brief is typed in for you to send.';
  wrap.onclick = () => send({ type: 'later-wrap' });
  head.append(toggle, clean);
  const list = h('div', 'later-list');
  box.append(head, list);
  toggle.onclick = () => { open = !open; localStorage.setItem('later-open', open ? '1' : '0'); render(); };
  clean.onclick = () => review();

  let expanded = null; // id of the item whose digest is showing
  function render() {
    toggle.textContent = items.length ? `${open ? '▾' : '▸'} Unfinished · ${items.length}` : '';
    toggle.title = 'Tabs you closed that left loose ends. Closed tabs with nothing left open are not kept here.';
    toggle.disabled = !items.length;
    list.hidden = !open || !items.length;
    list.replaceChildren();
    for (const it of items) {
      const loose = it.loose ?? [];
      const row = h('div', 'later-item' + (expanded === it.id ? ' open' : ''));
      const text = h('button', 'later-text');
      const n = loose.length || (it.left ? 1 : 0);
      const sub = it.digested === false ? 'Checking for loose ends…' : `${n} loose end${n > 1 ? 's' : ''} · ${ago(it.closedAt)}`;
      text.append(h('span', 'later-name', it.label), h('span', 'later-sub' + (loose.length ? ' has-loose' : ''), sub));
      text.onclick = () => { expanded = expanded === it.id ? null : it.id; render(); };
      const x = h('button', 'later-x', '×');
      x.title = 'Read it, done with it: take it off the list';
      x.onclick = () => send({ type: 'later-done', id: it.id });
      row.append(text, x);
      list.append(row);
      if (expanded !== it.id) continue;
      const card = h('div', 'later-card');
      card.append(h('p', null, it.outcome || it.summary || (it.digested === false ? 'The digest is being written…' : 'No digest for this one.')));
      if (loose.length) {
        const ul = h('ul');
        for (const l of loose) ul.append(h('li', null, l));
        card.append(h('div', 'later-h', 'Loose ends'), ul);
      } else if (it.left) card.append(h('div', 'later-h', 'Left open'), h('p', null, it.left));
      const acts = h('div', 'later-acts');
      const re = h('button', null, 'Reopen'); re.title = 'Back as a tab, with the conversation resumed';
      re.onclick = () => send({ type: 'later-open', id: it.id });
      const done = h('button', null, 'Dismiss'); done.onclick = () => send({ type: 'later-done', id: it.id });
      acts.append(re, done);
      card.append(acts);
      list.append(card);
    }
    if (items.some((it) => it.digested !== false)) list.append(wrap);
  }
  render();

  // ---------- clean up ----------
  const dlg = h('dialog', 'ws-dialog cu-dialog');
  dlg.innerHTML = `
    <header><h2>Clean up</h2><button class="ws-x" title="Close (Esc)">×</button></header>
    <section class="cu-body"></section>
    <footer class="cu-foot"><span class="ws-muted">Closed tabs that left loose ends wait in the Unfinished tray; the rest just close. No session log is deleted.</span>
      <button class="cu-cancel" type="button">Cancel</button><button class="primary cu-go" type="button">Close</button></footer>`;
  document.body.append(dlg);
  const body = dlg.querySelector('.cu-body');
  const go = dlg.querySelector('.cu-go');
  let rows = [];
  const close = () => { if (dlg.open) dlg.close(); };
  dlg.querySelector('.ws-x').onclick = close;
  dlg.querySelector('.cu-cancel').onclick = close;
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  const sync = () => {
    const n = rows.filter((r) => r.checked).length;
    go.textContent = n ? `Close ${n} tab${n > 1 ? 's' : ''}` : 'Close';
    go.disabled = !n;
  };
  go.onclick = () => {
    send({ type: 'cleanup-apply', close: rows.filter((r) => r.checked).map((r) => ({ tab: r.tab, left: r.left })) });
    close();
  };

  function review() {
    rows = [];
    body.replaceChildren(h('div', 'cu-wait', claudeTabs() ? 'Reading your open sessions… this takes up to a minute.' : 'No Claude sessions are open in this window.'));
    sync();
    if (!dlg.open) dlg.showModal();
    if (claudeTabs()) send({ type: 'cleanup-review' });
  }
  function setRows(list) {
    if (!dlg.open) return;
    rows = list;
    body.replaceChildren();
    if (!rows.length) body.append(h('div', 'cu-wait', 'No Claude sessions are open in this window.'));
    else if (rows.every((r) => r.status === 'unknown')) body.append(h('div', 'cu-wait', 'Could not read the sessions just now, so nothing is ticked. You can still pick by hand.'));
    // Suggested ones first, then the rest in tab order.
    for (const r of [...rows].sort((a, b) => Number(b.checked) - Number(a.checked))) {
      const row = h('label', 'cu-row');
      const tick = h('input'); tick.type = 'checkbox'; tick.checked = r.checked;
      tick.onchange = () => { r.checked = tick.checked; sync(); };
      const text = h('span', 'cu-text');
      const top = h('span', 'cu-top');
      const state = r.state === 'working' ? 'Working now' : r.state === 'waiting' ? 'Waiting for you' : STATUS[r.status];
      top.append(h('span', 'cu-name', r.label), h('span', `cu-chip ${r.state !== 'idle' ? 'live' : r.status}`, state));
      text.append(top);
      if (r.left) text.append(h('span', 'cu-left', `Left: ${r.left}`));
      else if (r.why) text.append(h('span', 'cu-left', r.why));
      row.append(tick, text);
      body.append(row);
    }
    sync();
  }

  return {
    setItems(list) { items = list; render(); },
    setRows,
    get isOpen() { return dlg.open; },
  };
}
