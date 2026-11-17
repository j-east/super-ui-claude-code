// Saved workspaces: a window's tabs (folder + Claude session id) stored as JSON so
// they can be reopened later with `claude --resume <id>` in each tab.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './platform.js';

const DIR = path.join(DATA_DIR, 'workspaces');

/** `label`: the tab's written label when it was saved, so a reopened tab has its name before its session is back. */
export interface WorkspaceTab { cwd: string; sessionId: string | null; title: string; claude: boolean; label?: { label: string; summary: string } | null }
/** `auto`: the app named it (from the project folder); it has not been renamed by you. */
export interface Workspace { name: string; savedAt: string; createdAt?: string; auto?: boolean; active: number; tabs: WorkspaceTab[] }
export interface WorkspaceInfo { name: string; savedAt: string; createdAt: string; auto: boolean; tabs: number; titles: string[]; folders: string[]; covered: boolean }

const fileFor = (name: string) => path.join(DIR, `${name.replace(/[^\w .-]+/g, '_').trim().slice(0, 80) || 'workspace'}.json`);

/** Save under `ws.name`. When it was first created, and whether the app named it, carry over from the file. */
export function saveWorkspace(ws: Pick<Workspace, 'name' | 'active' | 'tabs'> & { auto?: boolean }): void {
  fs.mkdirSync(DIR, { recursive: true });
  const prev = loadWorkspace(ws.name);
  const now = new Date().toISOString();
  fs.writeFileSync(fileFor(ws.name), JSON.stringify({ ...ws, auto: ws.auto ?? prev?.auto ?? false,
    createdAt: prev?.createdAt ?? prev?.savedAt ?? now, savedAt: now }, null, 2));
}

/** Give a workspace a name of your own. False if there is nothing to rename. */
export function renameWorkspace(from: string, to: string): boolean {
  const w = loadWorkspace(from);
  if (!w) return false;
  deleteWorkspace(from);
  fs.writeFileSync(fileFor(to), JSON.stringify({ ...w, name: to, auto: false }, null, 2));
  return true;
}

/** Keep only the newest `keep` workspaces the app named itself, leaving alone any in `inUse`. */
export function pruneAutoWorkspaces(keep: number, inUse: Set<string>): void {
  for (const w of listWorkspaces().filter((x) => x.auto && !inUse.has(x.name)).slice(keep)) deleteWorkspace(w.name);
}

export function loadWorkspace(name: string): Workspace | null {
  try { return JSON.parse(fs.readFileSync(fileFor(name), 'utf8')); } catch { return null; }
}

export function deleteWorkspace(name: string): void {
  try { fs.unlinkSync(fileFor(name)); } catch { /* already gone */ }
}

/** Keep only the newest `keep` automatic "Closed window …" saves. */
export function pruneClosedWindowSaves(keep: number): void {
  for (const w of listWorkspaces().filter((x) => x.name.startsWith('Closed window ')).slice(keep)) deleteWorkspace(w.name);
}

/** Saves the app makes as a safety net (not workspaces you or a window own). */
export const SAFETY_NAME = /^(Last session$|Last closed window$|Closed window )/;

export function listWorkspaces(): WorkspaceInfo[] {
  if (!fs.existsSync(DIR)) return [];
  const all = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).flatMap((f) => {
    try { const w: Workspace = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); return Array.isArray(w.tabs) ? [w] : []; } catch { return []; }
  });
  // A safety-net save whose sessions are all in a real workspace is the same thing twice: mark it so lists can skip it.
  const owned = new Set(all.filter((w) => !SAFETY_NAME.test(w.name)).flatMap((w) => w.tabs.map((t) => t.sessionId).filter(Boolean)));
  return all.map((w) => ({ name: w.name, savedAt: w.savedAt, createdAt: w.createdAt ?? w.savedAt, auto: !!w.auto, tabs: w.tabs.length,
    titles: w.tabs.map((t) => t.label?.label || t.title), folders: [...new Set(w.tabs.map((t) => t.cwd))],
    covered: SAFETY_NAME.test(w.name) && w.tabs.every((t) => !t.sessionId || owned.has(t.sessionId)) }))
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}
