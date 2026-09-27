import { useEffect, useRef, useState } from "react";
import { useStore, type PendingPrompt } from "../lib/store";
import type { HostKeyEvent, PromptEvent } from "../lib/types";

function HostKeyDialog({ p, ev }: { p: PendingPrompt; ev: HostKeyEvent }) {
  const answer = useStore((s) => s.answerPrompt);
  const reply = (accept: boolean) => answer(ev.requestId, { accept });
  const target = ev.port === 22 ? ev.host : `${ev.host}:${ev.port}`;
  const changed = ev.status === "changed";

  return (
    <div className="dialog" onKeyDown={(e) => e.key === "Escape" && reply(false)}>
      <h3 className={changed ? "warn" : undefined}>{changed ? "Host key changed" : "Trust this host?"}</h3>
      {changed ? (
        <p>
          The key for <b>{target}</b> is different from the one saved last time. The server may have been rebuilt, or
          someone may be intercepting the connection. Only continue if you expected this.
        </p>
      ) : (
        <p>
          This is the first connection to <b>{target}</b> ({p.hostName}). Check that the fingerprint matches the server
          before trusting it.
        </p>
      )}
      <div className="fingerprint selectable">
        {ev.keyType}
        <br />
        {ev.fingerprint}
      </div>
      {changed && !ev.canReplace && (
        <p style={{ fontSize: 12.5 }}>
          The old key is in your ~/.ssh/known_hosts, which Tern doesn't modify. Remove it with{" "}
          <span className="mono selectable">ssh-keygen -R {ev.host}</span> and connect again.
        </p>
      )}
      <div className="dialog-actions">
        <button className="btn" autoFocus onClick={() => reply(false)}>
          Cancel
        </button>
        {(!changed || ev.canReplace) && (
          <button className={`btn ${changed ? "danger" : "accent"}`} onClick={() => reply(true)}>
            {changed ? "Replace key and connect" : "Trust and connect"}
          </button>
        )}
      </div>
    </div>
  );
}

function CredentialDialog({ p, ev }: { p: PendingPrompt; ev: PromptEvent }) {
  const answer = useStore((s) => s.answerPrompt);
  const [values, setValues] = useState(() => ev.fields.map(() => ""));
  const [save, setSave] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => first.current?.focus(), []);

  const submit = () => answer(ev.requestId, { accept: true, answers: values, save });
  const cancel = () => answer(ev.requestId, { accept: false });

  return (
    <div
      className="dialog"
      onKeyDown={(e) => {
        if (e.key === "Enter") submit();
        if (e.key === "Escape") cancel();
      }}
    >
      <div>
        <h3>{ev.title}</h3>
        <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
          {p.hostName}
        </div>
      </div>
      {ev.instructions && <p className={ev.instructions.startsWith("Permission denied") || ev.instructions.startsWith("That") ? "warn" : undefined}>{ev.instructions}</p>}
      <div className="form">
        {ev.fields.map((f, i) => (
          <div className="field" key={i}>
            <label>{f.label}</label>
            <input
              ref={i === 0 ? first : undefined}
              className="input"
              type={f.secret ? "password" : "text"}
              value={values[i]}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setValues(values.map((v, j) => (j === i ? e.target.value : v)))}
            />
          </div>
        ))}
      </div>
      <div className="dialog-actions">
        {ev.allowSave && (
          <label className="check">
            <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
            Save to keychain
          </label>
        )}
        <button className="btn" onClick={cancel}>
          Cancel
        </button>
        <button className="btn primary" onClick={submit}>
          Continue
        </button>
      </div>
    </div>
  );
}

function TextDialog() {
  const tp = useStore((s) => s.textPrompt)!;
  const [value, setValue] = useState(tp.value);
  return (
    <div
      className="dialog"
      onKeyDown={(e) => {
        if (e.key === "Enter" && value.trim()) tp.resolve(value.trim());
        if (e.key === "Escape") tp.resolve(null);
      }}
    >
      <h3>{tp.title}</h3>
      <div className="field">
        <label className="ellipsis">{tp.label}</label>
        <input className="input mono" autoFocus value={value} spellCheck={false} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.target.select()} />
      </div>
      <div className="dialog-actions">
        <button className="btn" onClick={() => tp.resolve(null)}>
          Cancel
        </button>
        <button className="btn primary" disabled={!value.trim()} onClick={() => tp.resolve(value.trim())}>
          {tp.confirmLabel}
        </button>
      </div>
    </div>
  );
}

/** Shows the oldest pending question from any session, then any in-app text prompt. */
export function Dialogs() {
  const prompt = useStore((s) => s.prompts[0]);
  const textPrompt = useStore((s) => s.textPrompt);
  if (prompt) {
    return (
      <div className="scrim">
        {prompt.event.type === "hostKey" ? (
          <HostKeyDialog key={prompt.event.requestId} p={prompt} ev={prompt.event} />
        ) : (
          <CredentialDialog key={prompt.event.requestId} p={prompt} ev={prompt.event} />
        )}
      </div>
    );
  }
  if (textPrompt) {
    return (
      <div className="scrim">
        <TextDialog />
      </div>
    );
  }
  return null;
}
