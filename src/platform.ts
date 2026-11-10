// Everything that differs between macOS and Windows, in one place: where our files live, which shell
// a tab runs, and how to phrase a command for it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const WIN = process.platform === 'win32';

/** Our own files (workspaces, label cache, labeler scratch folder). */
export const DATA_DIR = WIN
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'claude-pane')
  : path.join(os.homedir(), 'Library', 'Application Support', 'claude-pane');

/** First `name` found on PATH (Windows: an .exe). */
function onPath(name: string): string | null {
  for (const dir of (process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

// Windows has no cheap way to ask another process for its folder, so the shell tells us: its prompt
// puts the folder in the window title, which the pty passes along (see CWD_TITLE in procwatch).
// Wraps whatever prompt your profile set up. Single quotes only: it travels as a command-line argument.
const PS_INIT = '$global:__cpPrompt = $function:prompt; function global:prompt { ' +
  'try { $Host.UI.RawUI.WindowTitle = \'claude-pane|\' + (Get-Location).ProviderPath } catch {}; & $global:__cpPrompt }';

/** The shell a tab runs. macOS: your login shell. Windows: PowerShell 7 if installed, else Windows PowerShell. */
export function shellCommand(): { file: string; args: string[] } {
  if (!WIN) return { file: process.env.CLAUDE_PANE_SHELL || process.env.SHELL || '/bin/zsh', args: ['-l'] };
  const file = process.env.CLAUDE_PANE_SHELL || onPath('pwsh.exe') || 'powershell.exe';
  return { file, args: ['-NoLogo', '-NoExit', '-Command', PS_INIT] };
}

/** Quote one argument for the tab's shell. */
export function shq(s: string): string {
  if (WIN) return /^[\w@%+=:,.\\/-]+$/.test(s) && !/^-/.test(s) ? s : `'${s.replace(/'/g, "''")}'`;
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** "Go to this folder", optionally "and then run this" (only if the cd worked). */
export function cdCommand(dir: string, then?: string): string {
  if (WIN) return `cd ${shq(dir)}` + (then ? `; if ($?) { ${then} }` : '');
  return `cd ${shq(dir)}` + (then ? ` && ${then}` : '');
}

/** Keys that clear a half-typed line at the prompt: Ctrl+U in zsh/bash, Esc in PowerShell. */
export const CLEAR_LINE = WIN ? '\x1b' : '\x15';

/** Claude Code's own installer, typed into the tab's shell when you ask for it. */
export const INSTALL_CLAUDE = WIN ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash';

/** Places Claude Code is usually installed, most likely first. */
export function claudeCandidates(): string[] {
  const home = os.homedir();
  if (WIN) {
    return [path.join(home, '.local', 'bin', 'claude.exe'),
      path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm', 'claude.cmd')];
  }
  return [`${home}/.local/bin/claude`, `${home}/.claude/local/claude`, '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
}
