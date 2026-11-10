// One tab's view: its own xterm (bottom pane) and rendered transcript (top pane).
const MIN_PTY_ROWS = 12; // pty never shrinks below this; a short pane just shows the bottom rows
// Claude gets a taller pty than a snapped pane shows, so its screen (and the live preview) keeps room.
const MIN_CLAUDE_ROWS = 30;

DOMPurify.addHook('afterSanitizeAttributes', (n) => { if (n.tagName === 'A') { n.target = '_blank'; n.rel = 'noopener'; } });
const md = (text) => DOMPurify.sanitize(marked.parse(text, { gfm: true }));
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const SPINNER = /^\s*\S\s+\S.*…\s*\(/; // e.g. "✶ Symbioting… (10s · ↓ 317 tokens)"
const PLAIN = new Set(['text', 'txt', 'plain', 'plaintext', 'none', 'md', 'markdown']);
/** Highlight only fences that name a real language; unlabeled/plain-text blocks (often prose) wrap instead. */
function highlight(code) {
  const lang = [...code.classList].find((c) => c.startsWith('language-'))?.slice('language-'.length).toLowerCase();
  if (lang && !PLAIN.has(lang) && hljs.getLanguage(lang)) { hljs.highlightElement(code); return; }
  code.closest('pre')?.classList.add('plain');
}

import { dialogCard } from './dialogcard.js';
import { welcomeEl } from './welcome.js';

export class TabView {
  /** `pane`: where it starts out mounted (hidden); `mount()` moves it to another pane of a split. */
  constructor(id, { send, theme, home, screen, pane }) {
    this.id = id;
    this.send = (m) => send({ ...m, tab: id });
    this.home = home;
    this.mode = 'shell'; this.cwd = ''; this.busy = false; this.lunatic = false;
    this.attention = null; this.hasTranscript = false; this.tools = new Map();
    this.titles = { ai: '', custom: '', first: '' }; // session summary line sources
    this.pinned = true;      // transcript follows new content only while you're at the very bottom
    this.unseen = 0;         // messages that arrived while you were scrolled up
    this.needsRedraw = true; // fresh terminal: ask the program inside to repaint once visible

    this.logEl = el('div', 'tab-log');
    this.logInner = el('div', 'log');
    this.liveEl = el('div', 'msg live');
    this.liveEl.hidden = true;
    this.queueEl = el('div', 'queue');
    this.queueEl.hidden = true;
    this.dialogEl = el('div', 'dlg-dock'); // the question Claude is asking, stuck to the bottom of the transcript
    this.dialogEl.hidden = true;
    this.dialog = null;
    this.logEl.append(this.logInner, this.queueEl, this.dialogEl);
    // Scrolling up unpins; reaching the bottom again re-pins. Only an upward move counts as leaving,
    // so our own smooth scrolls (and content growing under you) never unpin by accident.
    let lastTop = 0;
    this.logEl.addEventListener('scroll', () => {
      if (!this.active) return;
      const top = this.logEl.scrollTop;
      if (this.atBottom()) this.setPinned(true);
      else if (top < lastTop - 1) this.setPinned(false);
      lastTop = top;
    });
    // The pane changes height (terminal auto-fit, window resize): stay at the bottom if pinned.
    new ResizeObserver(() => { if (this.pinned) this.scrollToBottom(); }).observe(this.logEl);

    this.jumpEl = el('button', 'jump-latest');
    this.jumpEl.hidden = true;
    this.jumpEl.addEventListener('click', () => { this.setPinned(true); this.glideToBottom(); this.term.focus(); });

    this.host = el('div', 'term-host');
    this.mount(pane);
    this.term = new Terminal({ fontFamily: 'Menlo, ui-monospace, monospace', fontSize: 13, cursorBlink: true,
      scrollback: 5000, theme, allowProposedApi: true, cols: screen?.cols ?? 120, rows: screen?.rows ?? 30 });
    this.fit = new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(this.host);
    if (screen?.data) this.term.write(screen.data);
    this.term.onData((data) => this.send({ type: 'input', data }));
    this.term.onResize(({ cols, rows }) => this.send({ type: 'resize', cols, rows }));
    this.setActive(false);
  }

  get name() { return this.cwd ? this.cwd.split(/[\\/]/).filter(Boolean).pop() || this.cwd : 'shell'; }
  /** Session summary line: Claude's AI title, else one you set, else your first message. */
  get title() { return this.mode === 'claude' || this.hasTranscript ? (this.titles.ai || this.titles.custom || this.titles.first) : ''; }
  tilde(p) { return this.home && p.startsWith(this.home) ? '~' + p.slice(this.home.length) : p; }

  /** Put this tab's transcript and terminal into a pane (no-op if already there). */
  mount(pane) {
    if (this.pane === pane) return;
    this.pane = pane;
    pane.transcriptEl.append(this.logEl, this.jumpEl);
    pane.termEl.append(this.host);
  }

  /** Shown in its pane or not. `focus`: also take the keyboard (false when shown in the other half of a split). */
  setActive(on, focus = true) {
    this.active = on;
    this.logEl.hidden = !on;
    this.host.hidden = !on;
    this.updateJump();
    if (on) {
      this.attention = null;
      requestAnimationFrame(() => {
        this.layout();
        if (this.needsRedraw) this.redraw();
        if (this.pinned) this.scrollToBottom();
        if (focus) this.term.focus();
      });
    }
  }

  /** Repaint: xterm's own rows, plus a pty nudge so Claude Code redraws its whole screen. */
  redraw() {
    this.needsRedraw = false;
    this.term.refresh(0, this.term.rows - 1);
    this.send({ type: 'redraw' });
  }

  scrollToBottom() { if (this.active) this.logEl.scrollTop = this.showsWelcome ? 0 : this.logEl.scrollHeight; }
  get showsWelcome() { return !this.hasTranscript && this.mode === 'shell'; }
  atBottom() { return this.logEl.scrollHeight - this.logEl.scrollTop - this.logEl.clientHeight < 8; }

  setPinned(on) {
    if (on === this.pinned && !(on && this.unseen)) return;
    this.pinned = on;
    if (on) this.unseen = 0;
    this.updateJump();
  }

  /** "↓ 3 new messages" pill while you're scrolled up; "↓ Latest" if only tool steps came in. */
  updateJump() {
    const show = this.active && !this.pinned;
    this.jumpEl.hidden = !show;
    if (show) this.jumpEl.textContent = this.unseen ? `↓ ${this.unseen} new message${this.unseen === 1 ? '' : 's'}` : '↓ Latest';
  }

  cellH() { return this.term._core?._renderService?.dimensions?.css?.cell?.height || 17; }

  layout() {
    if (!this.active) return;
    const paneH = this.pane.termEl.clientHeight;
    const cell = this.cellH();
    const min = this.mode === 'claude' ? MIN_CLAUDE_ROWS : MIN_PTY_ROWS;
    this.host.style.height = Math.max(paneH - 4, min * cell) + 'px';
    try { this.fit.fit(); } catch { /* not ready */ }
    this.send({ type: 'resize', cols: this.term.cols, rows: this.term.rows });
  }

  dispose() { this.term.dispose(); this.logEl.remove(); this.jumpEl.remove(); this.host.remove(); }

  // ---------- transcript ----------
  reset(entries) {
    this.logInner.replaceChildren();
    this.liveEl.hidden = true;
    this.tools.clear();
    this.lastGroup = null;
    this.titles = { ai: '', custom: '', first: '' };
    this.hasTranscript = entries.length > 0;
    if (!entries.length) this.logInner.append(this.emptyState());
    this.setPinned(true);
    this.append(entries);
  }

  append(entries) {
    if (entries.length) { this.logInner.querySelector('.empty, .welcome')?.remove(); this.hasTranscript = true; }
    for (const e of entries) {
      const n = this.render(e);
      if (!n) continue;
      if (e.kind !== 'tool') this.lastGroup = null; // a message/other step ends a run of repeats
      this.logInner.append(n);
    }
    if (entries.length) this.setLive('');
    // Follow only if you're at the bottom. A message you just sent brings you down (you want the reply);
    // anything else arriving while you're scrolled up is counted on the "new messages" pill.
    if (entries.some((e) => e.kind === 'user')) { this.setPinned(true); this.term.scrollToBottom(); }
    if (this.pinned) this.scrollToBottom();
    else {
      this.unseen += entries.filter((e) => e.kind === 'assistant' || e.kind === 'command' || e.kind === 'recap').length;
      this.updateJump();
    }
  }

  note(text, cls = 'note') {
    this.logInner.querySelector('.empty, .welcome')?.remove();
    this.logInner.append(el('div', `msg ${cls}`, text));
    this.lastGroup = null;
    if (this.pinned) this.scrollToBottom();
    else { this.unseen++; this.updateJump(); }
  }

  /**
   * Streaming preview mirrored from the terminal; replaced by the real entry when it lands.
   * Grows only: lines are updated in place or appended, never re-laid-out wholesale, and the
   * block never shrinks during a run. The spinner/status line lives in a fixed one-line footer.
   */
  setLive(text) {
    if (!text) {
      this.liveEl.hidden = true;
      this.liveEl.remove();
      this.liveLines = [];
      this.liveEl.style.minHeight = '';
      return;
    }
    if (!this.liveBody) {
      this.liveBody = el('div', 'live-body');
      this.liveStatus = el('div', 'live-status');
      this.liveEl.append(this.liveBody, this.liveStatus);
      this.liveLines = [];
    }
    const lines = text.split('\n');
    // Claude Code's spinner line ("✶ Symbioting… (10s · ↓ 317 tokens)") and anything under it = status.
    let cut = -1;
    for (let i = lines.length - 1; i >= 0; i--) if (SPINNER.test(lines[i])) { cut = i; break; }
    const body = (cut >= 0 ? lines.slice(0, cut) : lines);
    while (body.length && !body[body.length - 1].trim()) body.pop();
    const status = cut >= 0 ? lines.slice(cut).map((l) => l.trim()).filter(Boolean).join('   ·   ') : '';

    // Screen scrolled (fewer lines now): keep what we showed and append only what's new.
    let next = body;
    const prev = this.liveLines;
    if (body.length < prev.length) {
      let k = Math.min(prev.length, body.length);
      for (; k > 0; k--) if (prev.slice(-k).join('\n') === body.slice(0, k).join('\n')) break;
      next = k > 0 ? prev.concat(body.slice(k)) : prev.slice(0, prev.length - body.length).concat(body);
    }
    this.liveLines = next;

    const kids = this.liveBody.children;
    next.forEach((line, i) => {
      if (kids[i]) { if (kids[i].textContent !== line) kids[i].textContent = line; }
      else this.liveBody.append(el('div', 'live-line', line || ' '));
    });
    while (kids.length > next.length) kids[kids.length - 1].remove();
    if (this.liveStatus.textContent !== status) this.liveStatus.textContent = status;

    const wasShown = !this.liveEl.hidden && this.liveEl.isConnected;
    this.liveEl.hidden = false;
    if (!wasShown || this.logInner.lastElementChild !== this.liveEl) this.logInner.append(this.liveEl); // always last
    // Never shrink mid-run: lock in the tallest height so far.
    const h = this.liveEl.offsetHeight;
    if (h > (parseFloat(this.liveEl.style.minHeight) || 0)) this.liveEl.style.minHeight = h + 'px';
    if (this.pinned) this.glideToBottom();
  }

  /** The question Claude Code is showing (or null): a card with every option, answerable by click. */
  setDialog(d) {
    this.dialog = d;
    this.dialogEl.replaceChildren();
    this.dialogEl.hidden = !d;
    if (!d) return;
    this.dialogEl.append(dialogCard(d, {
      onPick: (index) => this.send({ type: 'dialog-pick', index, sig: d.sig }),
      onCancel: () => this.send({ type: 'dialog-cancel', sig: d.sig }),
      onType: () => this.term.focus(),
    }));
    if (this.pinned) this.glideToBottom();
  }

  /** Messages you typed while Claude was busy. Click one to interrupt and deliver them now. */
  setQueue(items) {
    this.queueEl.replaceChildren();
    this.queueEl.hidden = !items.length;
    if (!items.length) return;
    const head = el('div', 'queue-head', items.length > 1 ? `${items.length} queued messages` : 'Queued message');
    this.queueEl.append(head);
    for (const text of items) {
      const b = el('button', 'queued', text);
      b.title = items.length > 1 ? 'Send now (all queued messages go together)' : 'Send now instead of waiting for Claude to finish';
      b.addEventListener('click', () => {
        if (this.queueEl.classList.contains('sending')) return;
        this.queueEl.classList.add('sending');
        head.textContent = 'Sending…';
        this.send({ type: 'send-queued' });
      });
      this.queueEl.append(b);
    }
    this.queueEl.classList.remove('sending');
    if (this.pinned) this.glideToBottom();
  }

  /** Follow growth smoothly when it's a small step; jump when it's far. */
  glideToBottom() {
    if (!this.active) return;
    const target = this.logEl.scrollHeight - this.logEl.clientHeight;
    const delta = target - this.logEl.scrollTop;
    if (delta <= 1) return;
    this.logEl.scrollTo({ top: target, behavior: delta < 400 ? 'smooth' : 'auto' });
  }

  setMode(mode, cwd) {
    const changed = mode !== this.mode || cwd !== this.cwd;
    this.mode = mode; this.cwd = cwd;
    if (changed) this.refreshEmpty();
  }

  /** Redraw the start screen (folder changed, or setup info arrived) if that's what this tab shows. */
  refreshEmpty() {
    if (this.hasTranscript) return;
    this.logInner.replaceChildren(this.emptyState());
    if (this.mode === 'shell') this.logEl.scrollTop = 0;
  }

  emptyState() {
    if (this.mode === 'claude') return el('div', 'empty', 'Waiting for the first message…');
    return welcomeEl(this);
  }

  pendingTool() { return [...this.tools.values()].reverse().find((t) => !t.done) ?? null; }

  render(e) {
    switch (e.kind) {
      case 'title': this.titles[e.source] = e.text; return null;
      case 'user':
        if (!this.titles.first) this.titles.first = e.text.split('\n')[0].slice(0, 80);
        return el('div', 'msg user', e.text);
      case 'command': return el('div', 'msg command', `${e.name} ${e.args}`.trim());
      case 'note': return el('div', 'msg note', e.text);
      case 'recap': {
        const n = el('div', 'recap');
        n.append(el('span', 'recap-label', 'Recap'), el('span', null, e.text));
        return n;
      }
      case 'compact': {
        const d = el('details', 'compacted');
        d.append(el('summary', null, 'Conversation compacted'), el('div', 'body', e.text));
        return d;
      }
      case 'assistant': {
        const n = el('div', 'msg assistant');
        n.innerHTML = md(e.text);
        n.querySelectorAll('pre code').forEach(highlight);
        return n;
      }
      case 'thinking': {
        const d = el('details', 'thinking');
        d.append(el('summary', null, 'Thinking'), el('div', 'body', e.text));
        return d;
      }
      case 'tool': {
        // Consecutive identical calls (same tool + description) collapse into one row: "name ×N".
        const key = `${e.name}\u0000${e.summary}`;
        const call = el('div', 'call');
        call.append(el('pre', 'input', e.input));
        let g = this.lastGroup?.key === key ? this.lastGroup : null;
        const fresh = !g;
        if (!g) {
          const d = el('details', 'tool');
          const s = el('summary');
          const mark = el('span', 'mark wait');
          const count = el('span', 'count');
          s.append(el('span', 'name', e.name.replace(/^mcp__/, '')), document.createTextNode(e.summary ? `  ${e.summary}` : ''), count, mark);
          d.append(s);
          g = { key, el: d, mark, count, calls: [] };
          this.lastGroup = g;
        }
        g.calls.push({ done: false, error: false });
        g.el.append(call);
        this.tools.set(e.toolId, { group: g, idx: g.calls.length - 1, call, name: e.name, summary: e.summary, done: false });
        this.updateGroup(g);
        return fresh ? g.el : null;
      }
      case 'result': {
        const t = this.tools.get(e.toolId);
        if (!t) return null;
        t.done = true;
        Object.assign(t.group.calls[t.idx], { done: true, error: e.isError });
        if (e.text) t.call.append(el('pre', 'result', e.text));
        this.updateGroup(t.group);
        return null;
      }
    }
    return null;
  }

  updateGroup(g) {
    const n = g.calls.length;
    g.el.classList.toggle('grouped', n > 1);
    g.count.textContent = n > 1 ? ` ×${n}` : '';
    const pending = g.calls.some((c) => !c.done), failed = g.calls.filter((c) => c.error).length;
    g.mark.className = 'mark ' + (pending ? 'wait' : failed ? 'err' : 'ok');
    g.mark.textContent = pending ? '' : failed ? (n > 1 ? `✕ ${failed} failed` : '✕') : '✓';
  }
}
