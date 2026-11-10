// Short tab labels: a few words plus one sentence about what a Claude session is doing, written by a
// headless `claude -p` run on Sonnet (no tools, no MCP, no saved session) from an excerpt of the
// transcript. Labels are cached per session id, so reopening a tab doesn't run it again.
// Set CLAUDE_PANE_NO_LABELS=1 to turn this off.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './platform.js';
import { findClaude } from './setup.js';
import type { Entry } from './transcript.js';

export interface Label { label: string; summary: string }
interface Cached extends Label { users: number; at: number }

const DIR = DATA_DIR;
const FILE = path.join(DIR, 'labels.json');
const WORK = path.join(DIR, 'labeler'); // cwd for the headless run, away from your projects
const TIMEOUT = 60_000;
const MAX_CACHE = 500;
const SYSTEM = 'You label tabs in an app that shows several Claude Code sessions side by side. ' +
  'From the session excerpt, say what the session is working on now. Reply with only JSON: ' +
  '{"label": "<3 to 5 words, Title-less plain words, no trailing period>", "summary": "<one plain sentence, under 25 words>"}';

let cache: Record<string, Cached> = {};
try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* first run */ }
const save = () => {
  const keys = Object.keys(cache);
  if (keys.length > MAX_CACHE) {
    for (const k of keys.sort((a, b) => cache[a]!.at - cache[b]!.at).slice(0, keys.length - MAX_CACHE)) delete cache[k];
  }
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(cache), { mode: 0o600 }); } catch { /* ignore */ }
};

export function cachedLabel(sessionId: string | null): Label | null {
  const c = sessionId ? cache[sessionId] : undefined;
  return c ? { label: c.label, summary: c.summary } : null;
}

// ---------- excerpt ----------
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
function excerpt(entries: Entry[], cwd: string): string {
  const users = entries.filter((e) => e.kind === 'user') as { text: string }[];
  const title = [...entries].reverse().find((e) => e.kind === 'title') as { text: string } | undefined;
  const recap = [...entries].reverse().find((e) => e.kind === 'recap') as { text: string } | undefined;
  const lastAsst = [...entries].reverse().find((e) => e.kind === 'assistant') as { text: string } | undefined;
  const parts = [`Folder: ${cwd}`];
  if (title) parts.push(`Session title: ${title.text}`);
  if (users[0]) parts.push(`First request: ${clip(users[0].text, 500)}`);
  const recent = users.slice(1).slice(-6);
  if (recent.length) parts.push('Recent requests:\n' + recent.map((u) => `- ${clip(u.text.replace(/\s+/g, ' '), 300)}`).join('\n'));
  if (recap) parts.push(`Latest recap: ${clip(recap.text, 500)}`);
  if (lastAsst) parts.push(`Latest reply: ${clip(lastAsst.text, 800)}`);
  return parts.join('\n\n');
}

// ---------- running ----------
let chain: Promise<unknown> = Promise.resolve(); // one run at a time across all tabs
const inFlight = new Set<string>();

function run(input: string): Promise<Label | null> {
  return findClaude().then((bin) => new Promise<Label | null>((res) => {
    // An npm install on Windows is a .cmd wrapper; our arguments wouldn't survive the command interpreter.
    if (!bin || /\.cmd$/i.test(bin)) return res(null);
    try { fs.mkdirSync(WORK, { recursive: true }); } catch { /* ignore */ }
    const p = spawn(bin, ['-p', '--model', 'sonnet', '--tools', '', '--no-session-persistence', '--strict-mcp-config',
      '--setting-sources', '', '--output-format', 'json', '--system-prompt', SYSTEM], { cwd: WORK, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    const kill = setTimeout(() => p.kill('SIGKILL'), TIMEOUT);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => { clearTimeout(kill); res(null); });
    p.on('close', () => {
      clearTimeout(kill);
      try {
        const d = JSON.parse(out);
        if (d.is_error || typeof d.result !== 'string') return res(null);
        const j = JSON.parse(d.result.slice(d.result.indexOf('{'), d.result.lastIndexOf('}') + 1));
        const label = String(j.label ?? '').trim().replace(/\.$/, '').slice(0, 48);
        const summary = String(j.summary ?? '').trim().slice(0, 240);
        res(label ? { label, summary } : null);
      } catch { res(null); }
    });
    p.stdin.end(input);
  }));
}

/** One label for these entries, without caching (also used by the test script). */
export function generateLabel(entries: Entry[], cwd: string): Promise<Label | null> { return run(excerpt(entries, cwd)); }

/**
 * Label the session if it has none yet or has moved on since (a few new requests, or any new request
 * after a while). Calls `done` only when a new label arrives.
 */
export function maybeLabel(sessionId: string | null, cwd: string, entries: Entry[], done: (l: Label) => void): void {
  if (!sessionId || process.env.CLAUDE_PANE_NO_LABELS || inFlight.has(sessionId)) return;
  const users = entries.filter((e) => e.kind === 'user').length;
  if (!users) return;
  const c = cache[sessionId];
  if (c && !(users >= c.users + 3 || (users > c.users && Date.now() - c.at > 15 * 60_000))) return;
  inFlight.add(sessionId);
  const text = excerpt(entries, cwd);
  chain = chain.then(() => run(text)).then((l) => {
    inFlight.delete(sessionId);
    if (!l) return;
    cache[sessionId] = { ...l, users, at: Date.now() };
    save();
    done(l);
  }).catch(() => inFlight.delete(sessionId));
}
