import { confirm, open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { api, errorText } from "../lib/api";
import { formatMonth } from "../lib/format";
import { useStore } from "../lib/store";
import type { KeyInfo } from "../lib/types";

/** Type chip colors from the design: ED25519 green, ECDSA blue, RSA amber. */
function typeColor(algorithm: string) {
  if (algorithm.startsWith("ED25519")) return "var(--g)";
  if (algorithm.startsWith("ECDSA")) return "var(--b)";
  if (algorithm.startsWith("RSA")) return "var(--a)";
  return "var(--mu)";
}

export function TypeChip({ algorithm }: { algorithm: string }) {
  const c = typeColor(algorithm);
  return (
    <span className="chip mono" style={{ fontSize: 10.5, background: `color-mix(in oklch, ${c} 14%, transparent)`, color: c }}>
      {algorithm}
    </span>
  );
}

function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  };
  return { copied, copy };
}

function PanelHead({ title }: { title: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center" }}>
      <div style={{ fontSize: 16, fontWeight: 600 }}>{title}</div>
      <button className="icon-btn" style={{ marginLeft: "auto", fontSize: 15 }} onClick={() => useStore.setState({ keyPanel: null })}>
        ×
      </button>
    </div>
  );
}

async function afterSave(key: KeyInfo) {
  await useStore.getState().refreshHosts();
  useStore.setState({ keyPanel: { mode: "view", id: key.id } });
}

function ImportPanel() {
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [path, setPath] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [needsPassphrase, setNeedsPassphrase] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const choose = async () => {
    const home = await api.localHome();
    const picked = await open({ title: "Choose a private key", defaultPath: `${home}/.ssh`, multiple: false, directory: false });
    if (typeof picked !== "string") return;
    setPath(picked);
    setText("");
    if (!name) setName(picked.split(/[\\/]/).pop() ?? "");
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const key = await api.importKey({
        name: name.trim(),
        privateKey: path ? undefined : text,
        path: path ?? undefined,
        passphrase: passphrase || undefined,
      });
      await afterSave(key);
    } catch (e) {
      const msg = errorText(e);
      if (msg.includes("passphrase")) setNeedsPassphrase(true);
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="side-panel" onKeyDown={(e) => e.key === "Escape" && useStore.setState({ keyPanel: null })}>
      <PanelHead title="Import key" />
      <div className="form">
        <div className="field">
          <label>Name</label>
          <input className="input" autoFocus value={name} placeholder="PROD" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label>Private key</label>
          {path ? (
            <div className="key-file">
              <span className="mono ellipsis">{path}</span>
              <button className="btn ghost sm" onClick={() => setPath(null)}>
                Change
              </button>
            </div>
          ) : (
            <textarea
              className="input mono key-text"
              value={text}
              spellCheck={false}
              autoComplete="off"
              placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n…"}
              onChange={(e) => setText(e.target.value)}
            />
          )}
          <div className="hint">
            Paste the key, or{" "}
            <a href="#" onClick={(e) => (e.preventDefault(), void choose())}>
              choose a key file
            </a>
            . OpenSSH, PEM and PKCS#8 keys work.
          </div>
        </div>
        <div className="field">
          <label>Passphrase {needsPassphrase ? "" : "(if the key has one)"}</label>
          <input
            className="input"
            type="password"
            value={passphrase}
            autoFocus={needsPassphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void save()}
          />
          <div className="hint">Saved encrypted alongside the key, so connecting never asks for it.</div>
        </div>
        {error && <div className="error-text">{error}</div>}
      </div>
      <div style={{ marginTop: "auto", display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button className="btn" onClick={() => useStore.setState({ keyPanel: null })}>
          Cancel
        </button>
        <button className="btn primary" disabled={saving || (!text.trim() && !path)} onClick={save}>
          Import
        </button>
      </div>
    </div>
  );
}

function GeneratePanel() {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await afterSave(await api.generateKey(name.trim()));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="side-panel" onKeyDown={(e) => e.key === "Escape" && useStore.setState({ keyPanel: null })}>
      <PanelHead title="Generate key" />
      <div className="form">
        <div className="field">
          <label>Name</label>
          <input className="input" autoFocus value={name} placeholder="laptop" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
        </div>
        <div className="field">
          <label>Type</label>
          <div>
            <TypeChip algorithm="ED25519" />
          </div>
          <div className="hint">Fast, small and supported by every current OpenSSH server. After it's created, copy the public key into ~/.ssh/authorized_keys on your servers.</div>
        </div>
        {error && <div className="error-text">{error}</div>}
      </div>
      <div style={{ marginTop: "auto", display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button className="btn" onClick={() => useStore.setState({ keyPanel: null })}>
          Cancel
        </button>
        <button className="btn primary" disabled={saving} onClick={save}>
          Generate
        </button>
      </div>
    </div>
  );
}

function KeyDetail({ k }: { k: KeyInfo }) {
  const allHosts = useStore((s) => s.hosts);
  const hosts = useMemo(() => allHosts.filter((h) => h.keyId === k.id), [allHosts, k.id]);
  const [name, setName] = useState(k.name);
  const [error, setError] = useState<string | null>(null);
  const { copied, copy } = useCopy();
  useEffect(() => setName(k.name), [k.id, k.name]);

  const rename = async () => {
    if (name.trim() === k.name) return;
    try {
      await api.renameKey(k.id, name);
      await useStore.getState().refreshHosts();
      setError(null);
    } catch (e) {
      setError(errorText(e));
      setName(k.name);
    }
  };

  const remove = async () => {
    const using = k.hostCount ? ` ${k.hostCount} ${k.hostCount === 1 ? "host uses" : "hosts use"} it and will switch to automatic authentication.` : "";
    const ok = await confirm(`Delete “${k.name}” from the keychain?${using}`, { title: "Delete key", kind: "warning", okLabel: "Delete" });
    if (!ok) return;
    await api.deleteKey(k.id);
    useStore.setState({ keyPanel: null });
    await useStore.getState().refreshHosts();
  };

  return (
    <div className="side-panel">
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <input
          className="title-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          title="Rename"
        />
        <button className="icon-btn" style={{ marginLeft: "auto", fontSize: 15 }} onClick={() => useStore.setState({ keyPanel: null })}>
          ×
        </button>
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="fields">
        <div>
          <span className="k">Type</span>
          <span className="v">
            <TypeChip algorithm={k.algorithm} />
          </span>
        </div>
        <div>
          <span className="k">Fingerprint</span>
          <span className="v selectable" title={k.fingerprint}>
            {k.fingerprint}
          </span>
        </div>
        <div>
          <span className="k">Passphrase</span>
          <span className="v">{k.encrypted ? "Saved, encrypted" : "None"}</span>
        </div>
        <div>
          <span className="k">Added</span>
          <span className="v">{formatMonth(k.createdAt)}</span>
        </div>
      </div>
      <div className="field">
        <div style={{ display: "flex", alignItems: "center" }}>
          <span className="caps">Public key</span>
          <button className="btn ghost sm" style={{ marginLeft: "auto", height: 24 }} onClick={() => copy(k.publicKey)}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <div className="fingerprint selectable">{k.publicKey}</div>
        <div className="hint">Add this line to ~/.ssh/authorized_keys on each server that should accept the key.</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="caps">Used by</div>
        {hosts.length === 0 && <div style={{ fontSize: 12, color: "var(--dd)" }}>No hosts yet. Pick this key in a host's Authentication settings.</div>}
        {hosts.map((h) => (
          <div
            key={h.id}
            className="used-by"
            onClick={() => useStore.setState({ view: "hosts", selectedHostId: h.id, editor: null })}
          >
            <span>{h.name}</span>
            <span className="mono muted">
              {h.username}@{h.address}
            </span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: "auto", display: "flex", gap: 8 }}>
        <button className="btn sm danger" onClick={remove}>
          Delete
        </button>
      </div>
    </div>
  );
}

export function KeychainView() {
  const keys = useStore((s) => s.keys);
  const panel = useStore((s) => s.keyPanel);
  const viewed = panel?.mode === "view" ? keys.find((k) => k.id === panel.id) : undefined;
  const openImport = () => useStore.setState({ keyPanel: { mode: "import" } });
  const openGenerate = () => useStore.setState({ keyPanel: { mode: "generate" } });

  return (
    <div className="hosts-split">
      <div className="page" style={{ gap: 22 }}>
        <div className="page-head">
          <div>
            <div className="page-title">Keychain</div>
            <div className="page-sub">Private keys never leave this device. The vault stores them encrypted.</div>
          </div>
          <button className="btn" style={{ marginLeft: "auto" }} onClick={openImport}>
            Import
          </button>
          <button className="btn primary" onClick={openGenerate}>
            Generate key
          </button>
        </div>
        {keys.length === 0 ? (
          <div className="empty" style={{ border: "1px solid var(--bd)", borderRadius: 12, background: "var(--side)", flex: "none", padding: "48px 24px" }}>
            <h2>No keys yet</h2>
            <p>Save a key once and use it on as many hosts as you like. Import one you already have, or generate a new one.</p>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn" onClick={openImport}>
                Import
              </button>
              <button className="btn primary" onClick={openGenerate}>
                Generate key
              </button>
            </div>
          </div>
        ) : (
          <div className="key-table">
            <div className="key-row head">
              <span>Name</span>
              <span>Type</span>
              <span>Fingerprint</span>
              <span style={{ textAlign: "right" }}>Hosts</span>
              <span style={{ textAlign: "right" }}>Added</span>
            </div>
            {keys.map((k) => (
              <div
                key={k.id}
                className={`key-row ${viewed?.id === k.id ? "sel" : ""}`}
                onClick={() => useStore.setState({ keyPanel: { mode: "view", id: k.id } })}
              >
                <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                  <span className="ellipsis" style={{ fontWeight: 500 }}>
                    {k.name}
                  </span>
                  <span className="muted" style={{ fontSize: 11.5 }}>
                    {k.encrypted ? "Passphrase saved" : "No passphrase"}
                  </span>
                </span>
                <span>
                  <TypeChip algorithm={k.algorithm} />
                </span>
                <span className="mono ellipsis" style={{ fontSize: 11.5, color: "var(--mu)" }}>
                  {k.fingerprint}
                </span>
                <span className="mono" style={{ textAlign: "right", fontSize: 12 }}>
                  {k.hostCount}
                </span>
                <span className="muted" style={{ textAlign: "right", fontSize: 12 }}>
                  {formatMonth(k.createdAt)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      {panel?.mode === "import" && <ImportPanel />}
      {panel?.mode === "generate" && <GeneratePanel />}
      {viewed && <KeyDetail k={viewed} />}
    </div>
  );
}
