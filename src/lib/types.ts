export type AuthMode = "auto" | "password" | "key";
export type GroupColor = "r" | "a" | "b" | "g" | "p";

export interface Host {
  id: string;
  name: string;
  address: string;
  port: number;
  username: string;
  groupId: string | null;
  auth: AuthMode;
  keyPath: string | null;
  /** A key from the keychain; takes precedence over keyPath. */
  keyId: string | null;
  tags: string[];
  osId: string | null;
  osName: string | null;
  hasPassword: boolean;
  createdAt: number;
  updatedAt: number;
  lastConnectedAt: number | null;
}

export interface Group {
  id: string;
  name: string;
  color: GroupColor;
}

export interface HostInput {
  id?: string;
  name: string;
  address: string;
  port: number;
  username: string;
  groupName: string | null;
  auth: AuthMode;
  keyPath: string | null;
  keyId: string | null;
  tags: string[];
}

export interface KeyInfo {
  id: string;
  name: string;
  /** e.g. "ED25519", "RSA 4096", "ECDSA P-256" */
  algorithm: string;
  fingerprint: string;
  /** OpenSSH public key line, ready for authorized_keys. */
  publicKey: string;
  /** Protected by a passphrase (which is saved alongside it). */
  encrypted: boolean;
  hostCount: number;
  createdAt: number;
}

export interface HistoryEntry {
  startedAt: number;
  endedAt: number | null;
}

export interface ProbeResult {
  id: string;
  latencyMs: number | null;
}

export type ConnState = "connecting" | "authenticating" | "connected" | "error" | "closed";

export interface HostKeyEvent {
  type: "hostKey";
  requestId: number;
  status: "unknown" | "changed";
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  canReplace: boolean;
}

export interface PromptEvent {
  type: "prompt";
  requestId: number;
  title: string;
  instructions: string;
  fields: { label: string; secret: boolean }[];
  allowSave: boolean;
}

export type SessionEvent =
  | { type: "status"; state: ConnState; message: string }
  | HostKeyEvent
  | PromptEvent
  | { type: "banner"; text: string }
  | { type: "exit"; code: number | null };

export interface ConnectInfo {
  authLabel: string;
  fingerprint: string;
}

export interface FileEntry {
  name: string;
  path: string;
  kind: "dir" | "file" | "link" | "other";
  isDir: boolean;
  size: number;
  modified: number | null;
  executable: boolean;
}

export interface TransferEvent {
  id: string;
  direction: "upload" | "download";
  name: string;
  dest: string;
  bytes: number;
  total: number;
  state: "running" | "done" | "failed" | "cancelled";
  error: string | null;
}

export type View = "hosts" | "term" | "sftp" | "keys" | "settings";
export type Layout = "sidebar" | "rail" | "minimal" | "focus";
export type ThemePref = "dark" | "light" | "system";
export type CursorStyle = "block" | "bar" | "underline";

export interface Prefs {
  theme: ThemePref;
  layout: Layout;
  fontSize: number;
  cursor: CursorStyle;
  scrollback: number;
  /** Terminal line height as a multiple of the font size. */
  lineHeight: number;
  /** Color log levels, timestamps, JSON and the like in plain output. */
  highlight: boolean;
}
