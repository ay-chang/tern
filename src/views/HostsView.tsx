import { useMemo } from "react";
import { colorVar } from "../lib/format";
import { useStore } from "../lib/store";
import { connectHost } from "../lib/terminals";
import type { Host } from "../lib/types";
import { HostBadge, useHostStatus } from "../components/ui";
import { HostDetail, HostEditor } from "./HostPanel";

function HostCard({ host, selected }: { host: Host; selected: boolean }) {
  const st = useHostStatus(host);
  return (
    <div
      className={`host-card ${selected ? "sel" : ""}`}
      onClick={() => useStore.setState({ selectedHostId: host.id, editor: null })}
      onDoubleClick={() => connectHost(host.id)}
    >
      <div className="host-card-top">
        <HostBadge host={host} />
        <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
          <div className="ellipsis" style={{ fontWeight: 500, fontSize: 13.5 }}>
            {host.name}
          </div>
          <div className="mono ellipsis muted" style={{ fontSize: 11.5 }}>
            {host.username}@{host.address}
            {host.port !== 22 ? `:${host.port}` : ""}
          </div>
        </div>
      </div>
      <div className="host-card-foot">
        {host.tags.slice(0, 3).map((t) => (
          <span key={t} className="chip">
            {t}
          </span>
        ))}
        <span className="host-status">
          <span className="dot" style={{ background: st.color }} />
          {st.text}
        </span>
      </div>
    </div>
  );
}

export function HostsView() {
  const hosts = useStore((s) => s.hosts);
  const groups = useStore((s) => s.groups);
  const probes = useStore((s) => s.probes);
  const query = useStore((s) => s.query);
  const groupFilter = useStore((s) => s.groupFilter);
  const selectedHostId = useStore((s) => s.selectedHostId);
  const editor = useStore((s) => s.editor);

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (h: Host) =>
      (!groupFilter || h.groupId === groupFilter) &&
      (!q || [h.name, h.address, h.username, ...h.tags].some((t) => t.toLowerCase().includes(q)));
    const list = [
      ...groups.map((g) => ({ key: g.id, name: g.name, color: colorVar(g.color), hosts: hosts.filter((h) => h.groupId === g.id && match(h)) })),
      { key: "_", name: groups.length ? "Ungrouped" : "All hosts", color: "var(--dd)", hosts: hosts.filter((h) => !h.groupId && match(h)) },
    ];
    return list.filter((s) => s.hosts.length);
  }, [hosts, groups, query, groupFilter]);

  const online = hosts.filter((h) => typeof probes[h.id] === "number").length;
  const groupName = groups.find((g) => g.id === groupFilter)?.name;
  const summary = `${hosts.length} ${hosts.length === 1 ? "host" : "hosts"} · ${online} online${groupName ? ` · showing ${groupName}` : ""}`;
  const selected = hosts.find((h) => h.id === selectedHostId);
  const newHost = () => useStore.setState({ editor: { hostId: null }, selectedHostId: null });

  return (
    <div className="hosts-split">
      {hosts.length === 0 ? (
        <div className="empty">
          <div className="logo" style={{ width: 40, height: 40, borderRadius: 11, fontSize: 16 }}>
            ›_
          </div>
          <h2>Add your first host</h2>
          <p>Save a server once, then connect with a double-click or from the command palette. Passwords go to your system keychain, never to disk.</p>
          <button className="btn primary" onClick={newHost}>
            New host
          </button>
        </div>
      ) : (
        <div className="page">
          <div className="page-head" style={{ gap: 16 }}>
            <div>
              <div className="page-title">Hosts</div>
              <div className="page-sub">{summary}</div>
            </div>
            <input
              className="input"
              style={{ marginLeft: "auto", width: 280 }}
              value={query}
              placeholder="Filter by name, address, tag"
              onChange={(e) => useStore.setState({ query: e.target.value })}
            />
            <button className="btn primary" onClick={newHost}>
              New host
            </button>
          </div>
          {sections.map((sec) => (
            <div key={sec.key} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="group-head">
                <span className="swatch" style={{ background: sec.color }} />
                <span>{sec.name}</span>
                <span className="kbd">{sec.hosts.length}</span>
              </div>
              <div className="host-grid">
                {sec.hosts.map((h) => (
                  <HostCard key={h.id} host={h} selected={h.id === selectedHostId} />
                ))}
              </div>
            </div>
          ))}
          {sections.length === 0 && <div className="muted" style={{ padding: "40px 0" }}>No hosts match “{query}”.</div>}
        </div>
      )}
      {editor ? <HostEditor hostId={editor.hostId} /> : selected ? <HostDetail host={selected} /> : null}
    </div>
  );
}
