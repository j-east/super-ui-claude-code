// Closed tabs, kept as a list you can tick off, and "Clean up", which reads the open sessions and
// suggests which ones are finished enough to close.
//
// A Claude tab you close goes on the list with its name, what was left to do (if Clean up worked that
// out) and its session id, so it can be reopened later. Ticking an item removes it from the list; the
// session's log is never touched. The list is per workspace and lives in later.json beside the workspaces.
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
  /** The workspace it was closed in ('' for a window without one). */
  workspace: string;
  lane?: string; charter?: string;
}

const FILE = path.join(DATA_DIR, 'later.json');
const MAX = 200;
let items: LaterItem[] = [];
try { const d = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (Array.isArray(d.items)) items = d.items; } catch { /* first run */ }
const save = () => {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify({ items }, null, 2), { mode: 0o600 }); } catch { /* ignore */ }
};

/** Newest first. */
export const laterFor = (workspace: string) => items.filter((i) => i.workspace === workspace).sort((a, b) => b.closedAt - a.closedAt);

/** A closed tab joins the list (replacing an older entry for the same session). Plain shells are not kept. */
export function addLater(rec: WorkspaceTab, workspace: string, left = ''): void {
  if (!rec.sessionId) return;
  items = items.filter((i) => i.sessionId !== rec.sessionId);
  items.push({ id: Math.random().toString(36).slice(2, 10), sessionId: rec.sessionId, cwd: rec.cwd,
    label: (rec.label?.label || rec.title || path.basename(rec.cwd)).slice(0, 80), summary: (rec.label?.summary ?? '').slice(0, 400),
    left: left.slice(0, 300), closedAt: Date.now(), workspace,
    ...(rec.lane ? { lane: rec.lane, charter: rec.charter } : {}) });
  if (items.length > MAX) items = items.sort((a, b) => a.closedAt - b.closedAt).slice(-MAX);
  save();
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
