import { Channel } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { create } from "zustand";

import { api, errorText } from "./api";
import { hostById, useStore } from "./store";
import type { FileEntry, SessionEvent, TransferEvent } from "./types";

export type Side = "local" | "remote";

export interface PaneState {
  path: string;
  entries: FileEntry[];
  loading: boolean;
  error: string | null;
  selected: string | null;
}

interface SftpStore {
  hostId: string | null;
  sftpId: string | null;
  status: "idle" | "connecting" | "connected" | "error";
  error: string | null;
  local: PaneState;
  remote: PaneState;
  transfers: TransferEvent[];
}

const emptyPane = (): PaneState => ({ path: "", entries: [], loading: false, error: null, selected: null });

export const useSftp = create<SftpStore>(() => ({
  hostId: null,
  sftpId: null,
  status: "idle",
  error: null,
  local: emptyPane(),
  remote: emptyPane(),
  transfers: [],
}));

const patchPane = (side: Side, patch: Partial<PaneState>) =>
  useSftp.setState((s) => ({ [side]: { ...s[side], ...patch } }) as Partial<SftpStore>);

export function parentPath(side: Side, path: string): string {
  if (side === "local" && /^[A-Za-z]:\\?$/.test(path)) return path;
  const sep = side === "local" && path.includes("\\") ? "\\" : "/";
  const trimmed = path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
  const idx = trimmed.lastIndexOf(sep);
  if (idx <= 0) return sep === "/" ? "/" : trimmed.slice(0, 3);
  return trimmed.slice(0, idx);
}

export function joinPath(side: Side, dir: string, name: string): string {
  const sep = side === "local" && dir.includes("\\") ? "\\" : "/";
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

export async function listPane(side: Side, path: string) {
  const { sftpId } = useSftp.getState();
  if (side === "remote" && !sftpId) return;
  patchPane(side, { loading: true, error: null });
  try {
    const entries = side === "local" ? await api.localList(path) : await api.sftpList(sftpId!, path);
    patchPane(side, { path, entries, loading: false, selected: null });
  } catch (e) {
    patchPane(side, { loading: false, error: errorText(e) });
  }
}

export async function initLocal() {
  if (useSftp.getState().local.path) return;
  await listPane("local", await api.localHome());
}

export async function connectSftp(hostId: string) {
  const current = useSftp.getState();
  if (current.hostId === hostId && (current.status === "connected" || current.status === "connecting")) return;
  await disconnectSftp();

  const host = hostById(hostId);
  if (!host) return;
  const sftpId = crypto.randomUUID();
  useSftp.setState({ hostId, sftpId, status: "connecting", error: null, remote: emptyPane() });

  const events = new Channel<SessionEvent>();
  events.onmessage = (ev) => {
    if (ev.type === "hostKey" || ev.type === "prompt") {
      useStore.getState().pushPrompt({ owner: sftpId, hostName: host.name, event: ev });
    }
  };
  try {
    const { home } = await api.sftpOpen(sftpId, hostId, events);
    if (useSftp.getState().sftpId !== sftpId) return;
    useSftp.setState({ status: "connected" });
    await listPane("remote", home);
  } catch (e) {
    if (useSftp.getState().sftpId !== sftpId) return;
    useSftp.setState({ status: "error", error: errorText(e) });
  }
}

export async function disconnectSftp() {
  const { sftpId } = useSftp.getState();
  if (!sftpId) return;
  useStore.getState().dropPrompts(sftpId);
  useSftp.setState({ sftpId: null, hostId: null, status: "idle", error: null, remote: emptyPane() });
  await api.sftpClose(sftpId);
}

export function select(side: Side, path: string | null) {
  patchPane(side, { selected: path });
}

export function selectedEntry(side: Side): FileEntry | undefined {
  const pane = useSftp.getState()[side];
  return pane.entries.find((e) => e.path === pane.selected);
}

/** Copies `entry` into the other pane's current directory. */
export async function transfer(from: Side, entry: FileEntry, destDir?: string) {
  const s = useSftp.getState();
  if (!s.sftpId || s.status !== "connected") return;
  const to: Side = from === "local" ? "remote" : "local";
  const dir = destDir ?? s[to].path;
  if (!dir) return;

  if (dir === s[to].path && s[to].entries.some((e) => e.name === entry.name)) {
    const ok = await confirm(`“${entry.name}” already exists in ${dir}. Replace it?`, {
      title: "Replace file",
      kind: "warning",
      okLabel: "Replace",
    });
    if (!ok) return;
  }
  await api.transferStart({
    id: crypto.randomUUID(),
    sftpId: s.sftpId,
    direction: from === "local" ? "upload" : "download",
    source: entry.path,
    destDir: dir,
  });
}

export async function newFolder(side: Side) {
  const s = useSftp.getState();
  const dir = s[side].path;
  if (!dir) return;
  const name = await useStore.getState().askText({
    title: "New folder",
    label: `Create in ${dir}`,
    value: "",
    confirmLabel: "Create",
  });
  if (!name) return;
  try {
    const path = joinPath(side, dir, name);
    if (side === "local") await api.localMkdir(path);
    else await api.sftpMkdir(s.sftpId!, path);
    await listPane(side, dir);
  } catch (e) {
    patchPane(side, { error: errorText(e) });
  }
}

export async function renameRemote(entry: FileEntry) {
  const s = useSftp.getState();
  const name = await useStore.getState().askText({
    title: "Rename",
    label: entry.path,
    value: entry.name,
    confirmLabel: "Rename",
  });
  if (!name || name === entry.name || !s.sftpId) return;
  try {
    await api.sftpRename(s.sftpId, entry.path, joinPath("remote", parentPath("remote", entry.path), name));
    await listPane("remote", s.remote.path);
  } catch (e) {
    patchPane("remote", { error: errorText(e) });
  }
}

export async function deleteRemote(entry: FileEntry) {
  const s = useSftp.getState();
  if (!s.sftpId) return;
  const what = entry.isDir && entry.kind === "dir" ? "folder and everything in it" : "file";
  const ok = await confirm(`Delete “${entry.name}”? This ${what} will be permanently removed from the server.`, {
    title: "Delete",
    kind: "warning",
    okLabel: "Delete",
  });
  if (!ok) return;
  try {
    await api.sftpRemove(s.sftpId, entry.path, entry.kind === "dir");
    await listPane("remote", s.remote.path);
  } catch (e) {
    patchPane("remote", { error: errorText(e) });
  }
}

export function onTransferEvent(ev: TransferEvent) {
  useSftp.setState((s) => {
    // Update in place so rows don't jump around on every progress tick.
    const known = s.transfers.some((t) => t.id === ev.id);
    const transfers = known ? s.transfers.map((t) => (t.id === ev.id ? ev : t)) : [ev, ...s.transfers];
    return { transfers: transfers.slice(0, 30) };
  });
  if (ev.state !== "done") return;
  const s = useSftp.getState();
  if (ev.direction === "upload" && ev.dest === s.remote.path) void listPane("remote", s.remote.path);
  if (ev.direction === "download" && ev.dest === s.local.path) void listPane("local", s.local.path);
}

export function clearFinishedTransfers() {
  useSftp.setState((s) => ({ transfers: s.transfers.filter((t) => t.state === "running") }));
}
