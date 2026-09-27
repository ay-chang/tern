import { confirm, open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { api, errorText } from "../lib/api";
import { authLabel, formatDuration, formatWhen } from "../lib/format";
import { credentialStoreName } from "../lib/platform";
import { connectSftp } from "../lib/sftp";
import { useStore } from "../lib/store";
import { openSession } from "../lib/terminals";
import type { AuthMode, HistoryEntry, Host } from "../lib/types";
import { HostBadge, Seg, useHostStatus } from "../components/ui";

export function HostDetail({ host }: { host: Host }) {
  const st = useHostStatus(host);
  const groups = useStore((s) => s.groups);
  const keys = useStore((s) => s.keys);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  useEffect(() => {
    api.hostHistory(host.id).then(setHistory, () => setHistory([]));
  }, [host.id, host.lastConnectedAt]);

  const statusLong = st.online ? `Online · ${st.text}` : st.text === "offline" ? "Unreachable" : "Not checked yet";
  const fields = [
    ["Address", host.address],
    ["Port", String(host.port)],
    ["User", host.username],
    ["Auth", authLabel(host, keys)],
    ["Group", groups.find((g) => g.id === host.groupId)?.name ?? "—"],
    ["OS", host.osName ?? "Not detected yet"],
  ];

  const remove = async () => {
    const ok = await confirm(`Delete “${host.name}”? Its saved password is removed from the keychain too.`, {
      title: "Delete host",
      kind: "warning",
      okLabel: "Delete",
    });
    if (!ok) return;
    await api.deleteHost(host.id);
    useStore.setState({ selectedHostId: null });
    await useStore.getState().refreshHosts();
  };

  return (
    <div className="side-panel">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <HostBadge host={host} size={42} />
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <div className="ellipsis" style={{ fontSize: 16, fontWeight: 600 }}>
            {host.name}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--dm)", fontSize: 12 }}>
            <span className="dot" style={{ background: st.color }} />
            {statusLong}
          </div>
        </div>
        <button className="icon-btn" style={{ marginLeft: "auto", alignSelf: "flex-start", fontSize: 15 }} onClick={() => useStore.setState({ selectedHostId: null })}>
          ×
        </button>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn accent" style={{ flex: 1, height: 36 }} onClick={() => openSession(host.id)}>
          Connect
        </button>
        <button
          className="btn"
          style={{ height: 36 }}
          onClick={() => {
            useStore.getState().setView("sftp");
            void connectSftp(host.id);
          }}
        >
          SFTP
        </button>
      </div>
      <div className="fields">
        {fields.map(([k, v]) => (
          <div key={k}>
            <span className="k">{k}</span>
            <span className="v selectable" title={v}>
              {v}
            </span>
          </div>
        ))}
      </div>
      {host.tags.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {host.tags.map((t) => (
            <span key={t} className="chip">
              {t}
            </span>
          ))}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="caps">Recent sessions</div>
        {history.length === 0 && <div style={{ fontSize: 12, color: "var(--dd)" }}>No sessions yet.</div>}
        {history.map((r) => (
          <div key={r.startedAt} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--mu)" }}>
            <span>{formatWhen(r.startedAt)}</span>
            <span className="mono muted">{r.endedAt ? formatDuration(r.endedAt - r.startedAt) : "open"}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: "auto", display: "flex", gap: 8 }}>
        <button className="btn sm" onClick={() => useStore.setState({ editor: { hostId: host.id } })}>
          Edit
        </button>
        <button className="btn sm danger" onClick={remove}>
          Delete
        </button>
      </div>
    </div>
  );
}

const AUTH_OPTIONS: { value: AuthMode; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "password", label: "Password" },
  { value: "key", label: "Key" },
];

const FILE_KEY = "__file__";

const AUTH_HINT: Record<AuthMode, string> = {
  auto: "Tries your SSH agent and ~/.ssh keys first, then asks for a password, like ssh does.",
  password: "Uses the saved password, or asks each time. Two-factor prompts are supported.",
  key: "Uses one key, from your keychain or a file on disk.",
};

export function HostEditor({ hostId }: { hostId: string | null }) {
  const existing = useStore((s) => s.hosts.find((h) => h.id === hostId));
  const groups = useStore((s) => s.groups);
  const keys = useStore((s) => s.keys);

  const [name, setName] = useState(existing?.name ?? "");
  const [address, setAddress] = useState(existing?.address ?? "");
  const [port, setPort] = useState(String(existing?.port ?? 22));
  const [username, setUsername] = useState(existing?.username ?? "");
  const [group, setGroup] = useState(groups.find((g) => g.id === existing?.groupId)?.name ?? "");
  const [auth, setAuth] = useState<AuthMode>(existing?.auth ?? "auto");
  const [keyPath, setKeyPath] = useState(existing?.keyPath ?? "");
  /** A keychain key id, or FILE_KEY to use keyPath. */
  const [keyChoice, setKeyChoice] = useState<string>(
    existing?.keyId ?? (existing?.keyPath || keys.length === 0 ? FILE_KEY : keys[0].id),
  );
  const useFile = keyChoice === FILE_KEY;
  const [tags, setTags] = useState(existing?.tags.join(", ") ?? "");
  /** undefined leaves the saved password as it is. */
  const [password, setPassword] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const close = () => useStore.setState({ editor: null, selectedHostId: hostId });

  const browseKey = async () => {
    const home = await api.localHome();
    const picked = await open({ title: "Choose a private key", defaultPath: `${home}/.ssh`, multiple: false, directory: false });
    if (typeof picked === "string") setKeyPath(picked.startsWith(`${home}/`) ? `~/${picked.slice(home.length + 1)}` : picked);
  };

  const save = async () => {
    const portNum = Number(port);
    if (!address.trim()) return setError("Address is required.");
    if (!username.trim()) return setError("Username is required.");
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return setError("Port must be between 1 and 65535.");
    if (auth === "key" && useFile && !keyPath.trim()) return setError("Choose a private key file.");
    setSaving(true);
    setError(null);
    try {
      const saved = await api.saveHost(
        {
          id: existing?.id,
          name: name.trim() || address.trim(),
          address: address.trim(),
          port: portNum,
          username: username.trim(),
          groupName: group.trim() || null,
          auth,
          keyPath: auth === "key" && useFile ? keyPath.trim() : null,
          keyId: auth === "key" && !useFile ? keyChoice : null,
          tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        },
        password,
      );
      await useStore.getState().refreshHosts();
      useStore.setState({ editor: null, selectedHostId: saved.id });
      void useStore.getState().probe();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) void save();
    if (e.key === "Escape") close();
  };

  return (
    <div className="side-panel" onKeyDown={onKey}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>{existing ? "Edit host" : "New host"}</div>
        <button className="icon-btn" style={{ marginLeft: "auto", fontSize: 15 }} onClick={close}>
          ×
        </button>
      </div>
      <div className="form">
        <div className="field">
          <label>Address</label>
          <input className="input mono" autoFocus value={address} placeholder="10.0.1.12 or server.example.com" spellCheck={false} onChange={(e) => setAddress(e.target.value)} />
        </div>
        <div className="form-row">
          <div className="field">
            <label>Username</label>
            <input className="input mono" value={username} placeholder="root" spellCheck={false} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="field" style={{ flex: "0 0 84px" }}>
            <label>Port</label>
            <input className="input mono" value={port} inputMode="numeric" onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} />
          </div>
        </div>
        <div className="field">
          <label>Name</label>
          <input className="input" value={name} placeholder={address || "api-prod-01"} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="form-row">
          <div className="field">
            <label>Group</label>
            <input className="input" list="tern-groups" value={group} placeholder="Production" onChange={(e) => setGroup(e.target.value)} />
            <datalist id="tern-groups">
              {groups.map((g) => (
                <option key={g.id} value={g.name} />
              ))}
            </datalist>
          </div>
          <div className="field">
            <label>Tags</label>
            <input className="input" value={tags} placeholder="api, docker" onChange={(e) => setTags(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label>Authentication</label>
          <Seg options={AUTH_OPTIONS} value={auth} onChange={setAuth} />
          <div className="hint">{AUTH_HINT[auth]}</div>
        </div>
        {auth === "key" ? (
          <div className="field">
            <label>Key</label>
            <select className="input" value={keyChoice} onChange={(e) => setKeyChoice(e.target.value)}>
              {keys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name} · {k.algorithm}
                </option>
              ))}
              <option value={FILE_KEY}>Key file on disk…</option>
            </select>
            {useFile && (
              <div style={{ display: "flex", gap: 8 }}>
                <input className="input mono" value={keyPath} placeholder="~/.ssh/id_ed25519" spellCheck={false} onChange={(e) => setKeyPath(e.target.value)} />
                <button className="btn" onClick={browseKey}>
                  Browse
                </button>
              </div>
            )}
            <div className="hint">
              {useFile
                ? "Read from disk on each connect. Its passphrase is asked the first time."
                : "Stored encrypted in Tern's keychain, so any host can use it."}{" "}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  useStore.setState({ view: "keys", keyPanel: { mode: "import" }, editor: null });
                }}
              >
                {keys.length ? "Add another key" : "Import a key"}
              </a>
            </div>
          </div>
        ) : (
          <div className="field">
            <label>Password {auth === "auto" ? "(optional)" : ""}</label>
            <input
              className="input"
              type="password"
              value={password ?? ""}
              placeholder={existing?.hasPassword && password === undefined ? "Saved · type to replace" : "Leave empty to be asked"}
              onChange={(e) => setPassword(e.target.value)}
            />
            <div className="hint">
              Stored in the {credentialStoreName}.
              {existing?.hasPassword && password !== "" && (
                <>
                  {" "}
                  <a href="#" onClick={(e) => (e.preventDefault(), setPassword(""))}>
                    Forget saved password
                  </a>
                </>
              )}
              {existing?.hasPassword && password === "" && " The saved password will be removed."}
            </div>
          </div>
        )}
        {error && <div className="error-text">{error}</div>}
      </div>
      <div style={{ marginTop: "auto", display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button className="btn" onClick={close}>
          Cancel
        </button>
        <button className="btn primary" disabled={saving} onClick={save}>
          {existing ? "Save" : "Add host"}
        </button>
      </div>
    </div>
  );
}
