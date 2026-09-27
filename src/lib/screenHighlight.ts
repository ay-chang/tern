import type { IBufferCell, IBufferLine, Terminal } from "@xterm/xterm";
import { findTokens, type TokenKind } from "./highlight";

/**
 * Styles log levels, HTTP methods and timestamps where they're displayed, by setting
 * the cells' attributes in xterm's buffer once the text has been parsed and before
 * the frame is painted. It's as if the program had sent the colors itself, so:
 * - text is never drawn plain first and recolored a frame later
 * - bold works (decorations can only change color)
 * - styles move with the text when a pager scrolls, and stay in scrollback
 * - it doesn't matter how the text arrived: split across packets, wrapped by less,
 *   or repainted row by row
 *
 * It leaves alone:
 * - cells the program colored itself
 * - the line with the cursor (the prompt, and whatever is being typed)
 * - interactive full-screen apps (vim, htop), recognized by bracketed paste, mouse or
 *   focus reporting, which pagers like less and journalctl don't turn on
 *
 * Tern's styles use the 256-color mode with the first 16 palette entries, which
 * renders exactly like the basic colors and follows the theme, but which programs
 * don't emit (they use the shorter basic codes). That's how Tern tells its own styling
 * apart from a program's and can safely clear it when text changes.
 */

// Cell attribute layout from xterm's buffer (fg word): color mode, palette index, flags.
const CM_MASK = 0x3000000;
const CM_P256 = 0x2000000;
const BOLD = 0x8000000;
const CELL_WORDS = 3;

const style = (paletteIndex: number, bold: boolean) => CM_P256 | paletteIndex | (bold ? BOLD : 0);
const STYLES: Record<TokenKind, number> = {
  error: style(1, true),
  warn: style(3, true),
  info: style(4, true),
  debug: style(8, false),
  method: style(5, true),
  time: style(8, false),
};
const OURS = new Set(Object.values(STYLES));

/** How far above the viewport to look for the start of a wrapped line. */
const MAX_LOOKBACK = 200;
/** Rows that begin with a timestamp or a stack frame start a new log entry. */
const NEW_ENTRY = /^(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:|\d{2}:\d{2}:\d{2}|[A-Z][a-z]{2} [ \d]\d \d{2}:|\s+at |\[\d{4}-)/;

interface Cell {
  data: Uint32Array;
  index: number;
}

/** The raw cell words behind a public buffer line (xterm internals, pinned version). */
function cellData(line: IBufferLine): Uint32Array | undefined {
  return (line as unknown as { _line?: { _data?: Uint32Array } })._line?._data;
}

export class ScreenHighlighter {
  private term: Terminal;
  private enabled: boolean;
  private queued = false;
  private cell: IBufferCell | undefined;
  private disposables: { dispose(): void }[] = [];

  constructor(term: Terminal, enabled: boolean) {
    this.term = term;
    this.enabled = enabled;
    const schedule = () => this.schedule();
    this.disposables.push(
      term.onWriteParsed(schedule),
      term.onScroll(schedule),
      term.onResize(schedule),
      term.buffer.onBufferChange(schedule),
    );
  }

  setEnabled(enabled: boolean) {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) this.schedule();
    else this.clearAll();
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
  }

  /**
   * Runs once per burst of output, in a microtask: after xterm has parsed the text but
   * before it paints the next frame.
   */
  private schedule() {
    if (this.queued || !this.enabled) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      this.update();
    });
  }

  private interactiveApp(): boolean {
    const m = this.term.modes;
    return m.bracketedPasteMode || m.mouseTrackingMode !== "none" || m.sendFocusMode;
  }

  /** Whether row `y` continues the logical line of row `y - 1`. */
  private continues(y: number): boolean {
    const buf = this.term.buffer.active;
    const line = buf.getLine(y);
    if (!line || y === 0) return false;
    if (line.isWrapped) return true;
    // Pagers repaint wrapped rows with cursor moves, so xterm doesn't mark them wrapped.
    // A row written all the way to the last column is the tell, unless the next row is
    // the pager's prompt or plainly starts a new entry.
    if (buf.type !== "alternate" || y === buf.baseY + buf.cursorY) return false;
    const last = buf.getLine(y - 1)?.getCell(this.term.cols - 1, this.cell);
    if (!last || last.getChars() === "") return false;
    return !NEW_ENTRY.test(line.translateToString(false, 0, 40));
  }

  /** Text of rows `first..last` joined, with the buffer cell behind each character. */
  private read(first: number, last: number): { text: string; cells: Cell[] } | undefined {
    const buf = this.term.buffer.active;
    let text = "";
    const cells: Cell[] = [];
    for (let row = first; row <= last; row++) {
      const line = buf.getLine(row);
      const data = line && cellData(line);
      if (!line || !data) return undefined;
      for (let col = 0; col < this.term.cols; col++) {
        const cell = (this.cell = line.getCell(col, this.cell));
        if (!cell) break;
        if (cell.getWidth() === 0) continue;
        const chars = cell.getChars() || " ";
        for (let k = 0; k < chars.length; k++) {
          text += chars[k];
          cells.push({ data, index: col * CELL_WORDS });
        }
      }
    }
    return { text, cells };
  }

  /** Sets styles on one logical line; returns whether anything changed. */
  private style(text: string, cells: Cell[]): boolean {
    const want = new Array<number | undefined>(cells.length);
    for (const t of findTokens(text)) {
      const span = cells.slice(t.start, t.end);
      // Skip anything the program colored itself.
      const free = span.every(({ data, index }) => {
        const fg = data[index + 1];
        return (fg === 0 || OURS.has(fg)) && (data[index + 2] & CM_MASK) === 0;
      });
      if (free) for (let i = t.start; i < t.end; i++) want[i] = STYLES[t.kind];
    }
    let changed = false;
    cells.forEach(({ data, index }, i) => {
      const fg = data[index + 1];
      const next = want[i] ?? (OURS.has(fg) ? 0 : fg);
      if (next !== fg) {
        data[index + 1] = next;
        changed = true;
      }
    });
    return changed;
  }

  private update() {
    const buf = this.term.buffer.active;
    if (!this.enabled || (buf.type === "alternate" && this.interactiveApp())) return;
    const top = buf.viewportY;
    const bottom = Math.min(top + this.term.rows - 1, buf.length - 1);
    const cursorRow = buf.baseY + buf.cursorY;

    let start = top;
    for (let n = 0; start > 0 && n < MAX_LOOKBACK && this.continues(start); n++) start--;

    let changed = false;
    for (let y = start; y <= bottom; ) {
      let end = y;
      while (end + 1 < buf.length && this.continues(end + 1)) end++;
      if (cursorRow < y || cursorRow > end) {
        const line = this.read(y, end);
        if (line && this.style(line.text, line.cells)) changed = true;
      }
      y = end + 1;
    }
    if (changed) this.term.refresh(0, this.term.rows - 1);
  }

  /** Removes Tern's styling from the whole buffer, e.g. when highlighting is turned off. */
  private clearAll() {
    const buf = this.term.buffer.active;
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y);
      const data = line && cellData(line);
      if (!data) continue;
      for (let i = 1; i < data.length; i += CELL_WORDS) if (OURS.has(data[i])) data[i] = 0;
    }
    this.term.refresh(0, this.term.rows - 1);
  }
}
