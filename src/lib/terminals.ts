import { Channel } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { api, errorText } from "./api";
import { ScreenHighlighter } from "./screenHighlight";
import { isMac } from "./platform";
import { hostById, useStore } from "./store";
import { resolveTheme, XTERM_THEMES } from "./theme";
import type { SessionEvent } from "./types";

const FONT = '"Geist Mono Variable", ui-monospace, Menlo, monospace';
const DIM = "\x1b[38;2;107;105;101m";
const RED = "\x1b[38;2;240;127;119m";
const RESET = "\x1b[0m";
/** Lines per row's worth of wheel movement in pagers; xterm's default is 1. */
const PAGER_SCROLL_SPEED = 3;

/**
 * xterm instances live outside React so a session keeps its scrollback while
 * its tab is hidden or the user is on another view. Components only mount the
 * element somewhere visible.
 */
interface Entry {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  opened: boolean;
  opening?: Promise<void>;
  /** Colors log-like text on screen; created once the terminal is open. */
  hl?: ScreenHighlighter;
  /** True while the shell is up and keystrokes should go to the server. */
  live: boolean;
  starting: boolean;
  /** Keystrokes typed while connecting, sent once the shell is up (like ssh does). */
  typeahead: string;
  resizeTimer?: number;
}

// Kept across dev hot reloads: a fresh module with an empty map would open a second
// terminal (and a second SSH connection) on top of each live one.
const entries: Map<string, Entry> = import.meta.hot?.data.entries ?? new Map();
if (import.meta.hot) import.meta.hot.data.entries = entries;
// Handy when debugging rendering from the dev tools console.
if (import.meta.env.DEV) (window as unknown as { __ternTerminals: typeof entries }).__ternTerminals = entries;

function termOptions() {
  const { prefs } = useStore.getState();
  return {
    fontFamily: FONT,
    fontSize: prefs.fontSize,
    lineHeight: prefs.lineHeight,
    cursorStyle: prefs.cursor,
    cursorBlink: true,
    scrollback: prefs.scrollback,
    theme: XTERM_THEMES[resolveTheme(prefs.theme)],
    fontWeightBold: 600 as const,
    drawBoldTextInBrightColors: false,
    macOptionClickForcesSelection: true,
  };
}

function create(id: string): Entry {
  const term = new Terminal(termOptions());
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      event.preventDefault();
      void openUrl(uri);
    }),
  );
  term.attachCustomKeyEventHandler((ev) => keyFilter(ev, term));

  const el = document.createElement("div");
  el.style.height = "100%";
  const entry: Entry = {
    term,
    fit,
    el,
    opened: false,
    live: false,
    starting: false,
    typeahead: "",
  };

  term.onData((data) => {
    if (entry.live) void api.terminalWrite(id, data);
    else if (entry.starting) entry.typeahead += data;
    else if (data === "\r") void start(id);
  });
  // In pagers (less, journalctl, man) the wheel becomes arrow keys. Do that ourselves,
  // faster than xterm's one-line-per-row-of-scroll default and batched into one write.
  let wheel = 0;
  term.attachCustomWheelEventHandler((ev) => {
    if (term.buffer.active.type !== "alternate" || term.modes.mouseTrackingMode !== "none") return true;
    ev.preventDefault();
    if (!entry.live) return false;
    const rowPx = entry.el.clientHeight / term.rows || 16;
    const px = ev.deltaMode === 1 ? ev.deltaY * rowPx : ev.deltaMode === 2 ? ev.deltaY * rowPx * term.rows : ev.deltaY;
    wheel += (px / rowPx) * PAGER_SCROLL_SPEED;
    const lines = Math.trunc(wheel);
    if (lines !== 0) {
      wheel -= lines;
      const app = term.modes.applicationCursorKeysMode;
      const key = lines > 0 ? (app ? "\x1bOB" : "\x1b[B") : app ? "\x1bOA" : "\x1b[A";
      void api.terminalWrite(id, key.repeat(Math.min(Math.abs(lines), 200)));
    }
    return false;
  });
  term.onResize(({ cols, rows }) => {
    if (!entry.live) return;
    window.clearTimeout(entry.resizeTimer);
    entry.resizeTimer = window.setTimeout(() => void api.terminalResize(id, cols, rows), 60);
  });
  entries.set(id, entry);
  return entry;
}

/** App shortcuts win over the shell; everything else goes to the terminal. */
function keyFilter(ev: KeyboardEvent, term: Terminal): boolean {
  if (ev.type !== "keydown") return true;
  if (isMac) return !ev.metaKey;
  if (ev.ctrlKey && ev.shiftKey) {
    const k = ev.key.toLowerCase();
    if (k === "c") {
      const sel = term.getSelection();
      if (sel) void navigator.clipboard.writeText(sel);
      return false;
    }
    return !["v", "k", "t", "w", "n", "b"].includes(k);
  }
  return true;
}

export function mount(id: string, container: HTMLElement): Promise<void> {
  const entry = entries.get(id) ?? create(id);
  // A pane only ever shows its own terminal; drop anything else that ended up in it.
  if (entry.el.parentElement !== container || container.childElementCount !== 1) container.replaceChildren(entry.el);
  // Shared so a second mount while the font loads doesn't open the terminal twice.
  entry.opening ??= (async () => {
    // Opening before the font loads gives wrong cell metrics.
    await document.fonts.load(`${entry.term.options.fontSize}px "Geist Mono Variable"`).catch(() => {});
    if (!entries.has(id)) return;
    entry.term.open(entry.el);
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      entry.term.loadAddon(gl);
    } catch {
      // Falls back to the DOM renderer.
    }
    entry.opened = true;
    const { prefs } = useStore.getState();
    entry.hl = new ScreenHighlighter(entry.term, prefs.highlight);
    fit(id);
    const s = useStore.getState();
    if (s.activeId === id && s.view === "term" && !s.paletteOpen && !s.prompts.length) entry.term.focus();
    void start(id);
  })();
  fit(id);
  return entry.opening;
}

export function fit(id: string) {
  const entry = entries.get(id);
  if (!entry?.opened || !entry.el.isConnected || entry.el.clientWidth === 0) return;
  try {
    entry.fit.fit();
  } catch {
    // Measuring can fail while the element is being laid out.
  }
}

export function focus(id: string) {
  entries.get(id)?.term.focus();
}

function line(entry: Entry, text: string) {
  entry.term.write(`${text}\r\n`);
}

async function start(id: string) {
  const entry = entries.get(id);
  const store = useStore.getState();
  const session = store.sessions.find((s) => s.id === id);
  const host = hostById(session?.hostId);
  if (!entry || !session) return;
  if (!host) {
    line(entry, `${RED}This host no longer exists.${RESET}`);
    return;
  }

  entry.starting = true;
  entry.live = false;
  entry.typeahead = "";
  store.updateSession(id, { state: "connecting", message: "" });
  line(entry, `${DIM}Connecting to ${host.username}@${host.address}${host.port === 22 ? "" : `:${host.port}`}…${RESET}`);

  const data = new Channel<ArrayBuffer | number[]>();
  data.onmessage = (chunk) => entry.term.write(new Uint8Array(chunk as ArrayBuffer));
  const events = new Channel<SessionEvent>();
  events.onmessage = (ev) => onEvent(id, host.name, entry, ev);

  try {
    const info = await api.terminalOpen(id, host.id, entry.term.cols, entry.term.rows, data, events);
    goLive(id, entry);
    useStore.getState().updateSession(id, { state: "connected", authLabel: info.authLabel });
    void api.terminalResize(id, entry.term.cols, entry.term.rows);
  } catch (e) {
    if (!entries.has(id)) return;
    const message = errorText(e);
    if (message !== "Cancelled") {
      line(entry, `${RED}✕ ${message}${RESET}`);
      line(entry, `${DIM}Press Enter to reconnect.${RESET}`);
    }
    useStore.getState().updateSession(id, { state: "error", message });
  } finally {
    entry.starting = false;
  }
}

function goLive(id: string, entry: Entry) {
  entry.live = true;
  if (entry.typeahead) {
    void api.terminalWrite(id, entry.typeahead);
    entry.typeahead = "";
  }
}

function onEvent(id: string, hostName: string, entry: Entry, ev: SessionEvent) {
  const store = useStore.getState();
  switch (ev.type) {
    case "status":
      if (ev.state === "connected") goLive(id, entry);
      if (ev.state === "closed") {
        entry.live = false;
        if (entries.has(id)) {
          line(entry, `\r\n${DIM}Connection closed. Press Enter to reconnect.${RESET}`);
          store.updateSession(id, { state: "closed" });
        }
      } else if (ev.state !== "error") {
        store.updateSession(id, { state: ev.state });
      }
      break;
    case "banner":
      entry.term.write(ev.text.replace(/\r?\n/g, "\r\n"));
      break;
    case "hostKey":
    case "prompt":
      store.pushPrompt({ owner: id, hostName, event: ev });
      break;
    case "exit":
      break;
  }
}

/** Opens a new tab for a host and switches to it. */
export function openSession(hostId: string) {
  const id = crypto.randomUUID();
  useStore.setState((s) => ({
    sessions: [...s.sessions, { id, hostId, state: "connecting", message: "" }],
    activeId: id,
    view: "term",
    paletteOpen: false,
  }));
}

/** Switches to the host's existing tab if there is one, otherwise opens a new session. */
export function connectHost(hostId: string) {
  const existing = useStore.getState().sessions.find((s) => s.hostId === hostId);
  if (existing) {
    useStore.setState({ activeId: existing.id, view: "term", paletteOpen: false });
    reconnect(existing.id);
  } else {
    openSession(hostId);
  }
}

export function reconnect(id: string) {
  const entry = entries.get(id);
  if (entry && !entry.live && !entry.starting) {
    line(entry, "");
    void start(id);
  }
}

export function closeSession(id: string) {
  const store = useStore.getState();
  store.dropPrompts(id);
  void api.terminalClose(id);
  const entry = entries.get(id);
  entries.delete(id);
  entry?.hl?.dispose();
  entry?.term.dispose();
  entry?.el.remove();

  useStore.setState((s) => {
    const idx = s.sessions.findIndex((x) => x.id === id);
    const sessions = s.sessions.filter((x) => x.id !== id);
    let { activeId, view } = s;
    if (activeId === id) {
      activeId = sessions[Math.min(idx, sessions.length - 1)]?.id ?? null;
      if (!activeId && view === "term") view = "hosts";
    }
    return { sessions, activeId, view };
  });
}

/** Re-applies font, cursor and theme preferences to every open terminal. */
export function applyPrefs() {
  const opts = termOptions();
  for (const [id, entry] of entries) {
    entry.term.options.theme = opts.theme;
    entry.term.options.fontSize = opts.fontSize;
    entry.term.options.cursorStyle = opts.cursorStyle;
    entry.term.options.scrollback = opts.scrollback;
    entry.term.options.lineHeight = opts.lineHeight;
    entry.hl?.setEnabled(useStore.getState().prefs.highlight);
    fit(id);
  }
}
