// One tab = one login shell in a pty, plus claude detection, transcript following,
// attention alerts, and optional lunatic mode (auto-pick option 1 on prompts).
import path from 'node:path';
import { PtySession } from './session.js';
import { WIN, CLEAR_LINE, shellCommand } from './platform.js';
import { ProcWatch } from './procwatch.js';
import { Screen, type Dialog } from './screen.js';
import { cachedLabel, maybeLabel, type Label } from './labeler.js';
import { TranscriptFollower, projectDirFor, resumedSessionId, sessionIdForPid, findTranscript, type Entry } from './transcript.js';

export type Emit = (msg: Record<string, unknown>) => void;

const BUSY_WINDOW = 1200;     // output within this many ms = "working"
const MIN_BUSY_FOR_ALERT = 1500;
const LUNATIC_QUIET = 800;     // screen must be still this long before auto-answering
const LUNATIC_USER_IDLE = 3000; // ...and you must not have typed for this long
const ECHO_MS = 350;           // output this soon after a keypress/resize is echo/redraw, not work
const LIVE_EVERY = 400;        // live preview refresh while working

export class Tab {
  private shell: PtySession;
  private watch: ProcWatch;
  private screen = new Screen(120, 30);
  private follower: TranscriptFollower | null = null;
  private shellCwd: string;
  private timer: NodeJS.Timeout;
  private lastInputAt = 0;
  private busy = false;
  private busyStart = 0;
  private pendingIdle = false;
  private lastSig = '';
  private disposed = false;
  private promptAt = -1;
  private promptCache: ReturnType<Screen['prompt']> | undefined;
  lunatic = false;
  private dialog: Dialog | null = null; // the question Claude Code is showing, if any
  private dialogAt = -1;
  private idleSince = Date.now();       // when Claude last stopped working (for the inbox)
  private label: Label | null = null; // a few words + a sentence about the session, for the tab

  private lastWorkAt = 0;      // last output that wasn't just echo of your typing
  private ignoreUntil = 0;
  private snapAt = 0; private lastSnapCheck = 0; snapRows = 0; // rows Claude Code's bottom box needs
  private liveBaseline: string[] = []; // screen lines already covered by the transcript
  private lastLive = '';
  private lastLiveAt = 0;
  private cols = 120;
  private rows = 30;

  constructor(readonly id: string, public windowId: string, cwd: string, private emit: Emit) {
    this.shellCwd = cwd;
    const sh = shellCommand();
    this.shell = new PtySession(sh.file, sh.args, cwd);
    this.shell.onData((data) => {
      if (Date.now() > this.ignoreUntil) this.lastWorkAt = Date.now();
      this.screen.write(data);
      this.watch?.feed(data);
      this.emit({ type: 'output', data });
    });
    this.watch = new ProcWatch(this.shell.pid, {
      shellCwd: (c) => { this.shellCwd = c; this.emit(this.modeMsg()); },
      claudeStart: (p) => {
        if (this.disposed) return;
        this.follower?.stop();
        const dir = projectDirFor(p.cwd);
        this.follower = new TranscriptFollower(dir, p.startedAt - 3000, {
          reset: (file: string, entries: Entry[]) => {
            this.emit({ type: 'transcript-reset', file: path.basename(file), entries });
            setTimeout(() => this.relabel(), 1500); // after the session id settles
          },
          append: (entries: Entry[]) => {
            this.emit({ type: 'transcript-append', entries });
            // What's on screen now is (about to be) in the transcript; only show what comes after it.
            this.liveBaseline = this.screen.liveLines();
            this.lastLive = '';
          },
          queue: (items: string[]) => this.emit({ type: 'queue', items }),
        }, resumedSessionId(dir, p.args), () => {
          const id = sessionIdForPid(p.pid);
          return id ? findTranscript(id, dir) : null;
        });
        this.emit({ type: 'transcript-reset', file: null, entries: [] });
        this.setLabel(null);
        this.dialogAt = -1; // re-read the screen: a dialog may already be showing
        this.liveBaseline = this.screen.liveLines(); // shell output before claude isn't "live"
        this.lastLive = '';
        this.follower.start();
        this.emit(this.modeMsg());
      },
      claudeStop: () => { this.follower?.stop(); this.dialogAt = -1; this.emit(this.modeMsg()); },
    }, () => this.shell.lastOutputAt);
    this.watch.start();
    this.timer = setInterval(() => this.tick(), 300);
  }

  get exitCode(): number | null { return this.shell.exitCode; }
  onExit(f: (code: number) => void): void { this.shell.onExit(f); }

  snapshot(): Record<string, unknown> {
    const snap = this.follower?.snapshot();
    return { type: 'tab-open', screen: this.screen.snapshot(), file: snap?.file ? path.basename(snap.file) : null,
      entries: snap?.entries ?? [], queue: snap?.queue ?? [], lunatic: this.lunatic, busy: this.busy, snapRows: this.snapRows, label: this.label, dialog: this.dialog, ...this.modeFields() };
  }

  input(data: string): void {
    this.lastInputAt = Date.now();
    this.ignoreUntil = this.lastInputAt + ECHO_MS;
    this.shell.write(data);
  }
  resize(cols: number, rows: number): void {
    cols = Math.min(cols, 1000); rows = Math.min(rows, 500);
    if (cols > 0 && rows > 0 && !this.disposed) { this.ignoreUntil = Date.now() + ECHO_MS; this.cols = cols; this.rows = rows; this.shell.resize(cols, rows); this.screen.resize(cols, rows); }
  }
  /** Nudge the pty size so the program inside (Claude Code) repaints the whole screen. */
  redraw(): void {
    if (this.rows < 3) return;
    this.ignoreUntil = Date.now() + ECHO_MS + 60;
    this.shell.resize(this.cols, this.rows - 1);
    setTimeout(() => { if (!this.disposed) this.shell.resize(this.cols, this.rows); }, 60);
  }
  setLunatic(on: boolean): void { this.lunatic = on; this.lastSig = ''; this.emit({ type: 'lunatic', on }); }
  /** Deliver queued messages now instead of at Claude's next break (Claude Code's own ctrl+x ctrl+s). */
  sendQueuedNow(): void {
    if (this.watch.current() && this.follower?.snapshot().queue.length) this.input('\x18\x13');
  }

  /** Type a command at the shell prompt (clearing anything half-typed first). Only when claude isn't running. */
  /**
   * Type a command at the shell prompt (clearing anything half-typed first). Only when the shell
   * itself is in the foreground: never into claude, vim, ssh, a REPL or a dev server.
   */
  /**
   * Type a command at the shell prompt, but only when the shell itself is idle at its prompt (never into
   * ssh, vim, a dev server, or a running claude). `waitMs`: a fresh tab's login shell takes a while to
   * start (conda, nvm, compinit…), so keep checking until it's ready and has stopped printing.
   */
  async typeCommand(cmd: string, waitMs = 0): Promise<boolean> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      if (this.disposed) return false;
      const ready = !this.watch.current() && Date.now() - this.shell.lastOutputAt >= (waitMs ? 400 : 0)
        && this.shell.lastOutputAt > 0 && (await this.watch.shellIdle());
      if (this.disposed) return false;
      if (ready) {
        this.shell.write(CLEAR_LINE);
        // PowerShell clears the line with Esc; typed straight after, the first letter would read as Alt+letter.
        if (WIN) await new Promise((r) => setTimeout(r, 120));
        this.shell.write(`${cmd}\r`);
        return true;
      }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    this.emit({ type: 'toast', text: 'Something is running in this tab’s terminal, so nothing was typed.' });
    return false;
  }
  debug(): Promise<Record<string, unknown>> { return this.watch.debug(); }
  get cwd(): string { return this.shellCwd; }
  get claudeRunning(): boolean { return !!this.watch.current(); }
  /** Claude is mid-task (printing), as opposed to waiting at its prompt. */
  get working(): boolean { return this.busy; }
  get labelText(): string | null { return this.label?.label ?? null; }
  /** Session id of the transcript this tab is showing (its file name), if any. */
  get sessionId(): string | null {
    // Claude Code's own record for the running process is authoritative, once it has a transcript
    // (a session with no messages yet can't be resumed).
    const c = this.watch.current();
    const live = c ? sessionIdForPid(c.pid) : null;
    if (live && findTranscript(live)) return live;
    const f = this.follower?.snapshot().file;
    return f ? path.basename(f, '.jsonl') : null;
  }
  /** Same summary line the UI shows: AI title, else one you set, else your first message. */
  get title(): string {
    const es = this.follower?.snapshot().entries ?? [];
    const t = (src: 'ai' | 'custom') => es.filter((e) => e.kind === 'title' && e.source === src).at(-1);
    const first = es.find((e) => e.kind === 'user');
    const pick = t('ai') ?? t('custom');
    if (pick && pick.kind === 'title') return pick.text;
    if (first && first.kind === 'user') return first.text.split('\n')[0]!.slice(0, 80);
    return path.basename(this.cwd) || '/';
  }

  private setDialog(d: Dialog | null): void {
    if ((d?.sig ?? null) === (this.dialog?.sig ?? null)) return;
    this.dialog = d;
    this.emit({ type: 'dialog', dialog: d });
  }

  /** Pick a row of the dialog on screen. `sig` must match what is showing now, so a stale click does nothing. */
  pickDialog(index: number, sig: string): void {
    const d = this.watch.current() ? this.screen.dialog() : null;
    if (!d || d.sig !== sig) { this.setDialog(d); return; }
    const keys = Screen.keysFor(d, index);
    if (keys) this.input(keys);
  }
  /** Esc: dismiss the dialog. */
  cancelDialog(sig: string): void { if (this.dialog?.sig === sig) this.input('\x1b'); }

  /** This tab as the inbox lists it; null for a plain shell. */
  inboxItem(): Record<string, unknown> | null {
    if (!this.watch.current()) return null;
    return { tab: this.id, window: this.windowId, title: this.title, label: this.label, cwd: this.watch.current()!.cwd,
      state: this.dialog ? 'waiting' : this.busy ? 'working' : 'idle', since: this.idleSince, dialog: this.dialog };
  }

  private setLabel(l: Label | null): void {
    if (JSON.stringify(l) === JSON.stringify(this.label)) return;
    this.label = l;
    this.emit({ type: 'label', label: l });
  }

  /** Show the cached label for this session, and ask for a fresh one if the session has moved on. */
  private relabel(): void {
    if (this.disposed || !this.follower) return;
    const sid = this.sessionId;
    const c = cachedLabel(sid);
    if (c) this.setLabel(c);
    maybeLabel(sid, this.watch.current()?.cwd ?? this.cwd, this.follower.snapshot().entries, (l) => { if (!this.disposed && this.sessionId === sid) this.setLabel(l); });
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
    this.watch.stop();
    this.follower?.stop();
    this.shell.kill();
    this.screen.dispose();
  }

  /**
   * What Claude is doing right now: the screen above its input box, starting after your latest message
   * (Claude Code echoes it as "❯ …"), so the last answer, "Worked for…" and the recap above it don't
   * repeat what the transcript shows. Then minus whatever was on screen when the transcript last grew.
   */
  private liveText(): string {
    let cur = this.screen.liveLines(200);
    let p = -1;
    for (let i = cur.length - 1; i >= 0; i--) if (/^\s*❯\s\S/.test(cur[i]!)) { p = i; break; }
    if (p >= 0) {
      let j = p + 1;
      while (j < cur.length && /^\s{2,}\S/.test(cur[j]!)) j++; // the message's wrapped lines
      cur = cur.slice(j);
      while (cur.length && !cur[0]!.trim()) cur.shift();
    }
    const base = this.liveBaseline;
    let k = Math.min(base.length, cur.length);
    // Content scrolls up: find the longest tail of the baseline that is the head of the current screen.
    for (; k > 0; k--) if (base.slice(-k).join('\n') === cur.slice(0, k).join('\n')) break;
    if (k === 0 && base.length && cur.join('\n') === base.join('\n')) return '';
    const out = cur.slice(k).slice(-24);
    return out.join('\n').trim() ? out.join('\n') : '';
  }

  private setLive(text: string): void {
    if (text === this.lastLive) return;
    this.lastLive = text;
    this.emit({ type: 'live', text });
  }

  private modeFields() {
    const c = this.watch.current();
    return c ? { mode: 'claude', cwd: c.cwd } : { mode: 'shell', cwd: this.shellCwd };
  }
  private modeMsg() { return { type: 'mode', ...this.modeFields() }; }

  private tick(): void {
    const now = Date.now();
    const claude = !!this.watch.current();
    const quietFor = now - this.shell.lastOutputAt;          // any output (for prompt stability)
    const busy = claude && now - this.lastWorkAt < BUSY_WINDOW; // output that wasn't your typing
    if (busy !== this.busy) { this.busy = busy; if (!busy) this.idleSince = now; this.emit({ type: 'activity', busy }); }
    // The dialog on screen, re-read once the screen has settled after new output.
    if (this.shell.lastOutputAt !== this.dialogAt && quietFor >= 250) {
      this.dialogAt = this.shell.lastOutputAt;
      this.setDialog(claude ? this.screen.dialog() : null);
    }
    if (!claude) { this.snapRows = 0; this.busyStart = 0; this.pendingIdle = false; this.setLive(''); return; }

    if (busy && !this.busyStart) this.busyStart = now;
    if (!busy && this.busyStart) {
      if (this.lastWorkAt - this.busyStart >= MIN_BUSY_FOR_ALERT) this.pendingIdle = true;
      setTimeout(() => this.relabel(), 3000); // a turn ended: the transcript has its last messages by then
      this.busyStart = 0;
    }
    if (this.shell.lastOutputAt !== this.snapAt && now - this.lastSnapCheck >= LIVE_EVERY) {
      this.snapAt = this.shell.lastOutputAt; this.lastSnapCheck = now;
      const rows = this.screen.bottomRows();
      if (rows && rows !== this.snapRows) { this.snapRows = rows; this.emit({ type: 'snap', rows }); }
    }
    if (busy && now - this.lastLiveAt >= LIVE_EVERY) { this.lastLiveAt = now; this.setLive(this.liveText()); }
    else if (!busy) this.setLive('');

    // Re-scan the screen for a prompt only when something new was printed.
    if (this.shell.lastOutputAt !== this.promptAt) { this.promptAt = this.shell.lastOutputAt; this.promptCache = undefined; }
    if (quietFor >= LUNATIC_QUIET && this.promptCache === undefined) this.promptCache = this.screen.prompt();
    const prompt = quietFor >= LUNATIC_QUIET ? this.promptCache ?? null : null;
    if (!prompt && quietFor >= LUNATIC_QUIET) this.lastSig = ''; // prompt gone: a new one may be answered
    // Answer each prompt once; the same prompt only again after it has disappeared.
    if (prompt && this.lunatic && now - this.lastInputAt >= LUNATIC_USER_IDLE && prompt.sig !== this.lastSig) {
      this.lastSig = prompt.sig;
      this.pendingIdle = false;
      this.shell.write('\r'); // Enter = the highlighted option 1
      this.emit({ type: 'auto-answer', label: prompt.label });
      return;
    }

    if (this.pendingIdle && quietFor >= BUSY_WINDOW) {
      this.pendingIdle = false;
      this.emit({ type: 'attention', reason: prompt ? 'input' : 'finished', label: prompt?.label ?? null });
    }
  }
}
