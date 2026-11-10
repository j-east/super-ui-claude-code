// One column of the window: launcher bar, transcript, status strip (divider) and terminal, showing one
// tab at a time. A window has one pane, or two side by side when split.

const h = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const LUNATIC_WARNING = 'Lunatic mode for this tab:\n\nWhenever Claude shows a numbered prompt with option 1 highlighted, ' +
  'Enter is pressed for you after 3 seconds of you not typing. That approves every tool call ' +
  '(including commands that delete or overwrite) and picks the first answer to Claude\'s questions.\n\nTurn it on?';

// Terminal height is remembered across panes and windows; auto-fit (Claude tabs show just the input box) too.
let savedH = Number(localStorage.getItem('termH') ?? 260);
const autoFitOn = () => localStorage.getItem('termAuto') !== '0';
const setAutoFit = (on) => localStorage.setItem('termAuto', on ? '1' : '0');

export class Pane {
  /** @param {{ send: (m: object) => void, onFocus: (p: Pane) => void }} deps */
  constructor(container, { send, onFocus }) {
    this.send = send;
    this.view = null;
    this.el = h('section', 'pane');
    this.el.innerHTML = `
      <header class="pane-head"><b class="ph-label"></b><span class="ph-sum"></span></header>
      <header class="launcher" hidden>
        <span>📁</span><span class="cwd"></span>
        <button data-act="choose">Choose folder…</button>
        <button data-act="continue">Continue last</button>
        <button data-act="new" class="primary">Launch Claude</button>
      </header>
      <main class="transcript"></main>
      <div class="divider" title="Drag to resize · double-click: auto-fit (Claude tabs) or collapse/restore">
        <span class="dot"></span><span class="status">connecting…</span><span class="where"></span>
        <button class="lunatic" title="Auto-pick option 1 on Claude's prompts in this tab">🌀 Lunatic</button>
      </div>
      <section class="term-pane"></section>`;
    container.append(this.el);
    const q = (s) => this.el.querySelector(s);
    this.transcriptEl = q('.transcript');
    this.termEl = q('.term-pane');
    this.dividerEl = q('.divider');
    this.statusEl = q('.status'); this.dotEl = q('.dot'); this.whereEl = q('.where');
    this.headLabel = q('.ph-label'); this.headSum = q('.ph-sum');
    this.lunaticBtn = q('.lunatic'); this.launcherEl = q('.launcher'); this.cwdEl = q('.cwd');

    // Clicking anywhere in a pane makes it the one the tab bar and keyboard act on.
    this.el.addEventListener('pointerdown', () => onFocus(this), true);

    this.launcherEl.addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (!act || !this.view) return;
      if (act === 'choose') send({ type: 'choose-folder', tab: this.view.id });
      else send({ type: 'launch', tab: this.view.id, kind: act });
    });

    this.lunaticBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    this.lunaticBtn.onclick = () => {
      if (!this.view) return;
      const on = !this.view.lunatic;
      if (on && !confirm(LUNATIC_WARNING)) return;
      send({ type: 'lunatic', tab: this.view.id, on });
    };

    // ---------- terminal height ----------
    this.termH = savedH;
    this.restoreH = savedH > 0 ? savedH : 260;
    this.setTermH(this.termH, false);
    this.dividerEl.addEventListener('mousedown', (e) => {
      if (e.target === this.lunaticBtn) return;
      e.preventDefault();
      const bottom = this.el.getBoundingClientRect().bottom;
      const move = (ev) => { setAutoFit(false); this.setTermH(bottom - ev.clientY - this.dividerEl.offsetHeight / 2); };
      const up = () => {
        window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
        if (this.termH > 0) this.restoreH = this.termH;
        this.view?.term.focus();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    this.dividerEl.addEventListener('dblclick', (e) => {
      if (e.target === this.lunaticBtn) return;
      if (this.view?.mode === 'claude' && !autoFitOn()) { setAutoFit(true); this.autoSnap(); this.view.term.focus(); return; }
      if (this.termH > 0) { this.restoreH = this.termH; this.setTermH(0); } else this.setTermH(this.restoreH);
      this.view?.term.focus();
    });
    this.ro = new ResizeObserver(() => requestAnimationFrame(() => this.view?.layout()));
    this.ro.observe(this.termEl);
  }

  setTermH(px, remember = true) {
    let t = Math.max(0, Math.min(px, this.el.clientHeight ? this.el.clientHeight - 160 : window.innerHeight - 160));
    if (t < 24) t = 0;
    this.termH = t;
    this.el.style.setProperty('--term-h', t + 'px');
    if (remember) { savedH = t; localStorage.setItem('termH', String(t)); }
  }

  /** Claude tab with auto-fit on: size the terminal to Claude Code's input box (or the dialog waiting on you). */
  autoSnap() {
    const v = this.view;
    if (!autoFitOn() || !v || v.mode !== 'claude' || !v.snapRows) return;
    const px = Math.ceil(v.snapRows * v.cellH()) + 10;
    if (Math.abs(px - this.termH) > 2) this.setTermH(px, false);
  }

  /** Show a tab here (hiding the one shown before). `focus`: give it the keyboard. */
  show(view, focus = true) {
    if (this.view && this.view !== view) this.view.setActive(false);
    view.mount(this);
    this.view = view;
    view.setActive(true, focus);
    this.update();
  }

  clear() { this.view = null; this.update(); }

  setFocused(on) { this.el.classList.toggle('focused', on); }

  /** Launcher bar and status strip for the tab shown here. */
  update() {
    const v = this.view;
    // The start screen has these buttons itself; the bar is for a shell tab that still shows an old transcript.
    this.launcherEl.hidden = !v || v.mode !== 'shell' || !v.hasTranscript;
    this.el.classList.toggle('lunatic', !!v?.lunatic);
    // Split view: a header saying which session this half is (the auto label and its sentence).
    const labelled = v && (v.mode === 'claude' || v.hasTranscript) ? v.label : null;
    this.headLabel.textContent = v ? (v.mode === 'claude' ? '✳ ' : '') + (labelled?.label || v.title || v.name) : 'No tab';
    const sum = !v ? '' : labelled?.summary || (v.title && v.title !== this.headLabel.textContent ? v.title : v.tilde(v.cwd));
    this.headSum.textContent = sum; this.headSum.title = sum;
    if (!v) { this.statusEl.textContent = 'No tab'; this.whereEl.textContent = ''; return; }
    this.cwdEl.textContent = v.tilde(v.cwd); this.cwdEl.title = v.cwd;
    this.whereEl.textContent = v.tilde(v.cwd);
    this.dotEl.className = 'dot' + (v.busy ? ' busy' : '');
    const pending = v.pendingTool();
    this.statusEl.textContent = v.mode === 'shell' ? 'Shell'
      : pending ? `${pending.name.replace(/^mcp__/, '')}${pending.summary ? ': ' + pending.summary : ''}`
      : v.busy ? 'Working…' : 'Ready';
    this.lunaticBtn.classList.toggle('on', v.lunatic);
    this.lunaticBtn.textContent = v.lunatic ? '🌀 Lunatic ON' : '🌀 Lunatic';
    // A shell needs its full 12-row terminal visible to navigate; shorter panes clip the prompt off the top.
    if (v.mode === 'shell' && this.termH < 220) this.setTermH(Math.max(this.restoreH, 260), false);
    this.autoSnap();
  }

  dispose() { this.ro.disconnect(); this.el.remove(); }
}
