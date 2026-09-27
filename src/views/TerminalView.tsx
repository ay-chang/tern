import { useEffect, useLayoutEffect, useRef } from "react";
import { connectSftp } from "../lib/sftp";
import { useStore, type Session } from "../lib/store";
import { fit, focus, mount, reconnect } from "../lib/terminals";
import { HostBadge, sessionDot } from "../components/ui";

const STATE_LABEL: Record<Session["state"], string> = {
  connecting: "connecting",
  authenticating: "authenticating",
  connected: "connected",
  error: "failed",
  closed: "disconnected",
};

function TerminalPane({ id, active }: { id: string; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (ref.current) void mount(id, ref.current);
  }, [id]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => fit(id));
    ro.observe(el);
    return () => ro.disconnect();
  }, [id]);

  useEffect(() => {
    if (active) {
      fit(id);
      focus(id);
    }
  }, [active, id]);

  return <div ref={ref} className="term-pane" style={{ visibility: active ? "visible" : "hidden" }} />;
}

/**
 * Always mounted so terminals survive view switches; hidden when another view is showing.
 */
export function TerminalView({ visible }: { visible: boolean }) {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeId);
  const hosts = useStore((s) => s.hosts);
  const layout = useStore((s) => s.prefs.layout);
  const chrome = layout !== "focus";

  const active = sessions.find((s) => s.id === activeId);
  const host = hosts.find((h) => h.id === active?.hostId);
  const disconnected = active && (active.state === "error" || active.state === "closed");

  return (
    <div className={`term-view ${layout === "focus" ? "focus" : ""}`} style={{ display: visible && active ? "flex" : "none" }}>
      {chrome && host && active && (
        <div className="term-head">
          <HostBadge host={host} size={22} />
          <span style={{ fontWeight: 500 }}>{host.name}</span>
          <span className="mono" style={{ fontSize: 11.5, color: "var(--dd)" }}>
            {host.osName ?? ""}
          </span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
            {disconnected && (
              <button className="btn ghost sm" onClick={() => reconnect(active.id)}>
                Reconnect
              </button>
            )}
            <button
              className="btn ghost sm"
              onClick={() => {
                useStore.getState().setView("sftp");
                void connectSftp(host.id);
              }}
            >
              SFTP
            </button>
          </div>
        </div>
      )}
      <div className="term-body">
        {sessions.map((s) => (
          <TerminalPane key={s.id} id={s.id} active={visible && s.id === activeId} />
        ))}
      </div>
      {chrome && host && active && (
        <div className="status-bar">
          <span className="state" style={{ color: active.state === "connected" ? "var(--g)" : undefined }}>
            <span className="dot" style={{ background: sessionDot(active.state) }} />
            {STATE_LABEL[active.state]}
          </span>
          <span>
            {host.username}@{host.address}:{host.port}
          </span>
          {active.authLabel && <span>{active.authLabel}</span>}
          <span style={{ marginLeft: "auto" }}>UTF-8</span>
          <span>xterm-256color</span>
        </div>
      )}
    </div>
  );
}
