import type { Badge } from "../lib/format";
import type { Host } from "../lib/types";
import { hostBadge } from "../lib/format";
import { useStore } from "../lib/store";

export function Seg<T extends string>(props: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg">
      {props.options.map((o) => (
        <span key={o.value} className={o.value === props.value ? "on" : ""} onClick={() => props.onChange(o.value)}>
          {o.label}
        </span>
      ))}
    </div>
  );
}

export function Toggle(props: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={`toggle ${props.on ? "on" : ""}`} onClick={() => props.onChange(!props.on)}>
      <span />
    </button>
  );
}

export function Stepper(props: { text: string; onDec: () => void; onInc: () => void }) {
  return (
    <div className="stepper">
      <span onClick={props.onDec}>−</span>
      <b>{props.text}</b>
      <span onClick={props.onInc}>+</span>
    </div>
  );
}

export function HostBadge({ host, size }: { host: Host; size?: 22 | 24 | 42 }) {
  const b: Badge = hostBadge(host);
  return (
    <div className={`badge ${size ? `s${size}` : ""}`} style={{ background: b.bg, color: b.fg }}>
      {b.text}
    </div>
  );
}

export function SidebarGlyph() {
  return (
    <span className="sidebar-glyph">
      <span />
    </span>
  );
}

/** Status dot + label for a host, from live sessions first, then the reachability probe. */
export function useHostStatus(host: Host) {
  const probe = useStore((s) => s.probes[host.id]);
  const connected = useStore((s) => s.sessions.some((x) => x.hostId === host.id && x.state === "connected"));
  if (connected) return { color: "var(--g)", text: probe != null ? `${probe} ms` : "connected", online: true };
  if (probe === undefined) return { color: "var(--dd)", text: "—", online: false };
  if (probe === null) return { color: "var(--off)", text: "offline", online: false };
  return { color: "var(--g)", text: `${probe} ms`, online: true };
}

export function HostDot({ host }: { host: Host }) {
  const st = useHostStatus(host);
  return <span className="dot" style={{ background: st.color }} />;
}

export const sessionDot = (state: string) =>
  state === "connected"
    ? "var(--g)"
    : state === "connecting" || state === "authenticating"
      ? "var(--a)"
      : state === "error"
        ? "var(--r)"
        : "var(--off)";
