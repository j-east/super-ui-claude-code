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

## How a heads-up reaches a session

The Registrar's pass can also return `notices`: something one session learned that another should know.
Each becomes a note in the project record, addressed to one session and marked waiting.

Delivery uses a Claude Code hook, not typing. Each tab gets a small settings file in the data folder
(`mcp/<tab>.settings.json`) holding one `UserPromptSubmit` hook, and the `claude` function passes it with
`--settings`. When you send a message, the hook runs `curl` against `/notes/<tab>` on our port with the
record tool's token; whatever comes back, Claude Code attaches to your message as context.

- At most two notes go out per message, newest first; taking them marks them told, so each goes once.
- A note not delivered within a day is dropped.
- The text starts with "Registrar heads-up", which is how `transcript.ts` finds it in the session log
  and shows "The Registrar told this session: ...".
- If you pass your own `--settings`, the function steps aside and the session gets no tool and no hook.

## Lanes: sessions under one tab

A tab has a `group` (its own id by default). Tabs that share a group are one row in the list on the
left, and the strip across the top lists them. A lane is a tab opened into another tab's group.

Sessions open lanes with a second tool on the record tool's endpoint, `open_lane {lane, charter, prompt}`:

- The server opens a tab in the asking tab's group and folder and types `claude`.
- The charter reaches the lane in its launch note (`CLAUDE_PANE_NOTE`), next to the note about the tools.
- When Claude is up and showing no dialog, the prompt is typed into its input box. It is never sent.
- Asking for a lane that is already open under that tab types the prompt into the existing one.
- Unlike `check_record`, `open_lane` is not pre-approved: Claude Code asks you the first time.

Workspaces save each tab's `id`, `group`, `lane` and `charter`, so a reopened workspace puts lanes back
under their tab and gives each its charter again. Dragging a row to another window moves its lanes too.

## Closed tabs and Clean up

`src/later.ts` keeps `later.json` in the data folder: one entry per Claude tab you closed (session id,
folder, label, what was left, the workspace it was closed in). Each window is sent the entries for its
workspace. On close, one queued headless Sonnet call writes the entry's digest (`outcome`, up to three
`loose` ends). An entry whose digest finds no loose ends is removed at once, so the tray ("Unfinished" on the page) holds only sessions that left something open or are still being read. `later-wrap` (`wrapUp`) appends every loose end as a checkbox line to `todo/loose-ends.md` in the folder most of those sessions ran in, empties the tray, and sends the Steward a request to consolidate that file. `later-schedule` writes the same file, then drafts a request into the Steward to put time on the calendar; the app has no calendar code of its own, the Steward session uses whatever calendar tool Claude Code has. How you like time scheduled is free text in `prefs.json` (`src/prefs.ts`). Dismissing removes the entry; Reopen opens a tab with `claude --resume`. An entry
also drops off by itself when its session is open again by any route. Session logs are never touched.

Clean up (`cleanup-review`) sends one headless Sonnet call with an excerpt of every open Claude tab in
the window and gets back done / nearly / active plus one sentence on what is left. A row comes ticked
only when the answer is done or nearly and the tab is neither working nor waiting on a prompt. If the
call fails, or `CLAUDE_PANE_NO_LABELS` is set, the rows come back unticked. `cleanup-apply` closes the
ticked tabs and stores each one's sentence with its entry.

## Find a session

`src/findsession.ts`. The start screen's search box sends `find-session`; the server starts one
headless `claude -p --model sonnet` with only Grep, Glob and Read, in the folder holding the logs of
the workspace's project folders (all of `~/.claude/projects` for a window that is not a workspace).
It is given the candidate list (id, date, title) and replies with up to five ids; ids not on the list
are dropped. The same folders scope the "Resume a session" list (`workspaceFolders` in `server.ts`).

## The Steward

`src/steward.ts`. A Steward runs in its own folder (`steward/<workspace>` in the data folder, `stewardDir`), so its logs stay out of the project's; the workspace's folders are passed with `--add-dir`. On the page the Steward is a panel on the right (`#steward-dock` in `app.js`, a `Pane` of its own outside the `panes` list), not a row in the tab list. Underneath, a tab with `role: 'steward'` is an ordinary Claude Code session started with a
different launch note (`STEWARD_NOTE`, in place of the usual one) and offered five more tools on the
tab's MCP address: `list_sessions`, `read_session`, `open_session`, `close_sessions`,
`reopen_session`. The server implements them in `stewardTool` (`server.ts`) and answers them only for
a Steward tab. Handles are `T<tab id>` for open tabs and `C<id>` for the Closed list.

The shell function passes `--allowedTools "$CLAUDE_PANE_ALLOW"`, which for the Steward names every
tool except `close_sessions`, so closing tabs goes through Claude Code's own permission prompt.
`open_session` types its brief without sending it. The Steward keeps Claude Code's normal tools (it
writes lists and edits instruction files); that it hands real work to other sessions is its brief,
not a tool restriction. One Steward per window, saved with the workspace; it is left out of the
Registrar, Clean up and the Closed list.

## Session tools

`queueRestart` in `server.ts` waits until the tab's Claude has been idle for three seconds, sends it
SIGTERM (Claude Code exits cleanly and the shell prompt returns), then types `claude --resume <id>`
(reload) or `claude` (fresh) and, if given, sends a first message. The Session menu's Reload calls it
directly; sessions reach it through the `restart_session` tool on the tab's MCP address, which is not
pre-approved, so Claude Code asks before a session restarts itself. Hand off types a prompt asking
for a handoff document followed by a `restart_session` call with mode `fresh`. Split opens a sub-tab
in the same group running `claude --resume <id> --fork-session`.

## Environment switches

| | |
|---|---|
| `CLAUDE_PANE_NO_LABELS=1` | No tab labels and no Registrar (nothing is sent to `claude -p`) |
| `CLAUDE_PANE_NO_REGISTRAR=1` | No Registrar and no `check_record` tool; labels stay on |
| `CLAUDE_PANE_SHELL` | Shell to run in each tab instead of your login shell |
