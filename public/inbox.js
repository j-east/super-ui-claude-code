// Inbox: every Claude session in every window, in one panel. Sessions asking a question come first
// (answerable right here), then ones that finished and are waiting for your next message, then ones
// still working. Clicking a session jumps to its tab, raising its window if it lives in another one.
import { dialogCard } from './dialogcard.js';

const h = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const ago = (t) => {
  const m = Math.floor((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min` : m < 60 * 24 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d`;
};

/**
 * @param {{ button: HTMLElement, send: (m: object) => void, myWindow: string, tilde: (p: string) => string,
 *           onClose: () => void }} deps
 */
export function initInbox({ button, send, myWindow, tilde, onClose }) {
  let items = [];
  const panel = h('div', 'inbox');
  panel.hidden = true;
  document.body.append(panel);
  const count = h('span', 'inbox-count');
  button.append(count);

  const reveal = (it) => { send({ type: 'reveal', tab: it.tab }); close(); };

  function row(it) {
    const r = h('div', 'ib-row ' + it.state);
    const head = h('button', 'ib-head');
    head.title = 'Go to this tab';
    const name = it.label?.label || it.title;
    head.append(h('b', null, name));
    const where = [tilde(it.cwd), it.window !== myWindow ? 'other window' : '',
      it.state === 'idle' ? `idle ${ago(it.since)}` : ''].filter(Boolean).join(' · ');
    head.append(h('span', 'ib-meta', where));
    head.addEventListener('click', () => reveal(it));
    r.append(head);
    if (it.state !== 'waiting' && it.label?.summary) r.append(h('div', 'ib-sum', it.label.summary));
    if (it.dialog) {
      r.append(dialogCard(it.dialog, {
        onPick: (index) => send({ type: 'dialog-pick', tab: it.tab, index, sig: it.dialog.sig }),
        onCancel: () => send({ type: 'dialog-cancel', tab: it.tab, sig: it.dialog.sig }),
        onType: () => reveal(it), // free-text answers are typed in that tab's terminal
      }));
    }
    return r;
  }

  function render() {
    const waiting = items.filter((i) => i.state === 'waiting');
    const idle = items.filter((i) => i.state === 'idle').sort((a, b) => a.since - b.since); // longest-waiting first
    const working = items.filter((i) => i.state === 'working');
    count.textContent = waiting.length ? String(waiting.length) : '';
    button.classList.toggle('attn', waiting.length > 0);
    button.title = `Inbox: ${waiting.length} asking a question, ${idle.length} waiting for your next message, ${working.length} working (⌘I)`;
    if (panel.hidden) return;
    const scroll = panel.scrollTop;
    panel.replaceChildren();
    const section = (title, list) => {
      if (!list.length) return;
      panel.append(h('h3', null, `${title} (${list.length})`));
      for (const it of list) panel.append(row(it));
    };
    section('Asking you a question', waiting);
    section('Finished, waiting for your next message', idle);
    section('Working', working);
    if (!items.length) panel.append(h('div', 'ib-empty', 'No Claude sessions are running.'));
    panel.scrollTop = scroll;
  }

  function open() { panel.hidden = false; button.classList.add('on'); render(); }
  function close() { if (panel.hidden) return; panel.hidden = true; button.classList.remove('on'); onClose(); }
  button.addEventListener('click', () => (panel.hidden ? open() : close()));
  document.addEventListener('pointerdown', (e) => { if (!panel.hidden && !panel.contains(e.target) && !button.contains(e.target)) close(); }, true);
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); e.stopPropagation(); });
  setInterval(() => { if (!panel.hidden) render(); }, 30000); // keep "idle 5 min" fresh

  return {
    setItems(list) { items = list; render(); },
    toggle: () => (panel.hidden ? open() : close()),
    get isOpen() { return !panel.hidden; },
    close,
  };
}
