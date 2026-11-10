// Server-side copy of a tab's terminal screen (headless xterm), used to detect
// Claude Code's numbered choice prompts without depending on the browser.
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';

const QUEUED = /^\s*❯\s/; // a queued message line above the input box
const SEND_NOW_HINT = /ctrl\+x ctrl\+s to send now/;

export interface Prompt { sig: string; label: string }

/** One selectable row of a dialog. `n`: its digit hotkey, if it has one. `checked`: multi-select state. */
export interface DialogOption { n: number | null; label: string; desc: string; checked: boolean | null; current: boolean }
/** A question Claude Code is showing instead of its input box (permission prompt, AskUserQuestion, trust…). */
export interface Dialog {
  steps: { name: string; done: boolean }[]; // multi-question dialogs: the tabs across the top
  text: string;                             // what is being asked (everything above the options)
  options: DialogOption[];
  multi: boolean;
  sig: string;                              // identifies this exact dialog state (stale clicks are ignored)
}

const OPTION_1 = /^\s*❯\s*1\.\s+(\S.*)$/; // highlighted first option
const OPTION_2 = /^\s*2\.\s+\S/;
const OPTION_N = /^\s*(?:❯\s*)?\d+\.\s+\S/;
const MAX_LINES_BELOW = 4;
const RULE = /^\s*[╭╰─━]─{9,}/; // Claude Code's input-box borders / horizontal rules // hint/status lines Claude Code shows under a live prompt

export class Screen {
  private term: InstanceType<typeof headless.Terminal>;
  private ser = new serialize.SerializeAddon();

  constructor(cols: number, rows: number) {
    this.term = new headless.Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000 });
    this.term.loadAddon(this.ser);
  }

  /** Exact current screen (plus some scrollback) as escape sequences, for a fresh client terminal. */
  snapshot(): { data: string; cols: number; rows: number } {
    return { data: this.ser.serialize({ scrollback: 1000 }), cols: this.term.cols, rows: this.term.rows };
  }

  write(data: string): void { this.term.write(data); }
  resize(cols: number, rows: number): void { this.term.resize(cols, rows); }
  dispose(): void { this.term.dispose(); }

  /**
   * What Claude is producing right now: the screen above Claude Code's input box
   * (its rule/border lines), last few dozen lines, trailing blanks trimmed.
   */
  liveLines(max = 24): string[] {
    const b = this.term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < this.term.rows; y++) lines.push((b.getLine(b.baseY + y)?.translateToString(true) ?? '').replace(/\s+$/, ''));
    // Bottom cluster: status line(s), input box between two rule lines. Cut at the upper rule.
    let last = lines.length - 1;
    while (last >= 0 && !lines[last]!.trim()) last--; // content may sit at the top with blank rows below
    let cut = last + 1;
    let rules = 0;
    for (let i = last; i >= Math.max(0, last - 14); i--) {
      if (RULE.test(lines[i]!)) { cut = i; if (++rules === 2) break; }
    }
    if (!rules) cut = Math.max(0, last + 1 - 4);
    const out = lines.slice(0, cut);
    // Queued messages Claude Code lists above its input box ("❯ text" … "ctrl+x ctrl+s to send now"):
    // the app shows those itself, so cut them out of the preview.
    let hint = out.length - 1;
    while (hint >= 0 && !SEND_NOW_HINT.test(out[hint]!)) hint--;
    if (hint >= 0) {
      // Nearest "❯ " line above the hint (a long message wraps), then any earlier queued ones right above it.
      let q = hint;
      while (q > 0 && hint - q < 10 && !QUEUED.test(out[q]!)) q--;
      if (QUEUED.test(out[q]!)) while (q > 0 && QUEUED.test(out[q - 1]!)) q--;
      else q = hint;
      out.splice(q, hint - q + 1);
    }
    while (out.length && !out[out.length - 1]!.trim()) out.pop();
    return out.slice(-max);
  }

  /**
   * How many rows at the bottom of the screen the transcript view doesn't already show: Claude Code's
   * input box and footer, or a whole choice dialog (its question and options). The app sizes the
   * terminal pane to this so the terminal shows only what you need to act on.
   */
  bottomRows(): number {
    const b = this.term.buffer.active;
    const rows = this.term.rows;
    const lines: string[] = [];
    for (let y = 0; y < rows; y++) lines.push(b.getLine(b.baseY + y)?.translateToString(true) ?? '');
    let last = rows - 1;
    while (last >= 0 && !lines[last]!.trim()) last--;
    if (last < 0) return 0;
    let cut = -1;
    // A choice dialog: from the rule above its question down. It can be tall (a long command to approve).
    let opt = last;
    while (opt >= Math.max(0, last - 12) && !OPTION_1.test(lines[opt]!)) opt--;
    if (opt >= Math.max(0, last - 12) && lines.slice(opt + 1, opt + 6).some((l) => OPTION_2.test(l))) {
      for (let i = opt - 1; i >= Math.max(0, opt - 40); i--) if (RULE.test(lines[i]!)) { cut = i; break; }
      if (cut < 0) cut = Math.max(0, opt - 6);
    } else {
      // The input box: its upper border is the second rule up from the bottom.
      let rules = 0;
      for (let i = last; i >= Math.max(0, last - 14); i--) if (RULE.test(lines[i]!) && ++rules === 2) { cut = i; break; }
      if (cut < 0) return 0; // no recognizable box: leave the pane alone
    }
    return rows - cut;
  }

  /**
   * The dialog on screen, if any, as data: its question, options (with descriptions and checkboxes)
   * and which one the cursor is on. Layout, as Claude Code draws it:
   *   ─────────────── (rule)
   *   ←  ☐ Color  ☐ Toppings  ✔ Submit  →     (only with several questions)
   *   question text / command to approve
   *   ❯ 1. Option            or   ❯ 1. [ ] Option   or   ❯ Un-numbered option
   *        description
   *     Submit                                (multi-select)
   *   ─────────────── (rule)
   *     5. Chat about this
   *   Enter to select · … · Esc to cancel
   */
  dialog(): Dialog | null {
    const b = this.term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < this.term.rows; y++) lines.push((b.getLine(b.baseY + y)?.translateToString(true) ?? '').replace(/\s+$/, ''));
    let last = lines.length - 1;
    while (last >= 0 && !lines[last]!.trim()) last--;
    // The cursor row: "❯ 1. Yes" or "❯ Yes, I trust this folder" (but not the input box's bare "❯").
    let cur = -1;
    for (let i = last; i >= Math.max(0, last - 45); i--) if (/^\s*❯\s+\S/.test(lines[i]!)) { cur = i; break; }
    if (cur < 0) return null;
    const indent = lines[cur]!.indexOf('❯');
    const numbered = /^\s*❯\s+\d+\.\s/.test(lines[cur]!);
    const optAt = (i: number): RegExpMatchArray | null => {
      const l = lines[i] ?? '';
      if (l.search(/\S/) < indent) return null;
      const body = l.slice(indent);
      return numbered ? body.match(/^(❯ | {2})(\d+)\.\s+(?:\[(.)\]\s+)?(\S.*)$/) : body.match(/^(❯ | {2})()()(\S.*)$/);
    };
    // Top of the option block: walk up over options and their (deeper-indented) description lines.
    let first = cur;
    for (let i = cur - 1; i >= Math.max(0, cur - 40); i--) {
      const l = lines[i]!;
      if (optAt(i)) { first = i; continue; }
      if (l.trim() && l.search(/\S/) > indent + 2 && !RULE.test(l)) continue; // description
      break;
    }
    // Header: from the rule above the block down to the first option. No rule or no text: not a dialog
    // (e.g. a numbered draft in the input box, which sits right under the box's border).
    let top = -1;
    for (let i = first - 1; i >= Math.max(0, first - 60); i--) if (RULE.test(lines[i]!)) { top = i; break; }
    if (top < 0) return null;
    const head = lines.slice(top + 1, first).map((l) => l.replace(/^ /, ''));
    const steps: Dialog['steps'] = [];
    const tabs = head.findIndex((l) => /^\s*←.*→\s*$/.test(l));
    if (tabs >= 0) {
      for (const m of head[tabs]!.matchAll(/([☐☒✔])\s+(.+?)(?=\s{2,}|\s*→)/g)) if (m[1] !== '✔') steps.push({ name: m[2]!.trim(), done: m[1] === '☒' });
      head.splice(tabs, 1);
    }
    while (head.length && !head[0]!.trim()) head.shift();
    while (head.length && !head[head.length - 1]!.trim()) head.pop();
    if (!head.length) return null;
    // Options, top to bottom, in the order the arrow keys walk them.
    const options: DialogOption[] = [];
    let multi = false;
    let end = first;
    for (let i = first; i <= last; i++) {
      const l = lines[i]!;
      const m = optAt(i);
      if (m) {
        if (m[3] !== undefined && m[3] !== '') multi = true;
        options.push({ n: m[2] ? Number(m[2]) : null, label: m[4]!.trim(), desc: '', current: m[1] === '❯ ',
          checked: m[3] !== undefined && m[3] !== '' ? m[3] !== ' ' : null });
        end = i;
      } else if (RULE.test(l)) {
        if (!optAt(i + 1)) break; // the rule before "5. Chat about this" continues; any other ends the dialog
      } else if (!l.trim()) {
        if (!optAt(i + 1) && !(lines[i + 1] ?? '').trim()) break;
      } else if (/Esc to cancel|Enter to (select|confirm)/.test(l)) break;
      else if (multi && l.trim() === 'Submit') { options.push({ n: null, label: 'Submit', desc: '', current: false, checked: null }); end = i; }
      else if (options.length && l.search(/\S/) > indent + 2) { const o = options[options.length - 1]!; o.desc = o.desc ? `${o.desc} ${l.trim()}` : l.trim(); end = i; }
      else break;
    }
    if (options.length < 2 || !options.some((o) => o.current)) return null;
    // Claude Code's own input box below means this isn't a live dialog (a queued "❯ 1. …" message).
    if (lines.slice(end + 1, last + 1).some((l) => /^\s*❯(\s|$)/.test(l))) return null;
    const text = head.join('\n');
    const sig = JSON.stringify([text, steps, options.map((o) => [o.n, o.label, o.checked, o.current])]);
    return { steps, text, options, multi, sig };
  }

  /** Keys that pick row `index` of the dialog: its digit, or arrows from the cursor plus Enter. */
  static keysFor(d: Dialog, index: number): string | null {
    const o = d.options[index];
    if (!o) return null;
    if (o.n !== null && o.n < 10) return String(o.n);
    const from = d.options.findIndex((x) => x.current);
    const delta = index - from;
    return (delta >= 0 ? '\x1b[B' : '\x1b[A').repeat(Math.abs(delta)) + '\r';
  }

  /** A choice prompt with option 1 highlighted near the bottom of the screen, if one is showing. */
  prompt(): Prompt | null {
    const b = this.term.buffer.active;
    const lines: string[] = [];
    for (let y = Math.max(0, this.term.rows - 30); y < this.term.rows; y++) {
      lines.push(b.getLine(b.baseY + y)?.translateToString(true) ?? '');
    }
    let last = lines.length - 1;
    while (last >= 0 && !lines[last]!.trim()) last--;
    for (let i = last; i >= 0; i--) {
      const m = lines[i]!.match(OPTION_1);
      if (!m) continue;
      // Require a following "2." line so a typed "1. foo" in the input box doesn't count.
      if (!lines.slice(i + 1, i + 6).some((l) => OPTION_2.test(l))) return null;
      // Must be the live prompt at the bottom, not an old one scrolled up in the output.
      let j = i;
      while (j + 1 <= last && OPTION_N.test(lines[j + 1]!)) j++;
      const below = lines.slice(j + 1, last + 1).filter((l) => l.trim()).length;
      if (below > MAX_LINES_BELOW) return null;
      // Not a dialog but your own typing: a "1. …" draft sits right under the input box's top border,
      // and a queued "1. …" message has the whole input box (two borders) below it.
      const above = lines.slice(0, i).reverse().find((l) => l.trim());
      if (above && RULE.test(above)) return null;
      if (lines.slice(j + 1, last + 1).filter((l) => RULE.test(l)).length >= 2) return null;
      return { label: m[1]!.trim(), sig: lines.slice(Math.max(0, i - 6), i + 1).join('\n') };
    }
    return null;
  }
}
