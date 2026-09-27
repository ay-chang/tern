import type { Group, GroupColor, Host, KeyInfo } from "./types";

export const colorVar = (c: GroupColor | "mu") => `var(--${c})`;

const OS_BADGES: Record<string, [string, GroupColor]> = {
  ubuntu: ["UB", "a"],
  debian: ["DB", "r"],
  alpine: ["AL", "b"],
  raspbian: ["PI", "p"],
  truenas: ["TN", "g"],
  fedora: ["FE", "b"],
  centos: ["CE", "p"],
  rhel: ["RH", "r"],
  rocky: ["RK", "g"],
  almalinux: ["AL", "b"],
  arch: ["AR", "b"],
  manjaro: ["MJ", "g"],
  nixos: ["NX", "b"],
  opensuse: ["SU", "g"],
  "opensuse-leap": ["SU", "g"],
  "opensuse-tumbleweed": ["SU", "g"],
  amzn: ["AZ", "a"],
  freebsd: ["BS", "r"],
  macos: ["MC", "p"],
};

function initials(name: string): string {
  const parts = name.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0] ?? name).slice(0, 2).toUpperCase() || "··";
}

export interface Badge {
  text: string;
  bg: string;
  fg: string;
}

/** The two-letter tile from the design. Known OSes get a color; others use the host's initials. */
export function hostBadge(host: Host): Badge {
  const known = host.osId ? OS_BADGES[host.osId] : undefined;
  if (known) {
    const c = colorVar(known[1]);
    return { text: known[0], bg: `color-mix(in oklch, ${c} 16%, transparent)`, fg: c };
  }
  const text = host.osId ? host.osId.slice(0, 2).toUpperCase() : initials(host.name);
  return { text, bg: "var(--sel)", fg: "var(--mu)" };
}

export function groupColor(groups: Group[], id: string | null): string {
  const g = groups.find((x) => x.id === id);
  return g ? colorVar(g.color) : "var(--dd)";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "Today", "Sep 24", or "Sep 24, 2023" for file listings. */
export function formatDay(unix: number | null): string {
  if (unix == null) return "—";
  const d = new Date(unix * 1000);
  const now = new Date();
  if (sameDay(d, now)) return "Today";
  const base = `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, "0")}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}

/** "Today, 18:42", "Yesterday, 10:15", "Sep 23, 16:02" for session history. */
export function formatWhen(unix: number): string {
  const d = new Date(unix * 1000);
  const now = new Date();
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (sameDay(d, now)) return `Today, ${time}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return `Yesterday, ${time}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${time}`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function authLabel(host: Host, keys: KeyInfo[]): string {
  if (host.auth === "key") {
    const key = keys.find((k) => k.id === host.keyId);
    if (key) return `${key.name} · ${key.algorithm}`;
    return host.keyPath ?? "Key file";
  }
  if (host.auth === "password") return host.hasPassword ? "Password · saved" : "Password";
  return host.hasPassword ? "Agent & keys · password saved" : "Agent & default keys";
}

/** "Mar 2026", as in the design's keychain table. */
export function formatMonth(unix: number): string {
  const d = new Date(unix * 1000);
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
