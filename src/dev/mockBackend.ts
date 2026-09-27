/**
 * A fake backend so the UI can be developed in a plain browser (`npm run dev`)
 * without Rust or a real server. Only loaded in dev when Tauri isn't present.
 * The data mirrors the sample content in design/Tern.dc.html.
 */
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { FileEntry, Group, Host, HostInput, KeyInfo } from "../lib/types";

type Args = Record<string, any>;
interface MockChannel {
  id: number;
}

const internals = () => (window as any).__TAURI_INTERNALS__;
const channelIndex = new Map<number, number>();
function send(ch: MockChannel, message: unknown) {
  const index = channelIndex.get(ch.id) ?? 0;
  channelIndex.set(ch.id, index + 1);
  internals().runCallback(ch.id, { index, message });
}
function emit(event: string, payload: unknown) {
  void internals().invoke("plugin:event|emit", { event, payload });
}
const enc = new TextEncoder();
const bytes = (s: string) => Array.from(enc.encode(s));
const now = () => Math.floor(Date.now() / 1000);

const groups: Group[] = [
  { id: "g1", name: "Production", color: "r" },
  { id: "g2", name: "Staging", color: "a" },
  { id: "g3", name: "Homelab", color: "b" },
];
const H = (id: string, name: string, address: string, username: string, port: number, osId: string | null, osName: string | null, groupId: string, tags: string[]): Host => ({
  id, name, address, username, port, osId, osName, groupId, tags,
  auth: "auto", keyPath: null, keyId: null, hasPassword: false, createdAt: now(), updatedAt: now(), lastConnectedAt: null,
});
let hosts: Host[] = [
  H("h1", "api-prod-01", "10.0.1.12", "deploy", 22, "ubuntu", "Ubuntu 24.04", "g1", ["api", "docker"]),
  H("h2", "api-prod-02", "10.0.1.13", "deploy", 22, "ubuntu", "Ubuntu 24.04", "g1", ["api", "docker"]),
  H("h3", "db-primary", "10.0.2.4", "postgres", 22, "debian", "Debian 12", "g1", ["postgres"]),
  H("h4", "bastion", "bastion.tern.dev", "ops", 2222, "alpine", "Alpine 3.20", "g1", ["jump"]),
  H("h5", "staging-web", "10.8.0.21", "deploy", 22, "ubuntu", "Ubuntu 22.04", "g2", ["web"]),
  H("h6", "staging-worker", "10.8.0.22", "deploy", 22, null, null, "g2", ["queue"]),
  H("h7", "pi-hole", "192.168.1.4", "pi", 22, "raspbian", "Raspberry Pi OS", "g3", ["dns"]),
  H("h8", "truenas", "192.168.1.10", "root", 22, "truenas", "TrueNAS 24.04", "g3", ["storage"]),
];
const month = (y: number, m: number) => Math.floor(new Date(y, m - 1, 15).getTime() / 1000);
const fakePub = (alg: string, name: string) =>
  `${alg} AAAAC3NzaC1lZDI1NTE5AAAAI${Math.random().toString(36).slice(2, 12)}Q7mZp0vT2c7Yw1kRbN4xUa6sEe9aKxLp4Tn9 ${name}`;
let keys: KeyInfo[] = [
  { id: "k1", name: "deploy-ed25519", algorithm: "ED25519", fingerprint: "SHA256:q3Fh8LmZp0vT2c7Yw1kRbN4xUa6sEe9aKx", publicKey: fakePub("ssh-ed25519", "deploy-ed25519"), encrypted: false, hostCount: 0, createdAt: month(2026, 3) },
  { id: "k2", name: "yubikey-5c", algorithm: "ECDSA-SK", fingerprint: "SHA256:Vd7Qk2mPz8nL0tR5wXc3bY1hJ6gF4sA9eUo", publicKey: fakePub("sk-ecdsa-sha2-nistp256@openssh.com", "yubikey-5c"), encrypted: false, hostCount: 0, createdAt: month(2026, 1) },
  { id: "k3", name: "homelab", algorithm: "ED25519", fingerprint: "SHA256:Lp4Tn9Xe2Wq7Kc1Zr6Mb3Vy8Hd5Gf0Js2Aa", publicKey: fakePub("ssh-ed25519", "homelab"), encrypted: true, hostCount: 0, createdAt: month(2025, 11) },
  { id: "k4", name: "legacy-rsa", algorithm: "RSA 4096", fingerprint: "SHA256:Zx1Cv2Bn3Mm4Aa5Ss6Dd7Ff8Gg9Hh0Jj1Kk", publicKey: fakePub("ssh-rsa", "legacy-rsa"), encrypted: false, hostCount: 0, createdAt: month(2023, 2) },
];
for (const [hid, kid] of [["h1", "k1"], ["h2", "k1"], ["h3", "k1"], ["h5", "k1"], ["h6", "k1"], ["h4", "k2"], ["h8", "k3"]]) {
  const h = hosts.find((x) => x.id === hid)!;
  h.auth = "key";
  h.keyId = kid;
}
const withCounts = () => keys.map((k) => ({ ...k, hostCount: hosts.filter((h) => h.keyId === k.id).length }));

const latency: Record<string, number | null> = { h1: 23, h2: 25, h3: 31, h4: 18, h5: 41, h6: null, h7: 2, h8: 1 };
const trusted = new Set(["h1", "h2", "h3", "h4", "h5", "h8"]);

const DIM = "\x1b[38;2;107;105;101m";
const G = "\x1b[38;2;104;215;161m";
const B = "\x1b[38;2;127;197;255m";
const A = "\x1b[38;2;237;187;100m";
const R = "\x1b[38;2;240;127;119m";
const X = "\x1b[0m";

interface Shell {
  host: Host;
  data: MockChannel;
  events: MockChannel;
  line: string;
  cols: number;
  rows: number;
  /** Top screen row of the fake `less`, when it's running. */
  pager?: number;
}

// Shaped like a real app log line: HTML inside JSON, long enough to wrap many times.
const LONG_LINE =
  `2026-06-03 17:26:58.784 INFO  [https-jsse-nio-443-exec-25] LeadService:1850 [b60ebec7-9c77-4a96-b8a2-d9f6754010cd POST /public/leads/upload 203.0.113.58] - Received response: ` +
  JSON.stringify({
    users: [], attachments: [], organization_id: "orga_qAk9hDHVdZZw1DDbzDZtWz1d3DkFc3TJTGbyoUM9mB3", _type: "Note",
    note_html: "<body><p>Lead uploaded from the web form:</p><ul>" + Array.from({ length: 9 }, (_, i) => `<li><b><u>Field ${i}:</u></b> value ${i}</li>`).join("") + "</ul></body>",
    created_by: "user_i0pXRWhxByP7OAYZblbKtVuK100H9YWuev1G4l6YnDE", contact_id: null, pinned: false, count: 42,
    date_created: "2026-06-03T21:26:58.686000+00:00", link: "https://admin.example.com/customers/42",
  });
const PAGER_LINES = [
  LONG_LINE,
  LONG_LINE.replace("17:26:58.784", "17:26:57.001"),
  LONG_LINE.replace("INFO ", "WARN "),
  `2026-06-03 17:26:59.102 WARN  [scheduler-1] RetryPolicy:88 [7f3c2a10-1b2d-4e5f-9a8b-0c1d2e3f4a5b] - Upstream slow, retrying in 250 ms`,
  `2026-06-03 17:27:00.417 ERROR [https-jsse-nio-443-exec-31] PaymentClient:212 - Charge failed`,
  `java.net.SocketTimeoutException: Read timed out`,
  `    at com.example.pay.PaymentClient.charge(PaymentClient.java:212)`,
  LONG_LINE.replace("INFO ", "ERROR"),
];

/** Redraws the fake pager the hard way, like less does after a scroll: every row by cursor position, no newlines. */
function drawPager(s: Shell) {
  const rows = PAGER_LINES.flatMap((l) => l.match(new RegExp(`.{1,${s.cols}}`, "g")) ?? [""]);
  const top = Math.max(0, Math.min(s.pager ?? 0, rows.length - (s.rows - 1)));
  s.pager = top;
  let out = "\x1b[H";
  for (let r = 0; r < s.rows - 1; r++) out += `\x1b[${r + 1};1H${rows[top + r] ?? "\x1b[1m~\x1b[0m"}\x1b[K`;
  out += `\x1b[${s.rows};1H\x1b[7m${top + s.rows - 1 >= rows.length ? "(END)" : ":"}\x1b[27m\x1b[K`;
  send(s.data, bytes(out));
}
const shells = new Map<string, Shell>();
const pendingPrompts = new Map<number, (reply: { accept: boolean; answers?: string[] }) => void>();
let nextRequest = 1;

function ask(events: MockChannel, build: (id: number) => object) {
  return new Promise<{ accept: boolean; answers?: string[] }>((resolve) => {
    const id = nextRequest++;
    pendingPrompts.set(id, resolve);
    send(events, build(id));
  });
}

const prompt = (h: Host) => `${G}${h.username}@${h.name}${X}:${B}~${X}$ `;

function welcome(h: Host) {
  return [
    `${DIM}Welcome to ${h.osName ?? "Linux"} (GNU/Linux 6.8.0-45-generic x86_64)${X}`,
    "",
    `${DIM}  System load:  ${X}0.18${DIM}            Processes:        ${X}142`,
    `${DIM}  Usage of /:   ${X}41.2% of 78GB${DIM}   Users logged in:  ${X}1`,
    `${DIM}  Memory usage: ${X}37%${DIM}             IPv4 address:     ${X}${h.address}`,
    "",
    `${DIM}Last login: Fri Sep 25 18:42:07 2026 from 10.0.0.4${X}`,
    "",
  ].join("\r\n");
}

function run(cmd: string, h: Host): string {
  const c = cmd.trim();
  const out: Record<string, string> = {
    ls: `${B}app${X}  ${G}deploy.sh${X}  docker-compose.yml  ${B}logs${X}`,
    whoami: h.username,
    uptime: " 18:51:04 up 5 days,  4:11,  1 user,  load average: 0.18, 0.22, 0.19",
    help: `${DIM}mock shell — try: ls  uptime  whoami  docker ps  logs  less  colors  clear  exit${X}`,
    logs: [
      `2026-06-03 17:26:58.784 INFO  [https-jsse-nio-443-exec-25] LeadService:1850 [b60ebec7-9c77-4a96-b8a2-d9f6754010cd POST /public/leads 203.0.113.58] - Received response: {"users": [], "_type": "Note", "count": 3, "pinned": false, "contact_id": null, "note": "Lead uploaded from the web form", "link": "https://admin.example.com/customers/42"}`,
      `2026-06-03 17:26:59.102 WARN  [scheduler-1] RetryPolicy:88 [7f3c2a10-1b2d-4e5f-9a8b-0c1d2e3f4a5b] - Upstream slow, retrying in 250 ms (attempt 2 of 5)`,
      `2026-06-03 17:27:00.417 ERROR [https-jsse-nio-443-exec-31] PaymentClient:212 [c0ffee00-1234-4abc-8def-001122334455 POST /api/charge 198.51.100.7] - Charge failed`,
      `java.net.SocketTimeoutException: Read timed out`,
      `    at java.base/java.net.SocketInputStream.socketRead0(Native Method)`,
      `    at com.example.pay.PaymentClient.charge(PaymentClient.java:212)`,
      `{"level": "debug", "ts": "2026-06-03T21:27:01.006Z", "msg": "cache hit", "key": "quote:9912", "ttl": 3600}`,
      `Jun  3 17:27:02 prod-5 sshd[20431]: Accepted publickey for ubuntu from 192.0.2.44 port 51122 ssh2`,
    ].join("\r\n"),
    "docker ps": `${DIM}NAMES     STATUS${X}\r\napi       ${G}Up 3 days (healthy)${X}\r\nworker    ${G}Up 3 days${X}\r\nredis     ${G}Up 12 days${X}`,
    "sudo tail -n 3 /var/log/nginx/error.log": `${DIM}2026/09/27 18:12:44 ${X}${A}[warn]${X} upstream response buffered to a temporary file\r\n${DIM}2026/09/27 18:31:02 ${X}${R}[error]${X} connect() failed (111) while connecting to upstream`,
    colors: Array.from({ length: 16 }, (_, i) => `\x1b[${i < 8 ? 30 + i : 82 + i}m██${X}`).join(" "),
  };
  if (!c) return "";
  if (c in out) return out[c] + "\r\n";
  return `${DIM}${c.split(" ")[0]}: not simulated in the mock backend${X}\r\n`;
}

function onInput(id: string, data: string) {
  const s = shells.get(id);
  if (!s) return;
  if (s.pager !== undefined) {
    const keys = data.match(/\x1b(?:\[|O)[AB]|./gs) ?? [];
    for (const key of keys) {
      if (key === "q") {
        s.pager = undefined;
        send(s.data, bytes(`\x1b[?1049l${prompt(s.host)}`));
        return;
      }
      if (key === "j" || key === "\x1b[B" || key === "\x1bOB" || key === "\r") s.pager = (s.pager ?? 0) + 1;
      if (key === "k" || key === "\x1b[A" || key === "\x1bOA") s.pager = Math.max(0, (s.pager ?? 0) - 1);
      drawPager(s);
    }
    return;
  }
  for (const ch of data) {
    if (ch === "\r") {
      const cmd = s.line;
      s.line = "";
      send(s.data, bytes("\r\n"));
      if (cmd.trim() === "exit") {
        send(s.data, bytes("logout\r\n"));
        shells.delete(id);
        send(s.events, { type: "exit", code: 0 });
        send(s.events, { type: "status", state: "closed", message: "" });
        return;
      }
      if (cmd.trim() === "less") {
        s.pager = 0;
        send(s.data, bytes("\x1b[?1049h\x1b[?1h\x1b="));
        drawPager(s);
        return;
      }
      if (cmd.trim() === "clear") send(s.data, bytes("\x1b[H\x1b[2J"));
      else send(s.data, bytes(run(cmd, s.host)));
      send(s.data, bytes(prompt(s.host)));
    } else if (ch === "\x7f") {
      if (s.line) {
        s.line = s.line.slice(0, -1);
        send(s.data, bytes("\b \b"));
      }
    } else if (ch >= " ") {
      s.line += ch;
      send(s.data, bytes(ch));
    }
  }
}

const LOCAL: [string, FileEntry["kind"], number, boolean][] = [
  ["src", "dir", 0, false], ["public", "dir", 0, false], ["node_modules", "dir", 0, false],
  ["package.json", "file", 1229, false], ["README.md", "file", 4915, false], ["deploy.sh", "file", 612, true],
  [".env.production", "file", 311, false], ["dist.tar.gz", "file", 29_780_000, false],
];
const REMOTE: [string, FileEntry["kind"], number, boolean][] = [
  ["releases", "dir", 0, false], ["shared", "dir", 0, false], ["current", "link", 0, false],
  ["index.html", "file", 18_400, false], ["robots.txt", "file", 68, false], [".htaccess", "file", 402, false],
];
const listing = (dir: string, rows: typeof LOCAL): FileEntry[] =>
  rows.map(([name, kind, size, executable], i) => ({
    name, kind, size, executable, isDir: kind !== "file",
    path: `${dir.replace(/\/$/, "")}/${name}`, modified: now() - i * 86400 * 3,
  }));

async function connectFlow(host: Host, events: MockChannel) {
  await new Promise((r) => setTimeout(r, 350));
  if (!trusted.has(host.id)) {
    const reply = await ask(events, (requestId) => ({
      type: "hostKey", requestId, status: "unknown", host: host.address, port: host.port,
      keyType: "ssh-ed25519", fingerprint: "SHA256:Lp4Tn9Xe2Wq7Kc1Zr6Mb3Vy8Hd5Gf0Js2AaQk2mPz8n", canReplace: true,
    }));
    if (!reply.accept) throw "Host key not trusted, connection closed";
    trusted.add(host.id);
  }
  if (latency[host.id] === null) throw `Timed out connecting to ${host.address}:${host.port}`;
  send(events, { type: "status", state: "authenticating", message: "" });
  if (host.id === "h7" && !host.hasPassword) {
    const reply = await ask(events, (requestId) => ({
      type: "prompt", requestId, title: "Password", instructions: "",
      fields: [{ label: `Password for ${host.username}@${host.address}`, secret: true }], allowSave: true,
    }));
    if (!reply.accept) throw "Authentication cancelled";
  }
  await new Promise((r) => setTimeout(r, 250));
}

async function handle(cmd: string, a: Args): Promise<unknown> {
  switch (cmd) {
    case "list_hosts":
      return hosts;
    case "list_keys":
      return withCounts();
    case "import_key": {
      if (!a.privateKey && !a.path) throw "Paste a private key or choose a key file";
      if (String(a.privateKey ?? "").includes("ENCRYPTED") && !a.passphrase)
        throw "This key is protected by a passphrase. Enter it below to import the key.";
      const name = a.name || String(a.path ?? "imported").split("/").pop();
      const key: KeyInfo = { id: crypto.randomUUID(), name, algorithm: "RSA 4096", fingerprint: `SHA256:${crypto.randomUUID().replace(/-/g, "").slice(0, 43)}`, publicKey: fakePub("ssh-rsa", name), encrypted: !!a.passphrase, hostCount: 0, createdAt: now() };
      keys = [...keys, key];
      return key;
    }
    case "generate_key": {
      const name = a.name || "ed25519";
      const key: KeyInfo = { id: crypto.randomUUID(), name, algorithm: "ED25519", fingerprint: `SHA256:${crypto.randomUUID().replace(/-/g, "").slice(0, 43)}`, publicKey: fakePub("ssh-ed25519", name), encrypted: false, hostCount: 0, createdAt: now() };
      keys = [...keys, key];
      return key;
    }
    case "rename_key":
      keys = keys.map((k) => (k.id === a.id ? { ...k, name: a.name } : k));
      return null;
    case "delete_key":
      keys = keys.filter((k) => k.id !== a.id);
      hosts = hosts.map((h) => (h.keyId === a.id ? { ...h, keyId: null, auth: "auto" } : h));
      return null;
    case "list_groups":
      return groups.filter((g) => hosts.some((h) => h.groupId === g.id));
    case "probe_hosts":
      return (a.targets as { id: string }[]).map((t) => ({ id: t.id, latencyMs: t.id in latency ? latency[t.id] : 12 }));
    case "host_history":
      return [
        { startedAt: now() - 3600, endedAt: now() - 3600 + 4140 },
        { startedAt: now() - 86400 - 30000, endedAt: now() - 86400 - 30000 + 1320 },
      ];
    case "save_host": {
      const input = a.input as HostInput;
      let groupId: string | null = null;
      if (input.groupName) {
        let g = groups.find((x) => x.name.toLowerCase() === input.groupName!.toLowerCase());
        if (!g) groups.push((g = { id: `g${groups.length + 1}`, name: input.groupName, color: (["g", "p", "r", "a", "b"] as const)[groups.length % 5] }));
        groupId = g.id;
      }
      const base = hosts.find((h) => h.id === input.id);
      const host: Host = {
        ...(base ?? H(crypto.randomUUID(), "", "", "", 22, null, null, "", [])),
        ...input, groupId, id: base?.id ?? crypto.randomUUID(),
        hasPassword: a.password === undefined ? (base?.hasPassword ?? false) : a.password !== "",
      };
      hosts = base ? hosts.map((h) => (h.id === host.id ? host : h)) : [...hosts, host];
      return host;
    }
    case "delete_host":
      hosts = hosts.filter((h) => h.id !== a.id);
      return null;
    case "terminal_open": {
      const host = hosts.find((h) => h.id === a.hostId)!;
      await connectFlow(host, a.onEvent);
      shells.set(a.sessionId, { host, data: a.onData, events: a.onEvent, line: "", cols: a.cols, rows: a.rows });
      send(a.onEvent, { type: "status", state: "connected", message: "" });
      setTimeout(() => send(a.onData, bytes(`${welcome(host)}${prompt(host)}`)), 30);
      host.lastConnectedAt = now();
      return { authLabel: host.id === "h7" ? "password" : "agent · ED25519", fingerprint: "SHA256:…" };
    }
    case "terminal_resize": {
      const sh = shells.get(a.sessionId);
      if (sh) {
        sh.cols = a.cols;
        sh.rows = a.rows;
        if (sh.pager !== undefined) drawPager(sh);
      }
      return null;
    }
    case "terminal_write":
      onInput(a.sessionId, a.data);
      return null;
    case "terminal_close":
      shells.delete(a.sessionId);
      return null;
    case "respond_prompt":
      pendingPrompts.get(a.requestId)?.(a.reply);
      pendingPrompts.delete(a.requestId);
      return null;
    case "sftp_open": {
      const host = hosts.find((h) => h.id === a.hostId)!;
      // Like the real backend, reuse an open terminal's connection.
      if (![...shells.values()].some((sh) => sh.host.id === host.id)) await connectFlow(host, a.onEvent);
      return { home: "/var/www/tern-site" };
    }
    case "sftp_list":
      return listing(a.path, REMOTE);
    case "local_home":
      return "/Users/you/code/tern-site";
    case "local_list":
      return listing(a.path, LOCAL);
    case "transfer_start": {
      const r = a.request;
      const name = String(r.source).split("/").pop();
      const total = 28_400_000;
      let sent = 0;
      const tick = setInterval(() => {
        sent = Math.min(total, sent + 2_300_000);
        const state = sent >= total ? "done" : "running";
        emit("transfer", { id: r.id, direction: r.direction, name, dest: r.destDir, bytes: sent, total, state, error: null });
        if (state === "done") clearInterval(tick);
      }, 120);
      return null;
    }
    case "plugin:dialog|confirm":
    case "plugin:dialog|ask":
      return window.confirm(a.message);
    case "plugin:dialog|open":
      return null;
    default:
      return null;
  }
}

mockWindows("main");
mockIPC((cmd, args) => handle(cmd, (args ?? {}) as Args), { shouldMockEvents: true });
console.info("[tern] running with the mock backend");
