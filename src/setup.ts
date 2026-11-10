// What the welcome screen needs to know: is Claude Code installed, and which folders you used it in lately.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WIN, INSTALL_CLAUDE, claudeCandidates } from './platform.js';

export interface WelcomeInfo {
  /** The command the Install button types. */
  install: string;
  claude: { path: string; version: string } | null;
  recents: { cwd: string; at: number }[];
}


// ---------- finding claude ----------
let claudeBin: Promise<string | null> | null = null;
/** Path of the `claude` binary, or null. Cached; `fresh` looks again (after an install). */
export function findClaude(fresh = false): Promise<string | null> {
  if (fresh) claudeBin = null;
  claudeBin ??= (async () => {
    for (const p of claudeCandidates()) {
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
    }
    if (WIN) {
      return new Promise<string | null>((res) => {
        execFile('where.exe', ['claude'], { timeout: 10_000, windowsHide: true }, (_e, out) => {
          const lines = String(out ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
          res(lines.find((l) => /\.exe$/i.test(l)) ?? lines.find((l) => /\.cmd$/i.test(l)) ?? null);
        });
      });
    }
    // Wherever your shell finds it (nvm, volta, …).
    return new Promise<string | null>((res) => {
      execFile(process.env.SHELL || '/bin/zsh', ['-lic', 'command -v claude'], { timeout: 10_000 }, (_e, out) => {
        const line = String(out ?? '').split('\n').map((l) => l.trim()).reverse().find((l) => l.startsWith('/'));
        res(line ?? null);
      });
    });
  })();
  return claudeBin;
}

function version(bin: string): Promise<string> {
  return new Promise((res) => {
    const done = (_e: unknown, out: unknown) => res(String(out ?? '').trim().split('\n')[0]?.trim().slice(0, 60) ?? '');
    // An npm install on Windows is a .cmd wrapper, which only runs through the command interpreter.
    if (/\.cmd$/i.test(bin)) execFile(`"${bin}" --version`, { timeout: 8000, shell: true, windowsHide: true }, done);
    else execFile(bin, ['--version'], { timeout: 8000, windowsHide: true }, done);
  });
}

// ---------- recent folders ----------
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const SCRATCH = /^(\/private)?\/(tmp|var\/folders)\//;

/** The folder a session ran in, from the head of its log (the directory name itself is a lossy encoding). */
async function cwdOf(file: string): Promise<string | null> {
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const m = buf.toString('utf8', 0, bytesRead).match(/"cwd":("(?:[^"\\]|\\.)*")/);
    return m ? String(JSON.parse(m[1]!)) : null;
  } catch { return null; } finally { await fh?.close().catch(() => {}); }
}

/** Folders of your most recent Claude Code sessions, newest first. */
export async function recentFolders(limit = 6): Promise<WelcomeInfo['recents']> {
  const stat = (p: string) => fs.promises.stat(p).catch(() => null);
  let dirs: string[];
  try { dirs = await fs.promises.readdir(PROJECTS); } catch { return []; }
  const ranked = (await Promise.all(dirs.map(async (d) => ({ d, at: (await stat(path.join(PROJECTS, d)))?.mtimeMs ?? 0 }))))
    .sort((a, b) => b.at - a.at).slice(0, limit * 3);
  const found = await Promise.all(ranked.map(async ({ d }) => {
    const dir = path.join(PROJECTS, d);
    const files = (await fs.promises.readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.jsonl'));
    const stats = await Promise.all(files.map(async (f) => ({ f, at: (await stat(path.join(dir, f)))?.mtimeMs ?? 0 })));
    const newest = stats.sort((a, b) => b.at - a.at)[0];
    if (!newest) return null;
    const cwd = await cwdOf(path.join(dir, newest.f));
    if (!cwd || SCRATCH.test(cwd) || !(await stat(cwd))?.isDirectory()) return null;
    return { cwd, at: newest.at };
  }));
  const seen = new Set<string>();
  return found.filter((r): r is { cwd: string; at: number } => !!r && !seen.has(r.cwd) && !!seen.add(r.cwd))
    .sort((a, b) => b.at - a.at).slice(0, limit);
}

export async function welcomeInfo(fresh = false): Promise<WelcomeInfo> {
  const [bin, recents] = await Promise.all([findClaude(fresh), recentFolders()]);
  return { install: INSTALL_CLAUDE, claude: bin ? { path: bin, version: await version(bin) } : null, recents };
}
