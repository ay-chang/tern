import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { formatBytes, formatDay } from "../lib/format";
import {
  clearFinishedTransfers,
  connectSftp,
  deleteRemote,
  initLocal,
  listPane,
  newFolder,
  parentPath,
  renameRemote,
  select,
  transfer,
  useSftp,
  type Side,
} from "../lib/sftp";
import { useStore } from "../lib/store";
import type { FileEntry, TransferEvent } from "../lib/types";

const DRAG_TYPE = "application/x-tern-file";

function iconFor(e: FileEntry): { background: string; borderRadius: string } {
  if (e.kind === "dir") return { background: "var(--b)", borderRadius: "3px" };
  if (e.kind === "link") return { background: "var(--p)", borderRadius: "3px" };
  if (e.executable) return { background: "var(--g)", borderRadius: "50%" };
  return { background: "var(--off)", borderRadius: "50%" };
}

function PathField({ side, path }: { side: Side; path: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(path);
  useEffect(() => setValue(path), [path]);
  if (!editing) {
    return (
      <span className="pane-path ellipsis selectable" title="Click to type a path" onClick={() => setEditing(true)}>
        {path || "—"}
      </span>
    );
  }
  return (
    <span className="pane-path">
      <input
        autoFocus
        value={value}
        spellCheck={false}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            setEditing(false);
            void listPane(side, value.trim() || path);
          }
          if (e.key === "Escape") setEditing(false);
        }}
      />
    </span>
  );
}

interface MenuState {
  x: number;
  y: number;
  side: Side;
  entry: FileEntry | null;
}

function FileMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const connected = useSftp((s) => s.status === "connected");
  const { side, entry } = menu;
  const item = (label: string, run: () => void, opts: { disabled?: boolean; danger?: boolean; hint?: string } = {}) => (
    <div
      className={`menu-item ${opts.disabled ? "disabled" : ""} ${opts.danger ? "danger" : ""}`}
      onClick={() => {
        if (opts.disabled) return;
        onClose();
        run();
      }}
    >
      <span>{label}</span>
      {opts.hint && <span className="kbd">{opts.hint}</span>}
    </div>
  );
  return (
    <div className="menu-scrim" onMouseDown={onClose} onContextMenu={(e) => (e.preventDefault(), onClose())}>
      <div className="menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
        {entry?.isDir && item("Open", () => listPane(side, entry.path), { hint: "↵" })}
        {entry &&
          (side === "local"
            ? item("Upload to server", () => transfer("local", entry), { disabled: !connected })
            : item("Download", () => transfer("remote", entry)))}
        {entry && side === "remote" && (
          <>
            <div className="menu-sep" />
            {item("Rename…", () => renameRemote(entry), { hint: "F2" })}
            {item("Delete…", () => deleteRemote(entry), { danger: true, hint: "⌘⌫" })}
          </>
        )}
        {entry && <div className="menu-sep" />}
        {item("New folder…", () => newFolder(side), { disabled: side === "remote" && !connected })}
        {item("Refresh", () => listPane(side, useSftp.getState()[side].path))}
      </div>
    </div>
  );
}

function Pane({ side, label, highlight, onMenu }: { side: Side; label: string; highlight?: boolean; onMenu: (m: MenuState) => void }) {
  const pane = useSftp((s) => s[side]);
  const connected = useSftp((s) => s.status === "connected");
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const sel = pane.entries.find((e) => e.path === pane.selected);
  const ready = side === "local" || connected;

  const open = (e: FileEntry) => {
    if (e.isDir) void listPane(side, e.path);
  };

  const onDrop = (ev: React.DragEvent, intoDir?: string) => {
    ev.preventDefault();
    ev.stopPropagation();
    setDropTarget(null);
    const raw = ev.dataTransfer.getData(DRAG_TYPE);
    if (!raw) return;
    const { from, entry } = JSON.parse(raw) as { from: Side; entry: FileEntry };
    if (from !== side) void transfer(from, entry, intoDir);
  };
  const canDrop = (ev: React.DragEvent) => ev.dataTransfer.types.includes(DRAG_TYPE);

  return (
    <div
      className={`pane ${dropTarget === "" || highlight ? "drop" : ""}`}
      data-pane={side}
      onDragOver={(ev) => {
        if (!canDrop(ev) || !ready) return;
        ev.preventDefault();
        if (dropTarget === null) setDropTarget("");
      }}
      onDragLeave={(ev) => {
        if (!ev.currentTarget.contains(ev.relatedTarget as Node)) setDropTarget(null);
      }}
      onDrop={(ev) => onDrop(ev)}
    >
      <div className="pane-head">
        <span className="chip">{label}</span>
        <PathField side={side} path={pane.path} />
        <div className="pane-actions">
          {side === "local" ? (
            <button className="btn ghost sm" disabled={!sel || !connected} onClick={() => sel && transfer("local", sel)} title="Copy the selection to the server">
              Upload →
            </button>
          ) : (
            <>
              <button className="btn ghost sm" disabled={!sel} onClick={() => sel && transfer("remote", sel)} title="Copy the selection to this computer">
                ← Download
              </button>
            </>
          )}
          <button className="btn ghost sm" disabled={!ready || !pane.path} onClick={() => newFolder(side)} title="New folder">
            + Folder
          </button>
        </div>
      </div>
      <div className="pane-cols">
        <span>Name</span>
        <span>Size</span>
        <span>Modified</span>
      </div>
      <div
        className="pane-list"
        tabIndex={0}
        onClick={(e) => e.target === e.currentTarget && select(side, null)}
        onContextMenu={(e) => {
          e.preventDefault();
          if (ready && pane.path) onMenu({ x: e.clientX, y: e.clientY, side, entry: null });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && sel) open(sel);
          else if (e.key === "F2" && sel && side === "remote") void renameRemote(sel);
          else if (((e.key === "Backspace" && e.metaKey) || e.key === "Delete") && sel && side === "remote") void deleteRemote(sel);
          else if (e.key === "Backspace" && !e.metaKey && pane.path) void listPane(side, parentPath(side, pane.path));
          else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const i = pane.entries.findIndex((x) => x.path === pane.selected);
            const next = e.key === "ArrowDown" ? Math.min(i + 1, pane.entries.length - 1) : Math.max(i - 1, 0);
            if (pane.entries[next]) select(side, pane.entries[next].path);
          }
        }}
      >
        {pane.error && <div className="pane-msg error-text">{pane.error}</div>}
        {side === "remote" && !ready ? null : (
          <>
            {pane.path && parentPath(side, pane.path) !== pane.path && (
              <div className="file-row" onDoubleClick={() => listPane(side, parentPath(side, pane.path))}>
                <span className="file-name">
                  <span className="file-icon" style={{ background: "var(--b)", borderRadius: 3, opacity: 0.5 }} />
                  <span>..</span>
                </span>
                <span />
                <span />
              </div>
            )}
            {pane.entries.map((e) => (
              <div
                key={e.path}
                className={`file-row ${pane.selected === e.path ? "sel" : ""} ${dropTarget === e.path ? "drop" : ""}`}
                draggable
                onDragStart={(ev) => {
                  ev.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ from: side, entry: e }));
                  ev.dataTransfer.effectAllowed = "copy";
                  select(side, e.path);
                }}
                onDragOver={(ev) => {
                  if (!e.isDir || !canDrop(ev) || !ready) return;
                  ev.preventDefault();
                  ev.stopPropagation();
                  setDropTarget(e.path);
                }}
                onDrop={(ev) => e.isDir && onDrop(ev, e.path)}
                onClick={() => select(side, e.path)}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  select(side, e.path);
                  onMenu({ x: ev.clientX, y: ev.clientY, side, entry: e });
                }}
                onDoubleClick={() => (e.isDir ? open(e) : side === "local" ? transfer("local", e) : transfer("remote", e))}
                title={e.isDir ? undefined : `Double-click to ${side === "local" ? "upload" : "download"}`}
              >
                <span className="file-name">
                  <span className="file-icon" style={iconFor(e)} />
                  <span className="ellipsis">{e.name}</span>
                </span>
                <span className="file-meta">{e.isDir ? "—" : formatBytes(e.size)}</span>
                <span className="file-date">{formatDay(e.modified)}</span>
              </div>
            ))}
            {!pane.loading && !pane.error && pane.path && pane.entries.length === 0 && <div className="pane-msg">Empty folder</div>}
          </>
        )}
        {pane.loading && pane.entries.length === 0 && <div className="pane-msg">Loading…</div>}
        {side === "remote" && <RemoteState />}
      </div>
    </div>
  );
}

function RemoteState() {
  const status = useSftp((s) => s.status);
  const error = useSftp((s) => s.error);
  const hostId = useSftp((s) => s.hostId);
  if (status === "connected") return null;
  if (status === "connecting") return <div className="pane-msg">Connecting…</div>;
  if (status === "error")
    return (
      <div className="pane-msg">
        <div className="error-text" style={{ marginBottom: 12 }}>
          {error}
        </div>
        {hostId && (
          <button className="btn sm" onClick={() => connectSftp(hostId)}>
            Try again
          </button>
        )}
      </div>
    );
  return <div className="pane-msg">Pick a host above to browse its files.</div>;
}

function TransferRow({ t }: { t: TransferEvent }) {
  const up = t.direction === "upload";
  const color = t.state === "failed" ? "var(--r)" : up ? "var(--g)" : "var(--b)";
  const pct = t.total ? Math.min(100, (t.bytes / t.total) * 100) : t.state === "done" ? 100 : 0;
  const meta =
    t.state === "running"
      ? `${formatBytes(t.bytes)} / ${formatBytes(t.total)}`
      : t.state === "done"
        ? `done · ${formatBytes(t.total)}`
        : t.state;
  return (
    <div className="transfer">
      <span className="mono" style={{ color }}>
        {up ? "↑" : "↓"}
      </span>
      <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span className="mono ellipsis" style={{ fontSize: 12 }}>
          {t.name}
        </span>
        <span className="ellipsis" style={{ fontSize: 11.5, color: t.error ? "var(--r)" : "var(--dm)" }} title={t.error ?? undefined}>
          {t.error ?? `${up ? "→" : "←"} ${t.dest}`}
        </span>
      </span>
      <span className="progress">
        <span style={{ width: `${pct}%`, background: color }} />
      </span>
      <span className="mono muted" style={{ textAlign: "right", fontSize: 11.5 }}>
        {meta}
      </span>
      {t.state === "running" ? (
        <button className="icon-btn" title="Cancel" onClick={() => api.transferCancel(t.id)}>
          ×
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}

export function SftpView() {
  const hosts = useStore((s) => s.hosts);
  const hostId = useSftp((s) => s.hostId);
  const transfers = useSftp((s) => s.transfers);
  const host = hosts.find((h) => h.id === hostId);
  const [finderDrop, setFinderDrop] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);

  useEffect(() => {
    void initLocal();
  }, []);

  // Files dragged in from Finder / Explorer arrive as native paths.
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      const overRemote = (pos: { x: number; y: number }) => {
        const el = document.elementFromPoint(pos.x / devicePixelRatio, pos.y / devicePixelRatio);
        return !!el?.closest('[data-pane="remote"]');
      };
      if (p.type === "over") setFinderDrop(overRemote(p.position));
      else if (p.type === "leave") setFinderDrop(false);
      else if (p.type === "drop") {
        setFinderDrop(false);
        if (!overRemote(p.position)) return;
        for (const path of p.paths) {
          const name = path.split(/[\\/]/).pop() ?? path;
          void transfer("local", { name, path, kind: "file", isDir: false, size: 0, modified: null, executable: false });
        }
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  const running = transfers.filter((t) => t.state === "running").length;

  return (
    <div className="sftp">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div className="page-title">SFTP</div>
        <span className="mono muted" style={{ fontSize: 12 }}>
          local ⇄
        </span>
        <select
          className="select"
          value={hostId ?? ""}
          onChange={(e) => e.target.value && connectSftp(e.target.value)}
        >
          <option value="" disabled>
            {hosts.length ? "choose a host" : "no hosts yet"}
          </option>
          {hosts.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
        {host && (
          <button className="btn ghost sm" onClick={() => listPane("remote", useSftp.getState().remote.path)}>
            Refresh
          </button>
        )}
      </div>
      <div className="sftp-panes">
        <Pane side="local" label="Local" onMenu={setMenu} />
        <Pane side="remote" label={host?.name ?? "Remote"} highlight={finderDrop} onMenu={setMenu} />
      </div>
      {menu && <FileMenu menu={menu} onClose={() => setMenu(null)} />}
      {transfers.length > 0 && (
        <div className="transfers">
          <div style={{ display: "flex", alignItems: "center", padding: "2px 8px 4px" }}>
            <span className="caps">Transfers{running ? ` · ${running} running` : ""}</span>
            <button className="btn ghost sm" style={{ marginLeft: "auto", height: 22 }} onClick={clearFinishedTransfers}>
              Clear finished
            </button>
          </div>
          {transfers.map((t) => (
            <TransferRow key={t.id} t={t} />
          ))}
        </div>
      )}
    </div>
  );
}
