import { create } from "zustand";
import { api, type PromptReply } from "./api";
import type {
  ConnState,
  Group,
  Host,
  HostKeyEvent,
  KeyInfo,
  Prefs,
  PromptEvent,
  View,
} from "./types";

export interface Session {
  id: string;
  hostId: string;
  state: ConnState;
  message: string;
  authLabel?: string;
}

export interface PendingPrompt {
  /** The terminal session or SFTP connection that is waiting on this answer. */
  owner: string;
  hostName: string;
  event: HostKeyEvent | PromptEvent;
}

export interface TextPrompt {
  title: string;
  label: string;
  value: string;
  confirmLabel: string;
  resolve: (value: string | null) => void;
}

const viewedKey = (p: KeyPanel) => (p?.mode === "view" ? p.id : null);

const PREFS_KEY = "tern.prefs";
const DEFAULT_PREFS: Prefs = { theme: "dark", layout: "sidebar", fontSize: 13, cursor: "bar", scrollback: 10000, lineHeight: 1.35, highlight: true };

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    // Unreadable prefs fall back to defaults.
  }
  return DEFAULT_PREFS;
}

/** Right-hand panel in the Keychain view. */
export type KeyPanel = { mode: "import" } | { mode: "generate" } | { mode: "view"; id: string } | null;

interface Store {
  hosts: Host[];
  groups: Group[];
  keys: KeyInfo[];
  keyPanel: KeyPanel;
  /** Connect latency per host id; null means unreachable, absent means not probed yet. */
  probes: Record<string, number | null>;
  sessions: Session[];
  activeId: string | null;
  view: View;
  selectedHostId: string | null;
  /** Host editor panel: null is closed, `{ hostId: null }` is a new host. */
  editor: { hostId: string | null } | null;
  query: string;
  groupFilter: string | null;
  paletteOpen: boolean;
  sidebarHidden: boolean;
  prompts: PendingPrompt[];
  textPrompt: TextPrompt | null;
  prefs: Prefs;

  refreshHosts: () => Promise<void>;
  probe: () => Promise<void>;
  setView: (view: View) => void;
  setPrefs: (patch: Partial<Prefs>) => void;
  updateSession: (id: string, patch: Partial<Session>) => void;
  pushPrompt: (p: PendingPrompt) => void;
  answerPrompt: (requestId: number, reply: PromptReply) => void;
  dropPrompts: (owner: string) => void;
  askText: (opts: Omit<TextPrompt, "resolve">) => Promise<string | null>;
}

export const useStore = create<Store>((set, get) => ({
  hosts: [],
  groups: [],
  keys: [],
  keyPanel: null,
  probes: {},
  sessions: [],
  activeId: null,
  view: "hosts",
  selectedHostId: null,
  editor: null,
  query: "",
  groupFilter: null,
  paletteOpen: false,
  sidebarHidden: false,
  prompts: [],
  textPrompt: null,
  prefs: loadPrefs(),

  refreshHosts: async () => {
    // Keys ride along because their host counts change with host edits.
    const [hosts, groups, keys] = await Promise.all([api.listHosts(), api.listGroups(), api.listKeys()]);
    set((s) => ({
      hosts,
      groups,
      keys,
      keyPanel: s.keyPanel?.mode === "view" && !keys.some((k) => k.id === viewedKey(s.keyPanel)) ? null : s.keyPanel,
      selectedHostId: hosts.some((h) => h.id === s.selectedHostId) ? s.selectedHostId : null,
    }));
  },

  probe: async () => {
    const targets = get().hosts.map((h) => ({ id: h.id, address: h.address, port: h.port }));
    if (!targets.length) return;
    const results = await api.probeHosts(targets);
    set((s) => ({ probes: { ...s.probes, ...Object.fromEntries(results.map((r) => [r.id, r.latencyMs])) } }));
  },

  setView: (view) => set({ view, paletteOpen: false }),

  setPrefs: (patch) =>
    set((s) => {
      const prefs = { ...s.prefs, ...patch };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
      } catch {
        // Storage can be unavailable; prefs still apply for this run.
      }
      return { prefs };
    }),

  updateSession: (id, patch) =>
    set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, ...patch } : x)) })),

  pushPrompt: (p) => set((s) => ({ prompts: [...s.prompts, p] })),

  answerPrompt: (requestId, reply) => {
    void api.respondPrompt(requestId, reply);
    set((s) => ({ prompts: s.prompts.filter((p) => p.event.requestId !== requestId) }));
  },

  dropPrompts: (owner) => {
    for (const p of get().prompts) {
      if (p.owner === owner) void api.respondPrompt(p.event.requestId, { accept: false });
    }
    set((s) => ({ prompts: s.prompts.filter((p) => p.owner !== owner) }));
  },

  askText: (opts) =>
    new Promise((resolve) => {
      set({
        textPrompt: {
          ...opts,
          resolve: (value) => {
            set({ textPrompt: null });
            resolve(value);
          },
        },
      });
    }),
}));

export const hostById = (id: string | null | undefined) =>
  id ? useStore.getState().hosts.find((h) => h.id === id) : undefined;
