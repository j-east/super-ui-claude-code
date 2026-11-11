// Follows a Claude Code session transcript (~/.claude/projects/<cwd-slug>/<session>.jsonl)
// and turns raw JSONL lines into display entries for the rendered pane.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export type Entry =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'command'; id: string; name: string; args: string }
  | { kind: 'note'; id: string; text: string }
  | { kind: 'compact'; id: string; text: string }
  | { kind: 'recap'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'tool'; id: string; toolId: string; name: string; summary: string; input: string }
  | { kind: 'result'; id: string; toolId: string; text: string; isError: boolean }
  | { kind: 'title'; id: string; text: string; source: 'ai' | 'custom' };

const RESULT_LIMIT = 6000;
// A long session's log can be 100+ MB (images and big tool results inline): start reading far enough
// back for about TAIL_MESSAGES messages, but never more than TAIL_MAX_BYTES from the end.
const TAIL_MESSAGES = 600;
const TAIL_MAX_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024; // read at most this much per tick, so other tabs keep flowing
const MAX_ENTRIES = 3000;            // kept (and sent to the page) per tab

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');

export function projectDirFor(cwd: string): string {
  return path.join(PROJECTS, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

/** Session a running claude process is on, from Claude Code's own ~/.claude/sessions/<pid>.json (tracks /resume, /clear). */
export function sessionIdForPid(pid: number): string | null {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'sessions', `${pid}.json`), 'utf8'));
    return typeof d.sessionId === 'string' ? d.sessionId : null;
  } catch { return null; }
}

const found = new Map<string, string>();
const missed = new Map<string, number>(); // id -> when a full search last failed
/**
 * Transcript file for a session id. A resumed session keeps writing to the project folder it
 * was first created in, which may not be the folder claude was started from.
 */
export function findTranscript(id: string, preferDir?: string): string | null {
  const hit = found.get(id);
  if (hit && fs.existsSync(hit)) return hit;
  if (preferDir && fs.existsSync(path.join(preferDir, `${id}.jsonl`))) {
    const f = path.join(preferDir, `${id}.jsonl`); found.set(id, f); return f;
  }
  // Brand-new session without a transcript yet: don't rescan every project folder 3x a second.
  if (Date.now() - (missed.get(id) ?? 0) < 5000) return null;
  const dirs: string[] = [];
  try { dirs.push(...fs.readdirSync(PROJECTS).map((d) => path.join(PROJECTS, d))); } catch { /* no projects yet */ }
  for (const d of dirs) {
    const f = path.join(d, `${id}.jsonl`);
    if (fs.existsSync(f)) { found.set(id, f); missed.delete(id); return f; }
  }
  missed.set(id, Date.now());
  return null;
}

type Block = { type?: string; text?: string; thinking?: string; id?: string; name?: string;
  input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean };

function stripReminders(s: string): string {
  return s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

function tag(s: string, name: string): string | null {
  const m = s.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? (m[1] ?? '').trim() : null;
}

function userString(id: string, raw: string): Entry[] {
  const cmd = tag(raw, 'command-name');
  if (cmd) return [{ kind: 'command', id, name: cmd, args: tag(raw, 'command-args') ?? '' }];
  const out = tag(raw, 'local-command-stdout');
  if (out !== null) return out ? [{ kind: 'note', id, text: out }] : [];
  if (raw.includes('<local-command-caveat>')) return [];
  const text = stripReminders(raw);
  return text ? [{ kind: 'user', id, text }] : [];
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c: Block) => (c.type === 'text' ? c.text ?? '' : `[${c.type}]`)).join('\n');
  }
  return '';
}

function toolSummary(name: string, input: Record<string, unknown>): string {
  for (const k of ['description', 'command', 'file_path', 'pattern', 'url', 'query', 'prompt', 'skill']) {
    const v = input[k];
    if (typeof v === 'string' && v) return v.split('\n')[0]!.slice(0, 160);
  }
  return name.startsWith('mcp__') ? '' : JSON.stringify(input).slice(0, 160);
}

export function parseLine(line: string): Entry[] {
  let d: any;
  try { d = JSON.parse(line); } catch { return []; }
  // Session summary line (what /resume shows): Claude's generated title, or one you set.
  if (d.type === 'ai-title' && typeof d.aiTitle === 'string') return [{ kind: 'title', id: 'title', text: d.aiTitle, source: 'ai' }];
  if (d.type === 'custom-title' && typeof d.customTitle === 'string') return [{ kind: 'title', id: 'title', text: d.customTitle, source: 'custom' }];
  // "recap:" line Claude Code writes when you come back to an idle session.
  if (d.type === 'system' && d.subtype === 'away_summary' && typeof d.content === 'string' && d.content.trim()) {
    return [{ kind: 'recap', id: d.uuid ?? Math.random().toString(36).slice(2), text: d.content.trim() }];
  }
  if ((d.type !== 'user' && d.type !== 'assistant') || d.isSidechain || d.isMeta) return [];
  const id: string = d.uuid ?? Math.random().toString(36).slice(2);
  const content = d.message?.content;
  // The summary Claude Code writes after compacting: a marker, not a message you typed.
  if (d.isCompactSummary) {
    const text = typeof content === 'string' ? content
      : Array.isArray(content) ? content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n') : '';
    return [{ kind: 'compact', id, text }];
  }
  if (typeof content === 'string') return d.type === 'user' ? userString(id, content) : [{ kind: 'assistant', id, text: content }];
  if (!Array.isArray(content)) return [];

  const out: Entry[] = [];
  content.forEach((b: Block, i: number) => {
    const bid = `${id}:${i}`;
    if (b.type === 'text' && b.text) {
      out.push(...(d.type === 'user' ? userString(bid, b.text) : [{ kind: 'assistant', id: bid, text: b.text } as Entry]));
    } else if (b.type === 'thinking' && b.thinking) {
      out.push({ kind: 'thinking', id: bid, text: b.thinking });
    } else if (b.type === 'tool_use' && b.id && b.name) {
      const input = b.input ?? {};
      out.push({ kind: 'tool', id: bid, toolId: b.id, name: b.name, summary: toolSummary(b.name, input),
        input: JSON.stringify(input, null, 2).slice(0, RESULT_LIMIT) });
    } else if (b.type === 'tool_result' && b.tool_use_id) {
      let text = resultText(b.content);
      if (text.length > RESULT_LIMIT) text = text.slice(0, RESULT_LIMIT) + `\n… (${text.length - RESULT_LIMIT} more chars)`;
      out.push({ kind: 'result', id: bid, toolId: b.tool_use_id, text, isError: !!b.is_error });
    } else if (b.type === 'image') {
      out.push({ kind: 'note', id: bid, text: '[image]' });
    }
  });
  return out;
}

export interface FollowerEvents {
  reset(file: string, entries: Entry[]): void;
  append(entries: Entry[]): void;
  /** Messages you typed while Claude was busy, waiting to be delivered (oldest first). */
  queue?(items: string[]): void;
}

/** Applies a queue-operation transcript line to the pending list. Returns true if it was one. */
function applyQueueOp(line: string, q: string[]): boolean {
  if (!line.includes('"queue-operation"')) return false;
  let d: any;
  try { d = JSON.parse(line); } catch { return false; }
  if (d.type !== 'queue-operation') return false;
  if (d.operation === 'enqueue' && typeof d.content === 'string') q.push(d.content);
  else if (d.operation === 'dequeue') q.shift();
  else if (d.operation === 'remove') { const i = q.indexOf(d.content); if (i >= 0) q.splice(i, 1); }
  return true;
}

/** Queued items worth showing: your own messages, not task/agent notifications. */
const visibleQueue = (q: string[]) => q.filter((c) => !c.trimStart().startsWith('<'));

/**
 * Polls the project dir for the transcript of a claude process that started at `since`.
 * Until one is chosen, adopts the newest transcript written after `since` (new session,
 * -c, --resume). Then switches only to transcripts created later (covers /clear).
 * Limitation: another session in the same folder writing at the same time can be picked up.
 */
export class TranscriptFollower {
  private file: string | null = null;
  private adoptedAt: number;
  private offset = 0;
  private partial = '';
  private decoder = new StringDecoder('utf8'); // keeps multi-byte characters split across reads intact
  private skipFirstLine = false;
  private titleScan: { pos: number; end: number; partial: string } | null = null; // older part we skipped
  private titleSeen = new Set<string>();
  private lastTitle: Record<string, string> = {};
  private lastDirScan = 0;
  private all: Entry[] = [];
  private queue: string[] = [];
  private timer: NodeJS.Timeout | undefined;

  /**
   * `locate`: what Claude Code itself says this claude process's session is. `{ file }` once it has a
   * transcript, `{ file: null }` while it has none yet (a session with no message), null if it can't
   * say. Only in that last case do we guess from the folder: guessing while the session is known would
   * pick up another tab's transcript when two sessions run in the same folder.
   */
  constructor(private dir: string, private since: number, private ev: FollowerEvents, resume?: string | null,
    private locate?: () => { file: string | null } | null) {
    this.adoptedAt = since;
    if (resume) { this.file = findTranscript(resume, dir) ?? path.join(dir, `${resume}.jsonl`); this.seek(this.file); }
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), 300);
    this.tick();
  }

  stop(): void { clearInterval(this.timer); }

  snapshot(): { file: string | null; entries: Entry[]; queue: string[] } {
    return { file: this.file, entries: this.all, queue: visibleQueue(this.queue) };
  }

  private tick(): void {
    try { this.step(); } catch { /* file vanished or raced a write; next tick retries */ }
  }

  private step(): void {
    const exact = this.locate?.();
    if (exact) { if (exact.file && exact.file !== this.file) this.adopt(exact.file); }
    else if (Date.now() - this.lastDirScan > 2000) { this.lastDirScan = Date.now(); this.checkForNewer(); }
    if (!this.file || !fs.existsSync(this.file)) return;
    const size = fs.statSync(this.file).size;
    if (size < this.offset) return this.adopt(this.file);
    if (size === this.offset) return this.scanTitles();
    const len = Math.min(size - this.offset, CHUNK_BYTES);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(this.file, 'r');
    try { fs.readSync(fd, buf, 0, len, this.offset); } finally { fs.closeSync(fd); }
    this.offset += len;
    const lines = (this.partial + this.decoder.write(buf)).split('\n');
    this.partial = lines.pop() ?? '';
    if (this.skipFirstLine) { lines.shift(); this.skipFirstLine = false; } // started mid-line
    const before = visibleQueue(this.queue).join('\0');
    const fresh = lines.flatMap((l) => (applyQueueOp(l, this.queue) ? [] : parseLine(l))).filter((e) => {
      if (e.kind !== 'title') return true;
      // Claude Code rewrites the title line over and over: keep one per kind, only when it changes.
      this.titleSeen.add(e.source);
      if (this.lastTitle[e.source] === e.text) return false;
      this.lastTitle[e.source] = e.text;
      this.all = this.all.filter((x) => !(x.kind === 'title' && x.source === e.source));
      return true;
    });
    if (fresh.length) { this.all.push(...fresh); this.trim(); this.ev.append(fresh); }
    const after = visibleQueue(this.queue);
    if (after.join('\0') !== before) this.ev.queue?.(after);
  }

  /** Keep the newest MAX_ENTRIES (plus the latest title of each kind). */
  private trim(): void {
    if (this.all.length <= MAX_ENTRIES) return;
    const drop = this.all.slice(0, this.all.length - MAX_ENTRIES);
    const titles = (['ai', 'custom'] as const).map((src) => drop.filter((e) => e.kind === 'title' && e.source === src).at(-1))
      .filter((e): e is Entry => !!e);
    this.all = [...titles, ...this.all.slice(-MAX_ENTRIES)];
  }

  /** The session title may only be in the part of a big log we skipped: find it, a chunk per tick. */
  private scanTitles(): void {
    const t = this.titleScan;
    if (!t || !this.file) return;
    const len = Math.min(t.end - t.pos, CHUNK_BYTES);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(this.file, 'r');
    try { fs.readSync(fd, buf, 0, len, t.pos); } finally { fs.closeSync(fd); }
    t.pos += len;
    const lines = (t.partial + buf.toString('latin1')).split('\n'); // only ASCII markers matter here
    t.partial = lines.pop() ?? '';
    if (t.pos >= t.end) this.titleScan = null;
    const found: Entry[] = [];
    for (const l of lines) {
      if (!l.includes('-title"')) continue;
      const e = parseLine(Buffer.from(l, 'latin1').toString('utf8'))[0];
      if (e?.kind === 'title' && !this.titleSeen.has(e.source)) found.push(e);
    }
    // Newest of each kind wins; a title already seen in the recent part beats anything older.
    const latest = (['ai', 'custom'] as const).map((src) => found.filter((e) => e.kind === 'title' && e.source === src).at(-1))
      .filter((e): e is Entry => !!e);
    if (!latest.length) return;
    const srcs = new Set(latest.map((e) => e.kind === 'title' && e.source));
    this.all = [...latest, ...this.all.filter((e) => !(e.kind === 'title' && srcs.has(e.source)))];
    this.ev.append(latest);
  }

  private checkForNewer(): void {
    if (!fs.existsSync(this.dir)) return;
    let best: { f: string; t: number } | null = null;
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const f = path.join(this.dir, name);
      if (f === this.file) continue;
      const st = fs.statSync(f);
      // Nothing chosen yet: any transcript touched since claude started. Afterwards: only newly created ones.
      const t = this.file ? st.birthtimeMs : st.mtimeMs;
      const floor = this.file ? this.adoptedAt : this.since;
      if (t >= floor && (!best || t > best.t)) best = { f, t };
    }
    if (best) this.adopt(best.f);
  }

  /** Start reading `file` near its end (only the recent TAIL_BYTES of a long log). */
  private seek(file: string): void {
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    this.offset = tailStart(file, size);
    this.skipFirstLine = this.offset > 0;
    this.titleScan = this.offset > 0 ? { pos: 0, end: this.offset, partial: '' } : null;
    this.titleSeen = new Set();
    this.lastTitle = {};
    this.partial = '';
    this.decoder = new StringDecoder('utf8');
    this.all = [];
    this.queue = [];
  }

  private adopt(file: string): void {
    this.file = file;
    this.adoptedAt = Date.now();
    this.seek(file);
    this.ev.reset(file, []);
    this.ev.queue?.([]);
  }
}

/** Byte offset to start reading from so roughly the last TAIL_MESSAGES messages are included. */
function tailStart(file: string, size: number): number {
  const markers = [Buffer.from('"type":"user",'), Buffer.from('"type":"assistant",')];
  let pos = size, count = 0;
  const fd = fs.openSync(file, 'r');
  try {
    while (pos > 0 && size - pos < TAIL_MAX_BYTES) {
      const len = Math.min(pos, CHUNK_BYTES);
      pos -= len;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      for (const m of markers) for (let i = buf.indexOf(m); i >= 0; i = buf.indexOf(m, i + 1)) count++;
      if (count >= TAIL_MESSAGES) break;
    }
  } finally { fs.closeSync(fd); }
  return pos;
}

/** Which existing transcript a claude command line resumes, if any (-c / --continue / -r <id> / --resume <id>). */
export function resumedSessionId(dir: string, args: string): string | null {
  const r = args.match(/(?:^|\s)(?:-r|--resume)(?:\s+|=)([0-9a-f-]{36})/);
  if (r) return r[1] ?? null;
  if (!/(?:^|\s)(?:-c|--continue)(?:\s|$)/.test(args) || !fs.existsSync(dir)) return null;
  const newest = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'))
    .map((n) => ({ n, m: fs.statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => b.m - a.m)[0];
  return newest ? newest.n.slice(0, -'.jsonl'.length) : null;
}
