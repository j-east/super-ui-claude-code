// Watches the shell running in the pty: its current directory, and whether a
// `claude` process is running as its child (and in which directory).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface ClaudeProc { pid: number; cwd: string; startedAt: number; args: string }

export interface ProcWatchEvents {
  shellCwd(cwd: string): void;
  claudeStart(p: ClaudeProc): void;
  claudeStop(): void;
}

export async function cwdOf(pid: number): Promise<string | null> {
  try {
    const { stdout } = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    const line = stdout.split('\n').find((l) => l.startsWith('n'));
    return line ? line.slice(1) : null;
  } catch { return null; }
}

/** Is this command line Claude Code? `claude …`, or `node …/claude …` (npm install). Not `vim ~/claude`. */
function isClaude(args: string): boolean {
  const [a0 = '', a1 = ''] = args.trim().split(/\s+/);
  const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
  return base(a0) === 'claude' || (base(a0) === 'node' && base(a1) === 'claude');
}
const SAFETY_POLL = 10_000; // look anyway this often, in case a change printed nothing

// One `ps` shared by every tab that asks within the same moment (it lists every process on the Mac).
let psCache: { at: number; out: Promise<string> } | null = null;
function processList(fresh = false): Promise<string> {
  if (fresh || !psCache || Date.now() - psCache.at > 500) {
    psCache = { at: Date.now(), out: run('ps', ['-A', '-o', 'pid=,ppid=,args=']).then((r) => r.stdout) };
    psCache.out.catch(() => { psCache = null; });
  }
  return psCache.out;
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

  /** True when nothing runs in the shell's foreground (no child process), so typing a command is safe. */
  async shellIdle(): Promise<boolean> {
    try {
      const out = await processList(true);
      return !out.split('\n').some((l) => { const m = l.trim().match(/^\d+\s+(\d+)\s/); return m && Number(m[1]) === this.shellPid; });
    } catch { return false; }
  }

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
      const stdout = await processList();
      if (this.stopped) return;
      const child = stdout.split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
        .find((m) => m && Number(m[2]) === this.shellPid && isClaude(m[3] ?? ''));
      const pid = child ? Number(child[1]) : null;
      if (pid) {
        const cwd = await cwdOf(pid);
        if (this.stopped) return;
        if (cwd) { this.claude = { pid, cwd, startedAt: Date.now(), args: child?.[3] ?? '' }; this.ev.claudeStart(this.claude); }
        else this.checkedAt = 0; // just starting; retry next tick
      } else {
        const cwd = await cwdOf(this.shellPid);
        if (this.stopped) return;
        if (cwd && cwd !== this.lastCwd) { this.lastCwd = cwd; this.ev.shellCwd(cwd); }
      }
    } catch { this.checkedAt = 0; /* transient ps/lsof failure; try again next tick */ }
    finally { this.busy = false; }
  }
}
