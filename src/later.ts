// Closed tabs, kept as a list you can tick off, and "Clean up", which reads the open sessions and
// suggests which ones are finished enough to close.
//
// Closing a tab means "this is no longer in progress". It is digested in the background: one sentence
// on what came of it, and any loose ends. A session that left nothing open then simply goes away. One
// that left loose ends stays in the tray until you reopen it, dismiss it, or wrap the whole tray up
// into a to-do list in the project (`wrapUp`). The log is never touched. The list is per workspace and
// lives in later.json beside the workspaces.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './platform.js';
import { ask } from './labeler.js';
import type { Entry } from './transcript.js';
import type { WorkspaceTab } from './workspaces.js';

export interface LaterItem {
  id: string; sessionId: string; cwd: string; label: string; summary: string;
  /** What was still open when it was closed, in a sentence. Empty when nothing was, or nobody looked. */
  left: string; closedAt: number;
  /** The digest: what came of the session, and what it left open. `digested` false while it is being written. */
  outcome?: string; loose?: string[]; digested?: boolean;
  /** The workspace it was closed in ('' for a window without one). */
  workspace: string;
  lane?: string; charter?: string;
}

const FILE = path.join(DATA_DIR, 'later.json');
const MAX = 200;
let items: LaterItem[] = [];
/** What stays in the tray: a session still being digested, or one that left something open. */
const unfinished = (i: LaterItem) => i.digested === false || (i.loose ? i.loose.length > 0 : !!i.left);
try {
  const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (Array.isArray(d.items)) items = d.items;
  for (const i of items) if (i.digested === false) i.digested = true; // a digest cut short by quitting never lands
  items = items.filter(unfinished);
} catch { /* first run */ }
const save = () => {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify({ items }, null, 2), { mode: 0o600 }); } catch { /* ignore */ }
};

/** Newest first. */
export const laterFor = (workspace: string) => items.filter((i) => i.workspace === workspace).sort((a, b) => b.closedAt - a.closedAt);

/** A closed tab joins the list (replacing an older entry for the same session). Plain shells are not kept. Returns the new entry's id. */
export function addLater(rec: WorkspaceTab, workspace: string, left = ''): string | null {
  if (!rec.sessionId) return null;
  items = items.filter((i) => i.sessionId !== rec.sessionId);
  const id = Math.random().toString(36).slice(2, 10);
  items.push({ id, sessionId: rec.sessionId, cwd: rec.cwd,
    label: (rec.label?.label || rec.title || path.basename(rec.cwd)).slice(0, 80), summary: (rec.label?.summary ?? '').slice(0, 400),
    left: left.slice(0, 300), closedAt: Date.now(), workspace,
    ...(rec.lane ? { lane: rec.lane, charter: rec.charter } : {}) });
  if (items.length > MAX) items = items.sort((a, b) => a.closedAt - b.closedAt).slice(-MAX);
  save();
  return id;
}

/** Remove one (ticked off, or being reopened). Returns it. */
export function takeLater(id: string): LaterItem | null {
  const hit = items.find((i) => i.id === id) ?? null;
  if (hit) { items = items.filter((i) => i !== hit); save(); }
  return hit;
}

/** Sessions that are open again are no longer "closed". True if anything changed. */
export function pruneOpen(open: Set<string>): boolean {
  const n = items.length;
  items = items.filter((i) => !open.has(i.sessionId));
  if (items.length !== n) save();
  return items.length !== n;
}

/** A workspace was renamed: its list goes with it. */
export function renameLater(from: string, to: string): void {
  let hit = false;
  for (const i of items) if (i.workspace === from) { i.workspace = to; hit = true; }
  if (hit) save();
}

// ---------- digest ----------
const DIGEST = 'A person has just closed a Claude Code session; for them it is no longer work in progress. Write its digest from the excerpt. ' +
  '"outcome": one plain sentence, under 30 words, on what came of the session: what was decided, made or found. ' +
  '"loose": up to 3 loose ends the person would otherwise forget, each one short sentence that makes sense weeks later without the session ' +
  '(something to send, check, commit, decide, or wait for). Only real ones; an empty list is a good answer. ' +
  'Reply with only JSON: {"outcome":"...","loose":["..."]}';

/** Write the digest for a just-closed entry from what its session held. `changed` is called when it lands. */
export function digestLater(id: string, t: CleanupInput, changed: () => void): void {
  const it = items.find((i) => i.id === id);
  if (!it) return;
  const settle = () => { items = items.filter((i) => i.id !== id || unfinished(i)); save(); changed(); };
  if (process.env.CLAUDE_PANE_NO_LABELS) { it.digested = true; settle(); return; }
  it.digested = false; save();
  void ask(DIGEST, excerpt({ ...t, state: 'idle' }, 1), 90_000).then((out) => {
    const now = items.find((i) => i.id === id);
    if (!now) return; // dismissed or reopened meanwhile
    now.digested = true;
    try {
      const j = JSON.parse(out!.slice(out!.indexOf('{'), out!.lastIndexOf('}') + 1));
      now.outcome = clip(String(j.outcome ?? ''), 300);
      now.loose = (Array.isArray(j.loose) ? j.loose : []).map((x: unknown) => clip(String(x), 200)).filter(Boolean).slice(0, 3);
    } catch { /* no digest: it stays only if Clean up said something was left open */ }
    settle();
  });
}

// ---------- wrap up ----------
/**
 * Empty a workspace's tray into a list in the project (the server then opens one session to work through it): every loose end becomes a checkbox line in
 * todo/loose-ends.md, in the folder most of those sessions ran in. Sessions still being digested stay.
 * Returns the file and how many lines were added, or null if there was nothing to move or it could not be written.
 */
export function wrapUp(workspace: string): { file: string; folder: string; added: number; sessions: number } | null {
  const mine = laterFor(workspace).filter((i) => i.digested !== false);
  if (!mine.length) return null;
  const count = new Map<string, number>();
  for (const i of mine) count.set(i.cwd, (count.get(i.cwd) ?? 0) + 1);
  const folder = [...count].sort((a, b) => b[1] - a[1])[0]![0];
  const file = path.join(folder, 'todo', 'loose-ends.md');
  const lines: string[] = [];
  for (const i of [...mine].reverse()) for (const l of i.loose?.length ? i.loose : i.left ? [i.left] : []) lines.push(`- [ ] ${l.replace(/\s+/g, ' ')} (from "${i.label}")`);
  try {
    if (lines.length) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const head = fs.existsSync(file) ? '' : '# Loose ends\n\nThings left open by Claude Code sessions that were closed. A session opened from the Unfinished tray works through them and ticks them off.\n';
      fs.appendFileSync(file, `${head}\n## Wrapped up ${new Date().toISOString().slice(0, 10)}\n\n${lines.join('\n')}\n`);
    }
  } catch { return null; }
  items = items.filter((i) => !mine.includes(i));
  save();
  return { file, folder, added: lines.length, sessions: mine.length };
}

// ---------- clean up ----------
export interface CleanupInput { tab: string; label: string; cwd: string; state: 'working' | 'waiting' | 'idle'; idleMin: number; entries: Entry[] }
export interface CleanupRow {
  tab: string; label: string; state: CleanupInput['state'];
  /** The model's read: done, nearly done, still going, or it could not tell. */
  status: 'done' | 'nearly' | 'active' | 'unknown';
  left: string; why: string; checked: boolean;
}

const SYSTEM = 'You help one person who has too many Claude Code sessions open at once and is overloaded. ' +
  'For each session below, judge from its excerpt whether its tab can be closed. ' +
  '"done": what was asked has been delivered and nothing is waiting on anyone. ' +
  '"nearly": the main work is delivered and only a small follow-up remains (a check, a commit, an optional extra), or it is a side question of little importance that has gone quiet. ' +
  '"active": real work remains, the person is in the middle of it, or the session is waiting for an answer that matters. ' +
  'When unsure, say "active". ' +
  '"left": one plain sentence, under 25 words, naming what is still open, written so the person can act on it weeks later without rereading the session. Empty string if nothing is. ' +
  '"why": under 12 words. ' +
  'Reply with only JSON: {"sessions":[{"s":"S1","status":"done|nearly|active","left":"...","why":"..."}]}';

const clip = (s: string, n: number) => { const x = s.replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n) + '…' : x; };
function excerpt(t: CleanupInput, n: number): string {
  const users = t.entries.filter((e) => e.kind === 'user') as { text: string }[];
  const replies = t.entries.filter((e) => e.kind === 'assistant') as { text: string }[];
  const recap = [...t.entries].reverse().find((e) => e.kind === 'recap') as { text: string } | undefined;
  const parts = [`S${n}: "${t.label}"`, `Folder: ${t.cwd}`,
    `State: ${t.state === 'working' ? 'Claude is working right now' : t.state === 'waiting' ? 'waiting for the person to answer a prompt' : `quiet for ${t.idleMin} min`}`];
  if (users[0]) parts.push(`First request: ${clip(users[0].text, 400)}`);
  const recent = users.slice(1).slice(-4);
  if (recent.length) parts.push('Recent requests:\n' + recent.map((u) => `- ${clip(u.text, 250)}`).join('\n'));
  if (recap) parts.push(`Latest recap: ${clip(recap.text, 400)}`);
  const last = replies.at(-1);
  if (last) parts.push(`Latest reply (end): ${clip(last.text.slice(-1200), 1200)}`);
  return parts.join('\n');
}

/**
 * One row per open Claude tab. Ticked: the model called it done or nearly done, and it is neither
 * working nor waiting on you. If the model can't be reached, every row comes back unticked.
 */
export async function reviewTabs(list: CleanupInput[]): Promise<CleanupRow[]> {
  const rows: CleanupRow[] = list.map((t) => ({ tab: t.tab, label: t.label, state: t.state, status: 'unknown', left: '', why: '', checked: false }));
  if (!list.length || process.env.CLAUDE_PANE_NO_LABELS) return rows;
  const out = await ask(SYSTEM, list.map((t, i) => excerpt(t, i + 1)).join('\n\n---\n\n'), 120_000);
  if (!out) return rows;
  try {
    const j = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
    for (const s of Array.isArray(j.sessions) ? j.sessions : []) {
      const row = rows[Number(String(s.s ?? '').replace(/\D/g, '')) - 1];
      if (!row) continue;
      row.status = s.status === 'done' || s.status === 'nearly' ? s.status : 'active';
      row.left = clip(String(s.left ?? ''), 300);
      row.why = clip(String(s.why ?? ''), 120);
      row.checked = row.status !== 'active' && row.state === 'idle';
    }
  } catch { /* rows stay unknown */ }
  return rows;
}
