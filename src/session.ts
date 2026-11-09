// Owns the user's login shell in a pty (claude runs inside it). Screen state for
// reconnecting clients lives in Screen (headless xterm), not here.
import * as pty from 'node-pty';

// Strip debugger/launcher injection (VS Code js-debug sets NODE_OPTIONS) so claude starts clean.
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k === 'NODE_OPTIONS' || k.startsWith('VSCODE_INSPECTOR') || k === 'ELECTRON_RUN_AS_NODE') continue;
    env[k] = v;
  }
  // Apps launched from Finder get no locale; without UTF-8 the shell mangles ❯, box lines and non-ASCII input.
  const lang: Record<string, string> = env.LANG || env.LC_ALL || env.LC_CTYPE ? {} : { LANG: 'en_US.UTF-8' };
  return { ...env, ...lang, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
}

export class PtySession {
  private proc: pty.IPty;
  private dataSubs = new Set<(d: string) => void>();
  private exitSubs = new Set<(code: number) => void>();
  lastOutputAt = 0;
  exitCode: number | null = null;

  constructor(file: string, args: string[], cwd: string) {
    this.proc = pty.spawn(file, args, {
      name: 'xterm-256color', cols: 120, rows: 30, cwd,
      env: childEnv(),
    });
    this.proc.onData((d) => {
      this.lastOutputAt = Date.now();
      this.dataSubs.forEach((f) => f(d));
    });
    this.proc.onExit(({ exitCode }) => { this.exitCode = exitCode; this.exitSubs.forEach((f) => f(exitCode)); });
  }

  get pid(): number { return this.proc.pid; }
  onData(f: (d: string) => void): () => void { this.dataSubs.add(f); return () => this.dataSubs.delete(f); }
  onExit(f: (code: number) => void): void { this.exitSubs.add(f); }
  write(d: string): void { this.proc.write(d); }
  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0 && (cols !== this.proc.cols || rows !== this.proc.rows)) this.proc.resize(cols, rows);
  }
  kill(): void { try { this.proc.kill(); } catch { /* already gone */ } }
}
