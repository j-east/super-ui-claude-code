// Saved workspaces: a window's tabs (folder + Claude session id) stored as JSON so
// they can be reopened later with `claude --resume <id>` in each tab.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = path.join(os.homedir(), 'Library', 'Application Support', 'claude-pane', 'workspaces');

export interface WorkspaceTab { cwd: string; sessionId: string | null; title: string; claude: boolean }
export interface Workspace { name: string; savedAt: string; active: number; tabs: WorkspaceTab[] }
export interface WorkspaceInfo { name: string; savedAt: string; tabs: number; titles: string[] }

const fileFor = (name: string) => path.join(DIR, `${name.replace(/[^\w .-]+/g, '_').trim().slice(0, 80) || 'workspace'}.json`);

export function saveWorkspace(ws: Omit<Workspace, 'savedAt'>): void {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(fileFor(ws.name), JSON.stringify({ ...ws, savedAt: new Date().toISOString() }, null, 2));
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

export function listWorkspaces(): WorkspaceInfo[] {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).flatMap((f) => {
    try {
      const w: Workspace = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      return [{ name: w.name, savedAt: w.savedAt, tabs: w.tabs.length, titles: w.tabs.map((t) => t.title) }];
    } catch { return []; }
  }).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}
