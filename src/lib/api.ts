import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  ConnectInfo,
  FileEntry,
  Group,
  HistoryEntry,
  Host,
  HostInput,
  KeyInfo,
  ProbeResult,
  SessionEvent,
} from "./types";

export interface PromptReply {
  accept: boolean;
  answers?: string[];
  save?: boolean;
}

export const api = {
  listHosts: () => invoke<Host[]>("list_hosts"),
  listGroups: () => invoke<Group[]>("list_groups"),
  /** `password`: undefined keeps the saved one, "" removes it. */
  saveHost: (input: HostInput, password?: string) => invoke<Host>("save_host", { input, password }),
  deleteHost: (id: string) => invoke<void>("delete_host", { id }),
  hostHistory: (id: string) => invoke<HistoryEntry[]>("host_history", { id }),
  listKeys: () => invoke<KeyInfo[]>("list_keys"),
  /** Pass the key's text as `privateKey`, or a file `path` for the backend to read. */
  importKey: (args: { name: string; privateKey?: string; path?: string; passphrase?: string }) =>
    invoke<KeyInfo>("import_key", args),
  generateKey: (name: string) => invoke<KeyInfo>("generate_key", { name }),
  renameKey: (id: string, name: string) => invoke<void>("rename_key", { id, name }),
  deleteKey: (id: string) => invoke<void>("delete_key", { id }),
  probeHosts: (targets: { id: string; address: string; port: number }[]) =>
    invoke<ProbeResult[]>("probe_hosts", { targets }),

  terminalOpen: (
    sessionId: string,
    hostId: string,
    cols: number,
    rows: number,
    onData: Channel<ArrayBuffer | number[]>,
    onEvent: Channel<SessionEvent>,
  ) => invoke<ConnectInfo>("terminal_open", { sessionId, hostId, cols, rows, onData, onEvent }),
  terminalWrite: (sessionId: string, data: string) => invoke<void>("terminal_write", { sessionId, data }),
  terminalResize: (sessionId: string, cols: number, rows: number) =>
    invoke<void>("terminal_resize", { sessionId, cols, rows }),
  terminalClose: (sessionId: string) => invoke<void>("terminal_close", { sessionId }),
  respondPrompt: (requestId: number, reply: PromptReply) => invoke<void>("respond_prompt", { requestId, reply }),

  sftpOpen: (sftpId: string, hostId: string, onEvent: Channel<SessionEvent>) =>
    invoke<{ home: string }>("sftp_open", { sftpId, hostId, onEvent }),
  sftpClose: (sftpId: string) => invoke<void>("sftp_close", { sftpId }),
  sftpList: (sftpId: string, path: string) => invoke<FileEntry[]>("sftp_list", { sftpId, path }),
  sftpMkdir: (sftpId: string, path: string) => invoke<void>("sftp_mkdir", { sftpId, path }),
  sftpRename: (sftpId: string, from: string, to: string) => invoke<void>("sftp_rename", { sftpId, from, to }),
  sftpRemove: (sftpId: string, path: string, isDir: boolean) =>
    invoke<void>("sftp_remove", { sftpId, path, isDir }),

  localHome: () => invoke<string>("local_home"),
  localList: (path: string) => invoke<FileEntry[]>("local_list", { path }),
  localMkdir: (path: string) => invoke<void>("local_mkdir", { path }),

  transferStart: (request: {
    id: string;
    sftpId: string;
    direction: "upload" | "download";
    source: string;
    destDir: string;
  }) => invoke<void>("transfer_start", { request }),
  transferCancel: (id: string) => invoke<void>("transfer_cancel", { id }),
};

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
