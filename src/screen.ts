// Server-side copy of a tab's terminal screen (headless xterm), used to detect
// Claude Code's numbered choice prompts without depending on the browser.
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';

const QUEUED = /^\s*❯\s/; // a queued message line above the input box
const SEND_NOW_HINT = /ctrl\+x ctrl\+s to send now/;

export interface Prompt { sig: string; label: string }

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
