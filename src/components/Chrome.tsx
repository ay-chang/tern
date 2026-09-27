import { useMemo } from "react";
import { credentialStoreName, shortcut } from "../lib/platform";
import { useStore } from "../lib/store";
import { closeSession, connectHost } from "../lib/terminals";
import { colorVar } from "../lib/format";
import type { View } from "../lib/types";
import { HostBadge, HostDot, sessionDot, SidebarGlyph } from "./ui";

const NAV: { view: Exclude<View, "term">; label: string; abbr: string }[] = [
  { view: "hosts", label: "Hosts", abbr: "H" },
  { view: "sftp", label: "SFTP", abbr: "F" },
  { view: "keys", label: "Keychain", abbr: "K" },
  { view: "settings", label: "Settings", abbr: "⚙︎" },
];

const openPalette = () => useStore.setState({ paletteOpen: true });

function useNav() {
  const view = useStore((s) => s.view);
  const groupFilter = useStore((s) => s.groupFilter);
  const hostCount = useStore((s) => s.hosts.length);
  const keyCount = useStore((s) => s.keys.length);
  return NAV.map((n) => ({
    ...n,
    active: view === n.view && !(n.view === "hosts" && groupFilter),
    count: n.view === "hosts" ? String(hostCount) : n.view === "keys" && keyCount ? String(keyCount) : "",
    go: () => useStore.setState({ view: n.view, groupFilter: null, paletteOpen: false }),
  }));
}

export function Sidebar() {
  const nav = useNav();
  const groups = useStore((s) => s.groups);
  const hosts = useStore((s) => s.hosts);
  const view = useStore((s) => s.view);
  const groupFilter = useStore((s) => s.groupFilter);

  return (
    <aside className="sidebar">
      <div className="sidebar-head" data-tauri-drag-region>
        <div className="logo">›_</div>
        <div className="brand">Tern</div>
        <button
          className="icon-btn"
          style={{ marginLeft: "auto" }}
          title={`Hide sidebar (${shortcut("B")})`}
          onClick={() => useStore.setState({ sidebarHidden: true })}
        >
          <SidebarGlyph />
        </button>
      </div>
      <button className="search-btn" onClick={openPalette}>
        <span style={{ flex: 1 }}>Search or jump to…</span>
        <span className="kbd">{shortcut("K")}</span>
      </button>
      <nav className="nav">
        {nav.map((n) => (
          <div key={n.view} className={`nav-item ${n.active ? "active" : ""}`} onClick={n.go}>
            <span>{n.label}</span>
            <span className="count">{n.count}</span>
          </div>
        ))}
      </nav>
      {groups.length > 0 && (
        <div className="nav">
          <div className="caps" style={{ padding: "0 10px 6px" }}>
            Groups
          </div>
          {groups.map((g) => {
            const active = view === "hosts" && groupFilter === g.id;
            return (
              <div
                key={g.id}
                className={`nav-item small ${active ? "active" : ""}`}
                onClick={() =>
                  useStore.setState((s) => ({
                    view: "hosts",
                    groupFilter: s.groupFilter === g.id && s.view === "hosts" ? null : g.id,
                  }))
                }
              >
                <span className="swatch" style={{ background: colorVar(g.color) }} />
                <span className="ellipsis">{g.name}</span>
                <span className="count">{hosts.filter((h) => h.groupId === g.id).length}</span>
              </div>
            );
          })}
        </div>
      )}
      <div className="vault-card">
        <div className="row">
          <span className="dot" style={{ width: 7, height: 7, background: "var(--g)" }} />
          <span style={{ fontWeight: 500 }}>Local vault</span>
          <span className="kbd" style={{ marginLeft: "auto", fontSize: 10.5 }}>
            ON DEVICE
          </span>
        </div>
        <div className="desc">Hosts stay on this computer. Passwords are kept in the {credentialStoreName}.</div>
      </div>
    </aside>
  );
}

export function Rail() {
  const nav = useNav();
  const hosts = useStore((s) => s.hosts);
  const groups = useStore((s) => s.groups);
  const query = useStore((s) => s.query);
  const activeHost = useStore((s) => (s.view === "term" ? s.sessions.find((x) => x.id === s.activeId)?.hostId : null));

  const sections = useMemo(() => {
    const q = query.toLowerCase();
    const match = (h: (typeof hosts)[number]) =>
      !q || [h.name, h.address, h.username, ...h.tags].some((t) => t.toLowerCase().includes(q));
    const list = [
      ...groups.map((g) => ({ key: g.id, name: g.name, color: colorVar(g.color), hosts: hosts.filter((h) => h.groupId === g.id && match(h)) })),
      { key: "_", name: "Ungrouped", color: "var(--dd)", hosts: hosts.filter((h) => !h.groupId && match(h)) },
    ];
    return list.filter((s) => s.hosts.length);
  }, [hosts, groups, query]);

  return (
    <>
      <aside className="rail" data-tauri-drag-region>
        <div className="logo">›_</div>
        {nav.map((n) => (
          <div
            key={n.view}
            className={`rail-item ${n.active ? "active" : ""}`}
            title={n.label}
            style={n.view === "settings" ? { marginTop: "auto" } : undefined}
            onClick={n.go}
          >
            {n.abbr}
          </div>
        ))}
      </aside>
      <aside className="host-column">
        <div className="host-column-head" data-tauri-drag-region>
          <span style={{ fontWeight: 600 }}>Tern</span>
          <button className="kbd-pill" style={{ marginLeft: "auto" }} onClick={openPalette}>
            {shortcut("K")}
          </button>
        </div>
        <div style={{ padding: "12px 12px 4px" }}>
          <input
            className="input sm"
            value={query}
            placeholder="Filter hosts"
            onChange={(e) => useStore.setState({ query: e.target.value })}
          />
        </div>
        <div className="host-column-list">
          {sections.map((sec) => (
            <div key={sec.key} style={{ display: "flex", flexDirection: "column", gap: 1 }}>
              <div className="caps" style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px 6px" }}>
                <span className="swatch" style={{ width: 6, height: 6, background: sec.color }} />
                {sec.name}
              </div>
              {sec.hosts.map((h) => (
                <div key={h.id} className={`host-row ${activeHost === h.id ? "active" : ""}`} onClick={() => connectHost(h.id)}>
                  <HostBadge host={h} size={24} />
                  <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 500 }} className="ellipsis">
                      {h.name}
                    </span>
                    <span className="mono ellipsis muted" style={{ fontSize: 10.5 }}>
                      {h.address}
                    </span>
                  </div>
                  <HostDot host={h} />
                </div>
              ))}
            </div>
          ))}
          {hosts.length === 0 && (
            <div className="muted" style={{ padding: "8px 10px", lineHeight: 1.5 }}>
              No hosts yet.{" "}
              <a href="#" onClick={(e) => (e.preventDefault(), useStore.setState({ view: "hosts", editor: { hostId: null } }))}>
                Add one
              </a>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

export function TopBar() {
  const layout = useStore((s) => s.prefs.layout);
  const sidebarHidden = useStore((s) => s.sidebarHidden);
  const view = useStore((s) => s.view);
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeId);
  const hosts = useStore((s) => s.hosts);
  const nav = useNav();

  const sideClosed = layout === "sidebar" && sidebarHidden;
  const padLights = layout === "minimal" || layout === "focus" || sideClosed;
  const focusTerm = layout === "focus" && view === "term";

  return (
    <div className={`topbar ${padLights ? "pad-lights" : ""} ${focusTerm ? "focus-term" : ""}`} data-tauri-drag-region>
      {sideClosed && (
        <button
          className="icon-btn"
          style={{ width: 30, height: 30, marginRight: 6 }}
          title={`Show sidebar (${shortcut("B")})`}
          onClick={() => useStore.setState({ sidebarHidden: false })}
        >
          <SidebarGlyph />
        </button>
      )}
      {layout === "minimal" && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 10px 0 6px" }}>
            <div className="logo" style={{ width: 22, height: 22, borderRadius: 6, fontSize: 10 }}>
              ›_
            </div>
            <span style={{ fontWeight: 600 }}>Tern</span>
          </div>
          <div className="topbar-nav">
            {nav.map((n) => (
              <span key={n.view} className={n.active ? "active" : ""} onClick={n.go}>
                {n.label}
              </span>
            ))}
          </div>
          <span className="vsep" />
        </>
      )}
      {layout === "focus" && view !== "term" && (
        <>
          <div className="topbar-nav">
            {nav.map((n) => (
              <span key={n.view} className={n.active ? "active" : ""} onClick={n.go}>
                {n.label}
              </span>
            ))}
          </div>
          {sessions.length > 0 && <span className="vsep" />}
        </>
      )}
      <div className="tabs">
        {sessions.map((x) => {
          const h = hosts.find((hh) => hh.id === x.hostId);
          const on = view === "term" && x.id === activeId;
          return (
            <div
              key={x.id}
              className={`tab ${on ? "active" : ""}`}
              onClick={() => useStore.setState({ activeId: x.id, view: "term" })}
              onAuxClick={(e) => e.button === 1 && closeSession(x.id)}
              title={h ? `${h.username}@${h.address}` : undefined}
            >
              <span className="dot" style={{ background: sessionDot(x.state) }} />
              <span>{h?.name ?? "session"}</span>
              <span
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeSession(x.id);
                }}
              >
                ×
              </span>
            </div>
          );
        })}
      </div>
      <button className="plus-btn" title={`New connection (${shortcut("T")})`} onClick={openPalette}>
        +
      </button>
      <div className="drag-fill" data-tauri-drag-region />
      {layout === "focus" && (
        <span className="focus-k" onClick={openPalette}>
          {shortcut("K")}
        </span>
      )}
      {layout === "minimal" && (
        <button className="search-btn" onClick={openPalette}>
          <span>Search or jump to…</span>
          <span className="kbd">{shortcut("K")}</span>
        </button>
      )}
    </div>
  );
}

/** The left-hand navigation for the chosen layout; Minimal and Focus have none. */
export function Chrome() {
  const layout = useStore((s) => s.prefs.layout);
  const sidebarHidden = useStore((s) => s.sidebarHidden);
  if (layout === "sidebar" && !sidebarHidden) return <Sidebar />;
  if (layout === "rail") return <Rail />;
  return null;
}
Chrome.Top = TopBar;
