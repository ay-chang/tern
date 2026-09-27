import { useEffect, useMemo, useRef, useState } from "react";
import { connectSftp } from "../lib/sftp";
import { useStore } from "../lib/store";
import { connectHost, openSession } from "../lib/terminals";
import type { View } from "../lib/types";

interface Item {
  key: string;
  label: string;
  hint: string;
  color: string;
  round: boolean;
  run: () => void;
}

export function Palette() {
  const hosts = useStore((s) => s.hosts);
  const sessions = useStore((s) => s.sessions);
  const probes = useStore((s) => s.probes);
  const highlight = useStore((s) => s.prefs.highlight);
  const [q, setQ] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => useStore.setState({ paletteOpen: false });

  useEffect(() => inputRef.current?.focus(), []);

  const items = useMemo(() => {
    const go = (view: View) => () => useStore.getState().setView(view);
    const dot = (id: string) =>
      sessions.some((s) => s.hostId === id && s.state === "connected") || typeof probes[id] === "number"
        ? "var(--g)"
        : probes[id] === null
          ? "var(--off)"
          : "var(--dd)";
    const all: Item[] = [
      ...hosts.map((h) => ({
        key: `c${h.id}`,
        label: sessions.some((s) => s.hostId === h.id) ? `Switch to ${h.name}` : `Connect to ${h.name}`,
        hint: `${h.username}@${h.address}`,
        color: dot(h.id),
        round: true,
        run: () => connectHost(h.id),
      })),
      ...hosts
        .filter((h) => sessions.some((s) => s.hostId === h.id))
        .map((h) => ({
          key: `n${h.id}`,
          label: `New session to ${h.name}`,
          hint: `${h.username}@${h.address}`,
          color: dot(h.id),
          round: true,
          run: () => openSession(h.id),
        })),
      ...hosts.map((h) => ({
        key: `f${h.id}`,
        label: `Browse files on ${h.name}`,
        hint: "sftp",
        color: "var(--b)",
        round: false,
        run: () => {
          useStore.getState().setView("sftp");
          void connectSftp(h.id);
        },
      })),
      {
        key: "new",
        label: "New host",
        hint: "hosts",
        color: "var(--p)",
        round: false,
        run: () => useStore.setState({ view: "hosts", editor: { hostId: null }, selectedHostId: null, paletteOpen: false }),
      },
      {
        key: "highlight",
        label: highlight ? "Turn off output highlighting" : "Turn on output highlighting",
        hint: "terminal",
        color: "var(--a)",
        round: false,
        run: () => useStore.getState().setPrefs({ highlight: !highlight }),
      },
      {
        key: "import-key",
        label: "Import a key",
        hint: "keychain",
        color: "var(--g)",
        round: false,
        run: () => useStore.setState({ view: "keys", keyPanel: { mode: "import" }, paletteOpen: false }),
      },
      {
        key: "generate-key",
        label: "Generate a key",
        hint: "keychain",
        color: "var(--g)",
        round: false,
        run: () => useStore.setState({ view: "keys", keyPanel: { mode: "generate" }, paletteOpen: false }),
      },
      ...(
        [
          ["hosts", "Hosts"],
          ["sftp", "SFTP"],
          ["keys", "Keychain"],
          ["settings", "Settings"],
        ] as [View, string][]
      ).map(([v, l]) => ({ key: `g${v}`, label: `Go to ${l}`, hint: "view", color: "var(--dm)", round: false, run: go(v) })),
    ];
    const needle = q.trim().toLowerCase();
    if (!needle) return all.slice(0, 40);
    // Prefer items where a word starts with the query ("pi" → pi-hole before api-prod).
    const score = (it: Item) => {
      const text = `${it.label} ${it.hint}`.toLowerCase();
      if (!text.includes(needle)) return -1;
      return text.split(/[\s@.\-_]+/).some((w) => w.startsWith(needle)) ? 2 : 1;
    };
    return all
      .map((it, i) => ({ it, i, s: score(it) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .map((x) => x.it)
      .slice(0, 40);
  }, [hosts, sessions, probes, highlight, q]);

  const current = Math.min(index, Math.max(0, items.length - 1));

  useEffect(() => {
    listRef.current?.children[current]?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const run = (it: Item | undefined) => {
    if (!it) return;
    close();
    it.run();
  };

  return (
    <div className="scrim" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={q}
          placeholder={hosts.length ? "Connect to a host, open a view…" : "Add a host to get started…"}
          onChange={(e) => {
            setQ(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex(Math.min(current + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex(Math.max(current - 1, 0));
            } else if (e.key === "Enter") {
              run(items[current]);
            } else if (e.key === "Escape") {
              close();
            }
          }}
        />
        <div className="palette-list" ref={listRef}>
          {items.map((it, i) => (
            <div key={it.key} className={`palette-item ${i === current ? "on" : ""}`} onMouseEnter={() => setIndex(i)} onClick={() => run(it)}>
              <span className="dot" style={{ background: it.color, borderRadius: it.round ? "50%" : 2 }} />
              <span style={{ flex: 1 }} className="ellipsis">
                {it.label}
              </span>
              <span className="hint">{it.hint}</span>
            </div>
          ))}
          {items.length === 0 && <div className="pane-msg">Nothing matches “{q}”.</div>}
        </div>
        <div className="palette-foot">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
