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

// ---------- `claude` in a tab ----------
// You type `claude` as always. In our tabs it is a small shell function that adds a few flags when it
// starts a session: the tab's record-tool config, a note saying the tool exists, leave to call that
// one read-only tool without asking, and a hook that brings in the Registrar's heads-ups (see recordtool.ts).
// Everything else passes through untouched: subcommands (`claude update`), print mode, --help.
// If CLAUDE_PANE_MCP is not set (the tool is off) the function is plain `claude`.
// zsh and PowerShell only; in any other shell `claude` is just Claude Code, without the tool.
const SH_CLAUDE = `if ! alias claude >/dev/null 2>&1 && ! typeset -f claude >/dev/null 2>&1; then
function claude {
  if [[ -z "$CLAUDE_PANE_MCP" || ! -f "$CLAUDE_PANE_MCP" ]]; then command claude "$@"; return; fi
  local a
  for a in "$@"; do
    case "$a" in -p|--print|--mcp-config|--mcp-config=*|--strict-mcp-config|--settings|--settings=*|-h|--help|-v|--version) command claude "$@"; return;; esac
  done
  # A bare lowercase word first is a subcommand (claude mcp list, claude update).
  if [[ "$1" =~ ^[a-z][a-z-]*$ ]]; then command claude "$@"; return; fi
  # Order matters: the first two flags take a list, so each must be followed by another flag.
  local -a hook
  if [[ -n "$CLAUDE_PANE_SETTINGS" && -f "$CLAUDE_PANE_SETTINGS" ]]; then hook=(--settings "$CLAUDE_PANE_SETTINGS"); fi
  command claude --allowedTools "\${CLAUDE_PANE_ALLOW:-mcp__registrar__check_record}" --mcp-config "$CLAUDE_PANE_MCP" --append-system-prompt "$CLAUDE_PANE_NOTE" "\${hook[@]}" "$@"
}
fi
`;
// zsh reads its startup files from $ZDOTDIR. Ours each load yours from where they really are, and the
// last one adds the function and hands ZDOTDIR back, so your profile, history and prompt are unchanged.
const ZSH_FILES: Record<string, string> = {
  '.zshenv': `CP_OURS="$ZDOTDIR"
ZDOTDIR="\${CLAUDE_PANE_ZDOTDIR:-$HOME}"
[[ "$ZDOTDIR" != "$CP_OURS" && -f "$ZDOTDIR/.zshenv" ]] && . "$ZDOTDIR/.zshenv"
CLAUDE_PANE_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$CP_OURS"
`,
  '.zprofile': `ZDOTDIR="$CLAUDE_PANE_ZDOTDIR"
[[ -f "$ZDOTDIR/.zprofile" ]] && . "$ZDOTDIR/.zprofile"
CLAUDE_PANE_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$CP_OURS"
`,
  '.zshrc': `ZDOTDIR="$CLAUDE_PANE_ZDOTDIR"
[[ "$HISTFILE" == "$CP_OURS"/* ]] && HISTFILE="$ZDOTDIR/.zsh_history"
[[ -f "$ZDOTDIR/.zshrc" ]] && . "$ZDOTDIR/.zshrc"
${SH_CLAUDE}unset CP_OURS CLAUDE_PANE_ZDOTDIR
[[ "$ZDOTDIR" == "$HOME" ]] && unset ZDOTDIR
true
`,
};
function zshEnv(): Record<string, string> {
  const dir = path.join(DATA_DIR, 'shell', 'zsh');
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(ZSH_FILES)) {
      const f = path.join(dir, name);
      let have = ''; try { have = fs.readFileSync(f, 'utf8'); } catch { /* new */ }
      if (have !== text) fs.writeFileSync(f, text);
    }
  } catch { return {}; }
  return { ZDOTDIR: dir, CLAUDE_PANE_ZDOTDIR: process.env.ZDOTDIR || '' };
}
// Single quotes only, like PS_INIT. Runs the real claude (an .exe or .cmd on PATH), never itself.
const PS_CLAUDE = '; if ($env:CLAUDE_PANE_MCP) { function global:claude { ' +
  '$c = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; ' +
  'if (-not $c) { Write-Error \'claude is not installed or not on PATH\'; return }; ' +
  '$plain = (-not (Test-Path -LiteralPath $env:CLAUDE_PANE_MCP)) -or ' +
  '(@($args | Where-Object { $_ -is [string] -and (@(\'-p\',\'--print\',\'--mcp-config\',\'--strict-mcp-config\',\'--settings\',\'-h\',\'--help\',\'-v\',\'--version\') -contains $_) }).Count -gt 0) -or ' +
  '($args.Count -gt 0 -and $args[0] -cmatch \'^[a-z][a-z-]*$\'); ' +
  '$hook = @(); if ($env:CLAUDE_PANE_SETTINGS -and (Test-Path -LiteralPath $env:CLAUDE_PANE_SETTINGS)) { $hook = @(\'--settings\', $env:CLAUDE_PANE_SETTINGS) }; ' +
  '$allow = if ($env:CLAUDE_PANE_ALLOW) { $env:CLAUDE_PANE_ALLOW } else { \'mcp__registrar__check_record\' }; ' +
  'if ($plain) { & $c.Source @args } else { & $c.Source --allowedTools $allow --mcp-config $env:CLAUDE_PANE_MCP --append-system-prompt $env:CLAUDE_PANE_NOTE @hook @args } } }';

/** The shell a tab runs. macOS: your login shell. Windows: PowerShell 7 if installed, else Windows PowerShell. */
export function shellCommand(): { file: string; args: string[]; env: Record<string, string> } {
  if (!WIN) {
    const file = process.env.CLAUDE_PANE_SHELL || process.env.SHELL || '/bin/zsh';
    return { file, args: ['-l'], env: path.basename(file) === 'zsh' ? zshEnv() : {} };
  }
  const file = process.env.CLAUDE_PANE_SHELL || onPath('pwsh.exe') || 'powershell.exe';
  return { file, args: ['-NoLogo', '-NoExit', '-Command', PS_INIT + PS_CLAUDE], env: {} };
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
