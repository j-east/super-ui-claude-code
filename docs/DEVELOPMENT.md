# Building and hacking on Claude Code Super UI

Everything a developer needs: building from source, how the pieces fit, and the test loop. For what the app
does and how to install it, see the [README](../README.md).

## Build from source on macOS

Requirements: macOS 13 or later, [Node.js](https://nodejs.org) 20+, Xcode command line tools
(`xcode-select --install`), and [Claude Code](https://claude.com/claude-code).

```sh
git clone https://github.com/j-east/super-ui-claude-code.git
cd super-ui-claude-code
npm install
npm run build:app
```

That builds `Claude Code Super UI.app`, installs it in `~/Applications` and registers it with Spotlight.
Open it like any other app.

To build a self-contained copy for another Mac (Node and everything else bundled, nothing to install):

```sh
npm run dist        # zip lands in dist.noindex/release/
```

Without a Developer ID the result is ad-hoc signed, so the other Mac will need right-click → Open the
first time. Set `SIGN_ID` (and `NOTARY_PROFILE`) to sign and notarize; see `scripts/build-app.sh`.

## Build the Windows version

To build it yourself, on Windows or macOS: `npm install && npm run dist:win`. The installer lands in
`dist.noindex/electron/`.

If the build stops on Windows with "Cannot create symbolic link: A required privilege is not held by the
client", turn on Developer Mode (Settings → System → For developers) or build from an administrator
shell, then run it again.

Each tab runs PowerShell (PowerShell 7 if you have it, otherwise the one that ships with Windows). Known
gaps: tab labels and the Registrar need the native `claude.exe` install (not the npm one), and WSL sessions
are not detected.

## How it works

```
┌──────────────────────────── Swift app (WKWebView windows, menus, notifications)
│
│   ┌──────────────────────── page: transcript, tabs, inbox, xterm.js
│   │        ▲ websocket (127.0.0.1, token + origin checked)
│   │        ▼
│   └── Node server ── one pty per tab ── your login shell ── claude
│            │
│            └── follows ~/.claude/projects/…/<session>.jsonl for the transcript
```

- **`electron/`** The Windows host (Electron). Same job as `native/`, and it runs on macOS too
  (`npm run electron`), which is how it gets tested without a PC.
- **`native/`** The macOS shell: windows, menus, notifications, quit warnings. It starts the server and
  stops it when the app quits.
- **`src/`** The server. `tab.ts` owns a shell in a pty and a headless copy of its screen. `procwatch.ts`
  notices when `claude` starts in it, `transcript.ts` follows that session's log, `screen.ts` reads
  dialogs off the screen, `labeler.ts` writes tab labels, `registrar.ts` keeps the per-project record
  and `recordtool.ts` serves it to sessions.
- **`public/`** The page, in plain JavaScript modules with no build step.

Development loop: `npm run build:app` once, then `⌘R` picks up changes to `public/`. Changes to `src/` or
`native/` need `npm run build:app` again and an app restart. `npm run dev` runs the server alone and opens
it in a browser window.

`npm run smoke` runs the server end to end against a stand-in for Claude Code: a shell starts, its folder is
tracked, commands are typed, a running `claude` is noticed. GitHub Actions runs it on Windows on every push
and builds the installer; pushing a tag like `v0.3.0` publishes a Release.

## How a session reads the Registrar's record

The Registrar watches sessions; a session can also look things up for itself. In the app's tabs, `claude`
is a shell function (zsh and PowerShell) that starts Claude Code with three extra flags:

- `--mcp-config <file>`: a read-only tool, `check_record`, served by the app on 127.0.0.1. The file lives
  in the app's data folder, one per tab, and is deleted when the tab closes.
- `--append-system-prompt`: a few sentences saying the tool exists and when it is worth calling.
- `--allowedTools mcp__registrar__check_record`: that one tool runs without a permission prompt.

`check_record` returns the decisions on record for the project and one line per other open session. It is
a plain read of the stored record, with no model call. Nothing is written into the project or `~/.claude`.

The flags are added only when a session starts. `claude update`, `claude mcp list`, `claude -p` and
`--help` pass through untouched, and so does everything if you already have your own `claude` alias or
function. In bash, fish or any other shell, `claude` is plain Claude Code without the tool.

## Environment switches

| | |
|---|---|
| `CLAUDE_PANE_NO_LABELS=1` | No tab labels and no Registrar (nothing is sent to `claude -p`) |
| `CLAUDE_PANE_NO_REGISTRAR=1` | No Registrar and no `check_record` tool; labels stay on |
| `CLAUDE_PANE_SHELL` | Shell to run in each tab instead of your login shell |
