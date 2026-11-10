// Watches the shell running in the pty: its current directory, and whether a
// `claude` process is running as its child (and in which directory).
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WIN } from './platform.js';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface ClaudeProc { pid: number; cwd: string; startedAt: number; args: string }

export interface ProcWatchEvents {
  shellCwd(cwd: string): void;
  claudeStart(p: ClaudeProc): void;
  claudeStop(): void;
}

interface Proc { pid: number; ppid: number; name: string; args: string }

// ---------- macOS ----------
async function lsofCwd(pid: number): Promise<string | null> {
  try {
    const { stdout } = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    const line = stdout.split('\n').find((l) => l.startsWith('n'));
    return line ? line.slice(1) : null;
  } catch { return null; }
}

async function psList(): Promise<Proc[]> {
  const { stdout } = await run('ps', ['-A', '-o', 'pid=,ppid=,args=']);
  return stdout.split('\n').flatMap((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), name: '', args: m[3] ?? '' }] : [];
  });
}

// ---------- Windows ----------
// One PowerShell stays running and lists processes on request: starting a new one per look costs
// most of a second.
const WIN_LIST = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
  "while ($null -ne [Console]::In.ReadLine()) { " +
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine | ForEach-Object { " +
  "$c = if ($_.CommandLine) { $_.CommandLine -replace '\\s+', ' ' } else { '' }; " +
  "[Console]::Out.WriteLine(\"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)`t$c\") }; " +
  "[Console]::Out.WriteLine('@@END'); [Console]::Out.Flush() }";
let helper: ChildProcess | null = null;
let helperBuf = '';
let lastRaw = ''; // head of the helper's last answer, for the debug report
let helperWaiters: { res: (p: Proc[]) => void; rej: (e: Error) => void }[] = [];
function winList(): Promise<Proc[]> {
  if (!helper) {
    const h = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', WIN_LIST],
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    helper = h;
    h.stdout!.setEncoding('utf8');
    h.stdout!.on('data', (d: string) => {
      helperBuf += d;
      for (let end = helperBuf.indexOf('@@END'); end >= 0; end = helperBuf.indexOf('@@END')) {
        const block = helperBuf.slice(0, end);
        lastRaw = block.slice(0, 600);
        helperBuf = helperBuf.slice(end + 5);
        const procs = block.split(/\r?\n/).flatMap((l) => {
          const [pid, ppid, name, args] = l.split('\t');
          return pid && /^\d+$/.test(pid) ? [{ pid: Number(pid), ppid: Number(ppid), name: (name ?? '').toLowerCase(), args: args ?? '' }] : [];
        });
        helperWaiters.shift()?.res(procs);
      }
    });
    const gone = () => {
      if (helper === h) helper = null;
      helperBuf = '';
      for (const w of helperWaiters.splice(0)) w.rej(new Error('process list helper stopped'));
    };
    h.on('error', gone); h.on('exit', gone);
    h.unref(); (h.stdout as unknown as { unref?: () => void }).unref?.(); (h.stdin as unknown as { unref?: () => void }).unref?.();
  }
  return new Promise<Proc[]>((res, rej) => {
    const w = { res, rej };
    helperWaiters.push(w);
    // A helper that never answers must not freeze tab detection.
    setTimeout(() => { const i = helperWaiters.indexOf(w); if (i >= 0) { helperWaiters.splice(i, 1); rej(new Error('process list timed out')); helper?.kill(); } }, 8000).unref();
    try { helper!.stdin!.write('\n'); } catch (e) { rej(e as Error); }
  });
}
/** Stop the Windows helper (on shutdown). */
export function stopProcHelper(): void { try { helper?.kill(); } catch { /* gone */ } helper = null; }

/** The shell's folder, as its prompt reports it in the window title (see PS_INIT in platform.ts). */
const CWD_TITLE = /\x1b\][02];claude-pane\|([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

/** Is this process Claude Code? `claude …`, or `node …/claude …` (npm install). Not `vim ~/claude`. */
function isClaude(p: Proc): boolean {
  if (WIN) {
    return p.name === 'claude.exe' || (p.name === 'node.exe' && /claude-code[\\/]|[\\/]claude(\.js)?(["\s]|$)/i.test(p.args));
  }
  const [a0 = '', a1 = ''] = p.args.trim().split(/\s+/);
  const base = (x: string) => x.slice(x.lastIndexOf('/') + 1);
  return base(a0) === 'claude' || (base(a0) === 'node' && base(a1) === 'claude');
}
const SAFETY_POLL = 10_000; // look anyway this often, in case a change printed nothing

// One listing shared by every tab that asks within the same moment (it lists every process on the machine).
let listCache: { at: number; out: Promise<Proc[]> } | null = null;
function processList(fresh = false): Promise<Proc[]> {
  if (fresh || !listCache || Date.now() - listCache.at > 500) {
    listCache = { at: Date.now(), out: WIN ? winList() : psList() };
    listCache.out.catch(() => { listCache = null; });
  }
  return listCache.out;
}

/** Folder Claude Code says a running claude is in (its own ~/.claude/sessions/<pid>.json). */
function sessionCwd(pid: number): string | null {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'sessions', `${pid}.json`), 'utf8'));
    return typeof d.cwd === 'string' ? d.cwd : null;
  } catch { return null; }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * Cheap by design: while claude runs, only a liveness check (no subprocess). Otherwise `ps`/`lsof`
 * run only after the terminal printed something (claude starting, a `cd`, a command finishing all
 * print), plus a slow safety poll.
 */
export class ProcWatch {
  private timer: NodeJS.Timeout | undefined;
  private claude: ClaudeProc | null = null;
  private lastCwd = '';
  private busy = false;
  private checkedAt = 0;
  private stopped = false;

  /** `lastOutputAt`: when the pty last printed anything. */
  constructor(private shellPid: number, private ev: ProcWatchEvents, private lastOutputAt: () => number) {}

  start(): void { this.timer = setInterval(() => void this.tick(), 700); void this.tick(); }
  stop(): void { this.stopped = true; clearInterval(this.timer); }
  current(): ClaudeProc | null { return this.claude; }
  cwd(): string { return this.lastCwd; }

  /** Terminal output passes through here: on Windows the shell's prompt reports its folder in the title. */
  feed(data: string): void {
    if (!WIN || !data.includes('claude-pane|')) return;
    let cwd: string | null = null;
    for (const m of data.matchAll(CWD_TITLE)) cwd = m[1] ?? null;
    if (cwd && cwd !== this.lastCwd && !this.claude) { this.lastCwd = cwd; this.ev.shellCwd(cwd); }
    else if (cwd) this.lastCwd = cwd;
  }

  /** Processes started from the shell. macOS: its direct children. Windows: everything below it (claude.cmd runs node through cmd). */
  private below(list: Proc[]): Proc[] {
    const kids = (pid: number) => list.filter((p) => p.ppid === pid && p.pid !== pid);
    if (!WIN) return kids(this.shellPid);
    const out: Proc[] = [];
    const seen = new Set<number>([this.shellPid]);
    for (let layer = kids(this.shellPid); layer.length && out.length < 500; ) {
      const next: Proc[] = [];
      for (const p of layer) { if (seen.has(p.pid)) continue; seen.add(p.pid); out.push(p); next.push(...kids(p.pid)); }
      layer = next;
    }
    return out.filter((p) => p.name !== 'conhost.exe');
  }

  /** What this watcher currently sees (for /api/debug and the smoke test's failure report). */
  async debug(): Promise<Record<string, unknown>> {
    let list: Proc[] = []; let error: string | null = null;
    try { list = await processList(true); } catch (e) { error = String(e); }
    return { shellPid: this.shellPid, shell: list.find((p) => p.pid === this.shellPid) ?? null, cwd: this.lastCwd, claude: this.claude,
      total: list.length, below: this.below(list), claudeLike: list.filter(isClaude), error, raw: WIN ? lastRaw : undefined };
  }

  /** True when nothing runs in the shell's foreground (no child process), so typing a command is safe. */
  async shellIdle(): Promise<boolean> {
    try { return !this.below(await processList(true)).length; } catch { return false; }
  }

  private tries = 0;
  private async tick(): Promise<void> {
    if (this.busy || this.stopped) return;
    if (this.claude) {
      if (alive(this.claude.pid)) return;
      this.claude = null;
      this.ev.claudeStop();
      this.checkedAt = 0; // look for the shell's cwd / a new claude right away
    }
    const now = Date.now();
    if (this.checkedAt && this.lastOutputAt() <= this.checkedAt && now - this.checkedAt < SAFETY_POLL) return;
    this.checkedAt = now;
    this.busy = true;
    try {
      const found = this.below(await processList()).filter(isClaude);
      if (this.stopped) return;
      if (found.length) {
        // Windows can show more than one (a launcher and the real one): the one Claude Code itself
        // recorded is the session's; give it a few looks to appear before settling for the first.
        const child = found.find((p) => sessionCwd(p.pid)) ?? (found.length === 1 || ++this.tries > 6 ? found[0]! : null);
        const cwd = !child ? null : WIN ? sessionCwd(child.pid) ?? this.lastCwd : await lsofCwd(child.pid);
        if (this.stopped) return;
        if (child && cwd) { this.tries = 0; this.claude = { pid: child.pid, cwd, startedAt: Date.now(), args: child.args }; this.ev.claudeStart(this.claude); }
        else this.checkedAt = 0; // just starting; retry next tick
      } else if (!WIN) {
        this.tries = 0;
        const cwd = await lsofCwd(this.shellPid);
        if (this.stopped) return;
        if (cwd && cwd !== this.lastCwd) { this.lastCwd = cwd; this.ev.shellCwd(cwd); }
      } else this.tries = 0;
    } catch { this.checkedAt = 0; /* transient listing failure; try again next tick */ }
    finally { this.busy = false; }
  }
}
