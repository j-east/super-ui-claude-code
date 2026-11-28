// The few things about you the app keeps for its agents, in prefs.json in the data folder.
// How you like time put on your calendar, in your own words, and the folders you have trusted. The app has no calendar
// connection of its own; the Steward is a Claude Code session, so it uses whatever calendar
// connector, MCP server or skill your Claude Code already has, and follows this note.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './platform.js';

const FILE = path.join(DATA_DIR, 'prefs.json');
export const DEFAULT_SCHEDULING = '30-minute blocks on weekdays during working hours, in the next free slots this week, on my main calendar.';
let prefs: { scheduling?: string; trusted?: string[] } = {};
try { prefs = JSON.parse(fs.readFileSync(FILE, 'utf8')) ?? {}; } catch { /* first run */ }

export const scheduling = () => (typeof prefs.scheduling === 'string' && prefs.scheduling.trim()) || DEFAULT_SCHEDULING;
const save = () => {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(prefs, null, 2), { mode: 0o600 }); } catch { /* ignore */ }
};
export function setScheduling(text: string): void {
  prefs.scheduling = text.replace(/\s+/g, ' ').trim().slice(0, 600);
  save();
}

// Folders where you answered Claude Code's "trust this folder?" with yes, in this app. Claude Code does not
// keep that answer for every folder (your home folder is asked again each time), so the app gives the
// same answer for you the next time. Exact folders only: a subfolder is asked about on its own.
export const isTrusted = (cwd: string) => Array.isArray(prefs.trusted) && prefs.trusted.includes(cwd);
export function rememberTrust(cwd: string): void {
  if (!cwd || isTrusted(cwd)) return;
  prefs.trusted = [...(Array.isArray(prefs.trusted) ? prefs.trusted : []), cwd].slice(-500);
  save();
}
