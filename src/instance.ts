// Single-instance support: the running server records its port + token so a second
// launch (e.g. from Spotlight) can ask it to open a new tab instead of a new window.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './platform.js';

const DIR = DATA_DIR;
const FILE = path.join(DIR, 'instance.json');

export function writeInstance(port: number, token: string): void {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 });
}

export function clearInstance(): void {
  try {
    const cur = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (cur.pid === process.pid) fs.unlinkSync(FILE);
  } catch { /* nothing to clear */ }
}

/** True if an already-running instance accepted a new tab for `cwd`. */
export async function handoff(cwd: string): Promise<boolean> {
  let inst: { port: number; token: string };
  try { inst = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return false; }
  try {
    const res = await fetch(`http://127.0.0.1:${inst.port}/api/open?t=${inst.token}`, {
      method: 'POST', body: JSON.stringify({ cwd }), signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch { return false; }
}
