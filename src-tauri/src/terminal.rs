//! Interactive shell sessions. Each session is one task that owns its SSH
//! channel; the UI talks to it through an unbounded command queue and receives
//! output as raw bytes on a Tauri channel.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use anyhow::Result;
use russh::ChannelMsg;
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::{mpsc, oneshot};

use crate::db::Host;
use crate::ssh::{self, SessionEvent};
use crate::state::AppState;

pub enum TerminalCmd {
    Input(Vec<u8>),
    Resize(u32, u32),
    Close,
}

pub struct TerminalEntry {
    /// Distinguishes a reconnect under the same session id from the task it replaced.
    generation: u64,
    tx: mpsc::UnboundedSender<TerminalCmd>,
    task: tauri::async_runtime::JoinHandle<()>,
}

static GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectInfo {
    pub auth_label: String,
    pub fingerprint: String,
}

pub struct OpenArgs {
    pub host: Host,
    pub cols: u32,
    pub rows: u32,
    pub data: Channel<InvokeResponseBody>,
    pub events: Channel<SessionEvent>,
}

pub async fn open<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    args: OpenArgs,
) -> Result<ConnectInfo, String> {
    close(&app, &session_id);
    let (tx, rx) = mpsc::unbounded_channel();
    let (ready_tx, ready_rx) = oneshot::channel();
    let generation = GENERATION.fetch_add(1, Ordering::Relaxed);
    // Hold the lock across spawn so the task can't finish and deregister before it's registered.
    {
        let state = app.state::<AppState>();
        let mut terminals = state.terminals.lock().unwrap();
        let task = tauri::async_runtime::spawn(run(
            app.clone(),
            session_id.clone(),
            generation,
            args,
            rx,
            ready_tx,
        ));
        terminals.insert(
            session_id,
            TerminalEntry {
                generation,
                tx,
                task,
            },
        );
    }
    ready_rx.await.map_err(|_| "Cancelled".to_string())?
}

pub fn send<R: Runtime>(app: &AppHandle<R>, session_id: &str, cmd: TerminalCmd) {
    if let Some(entry) = app
        .state::<AppState>()
        .terminals
        .lock()
        .unwrap()
        .get(session_id)
    {
        let _ = entry.tx.send(cmd);
    }
}

pub fn close<R: Runtime>(app: &AppHandle<R>, session_id: &str) {
    let entry = app
        .state::<AppState>()
        .terminals
        .lock()
        .unwrap()
        .remove(session_id);
    if let Some(entry) = entry {
        // Close ends a live shell cleanly and cancels one still connecting.
        // The abort is a backstop for a server that stops responding.
        let _ = entry.tx.send(TerminalCmd::Close);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(3)).await;
            entry.task.abort();
        });
    }
}

async fn run<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    generation: u64,
    args: OpenArgs,
    mut rx: mpsc::UnboundedReceiver<TerminalCmd>,
    ready: oneshot::Sender<Result<ConnectInfo, String>>,
) {
    let OpenArgs {
        host,
        cols,
        rows,
        data,
        events,
    } = args;

    // Only Close matters while connecting; the UI re-sends its size once connected.
    let connecting = async {
        let conn = ssh::connect(&app, &host, &events).await?;
        let channel = conn.handle.channel_open_session().await?;
        channel
            .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
            .await?;
        channel.request_shell(true).await?;
        anyhow::Ok((conn, channel))
    };
    let result = tokio::select! {
        r = connecting => r,
        _ = wait_for_close(&mut rx) => {
            let _ = ready.send(Err("Cancelled".into()));
            return;
        }
    };
    let (conn, mut channel) = match result {
        Ok(v) => v,
        Err(e) => {
            let message = format!("{e:#}");
            ssh::status(&events, "error", message.clone());
            let _ = ready.send(Err(message));
            return;
        }
    };

    let state = app.state::<AppState>();
    let history = state.db.start_history(&host.id).ok();
    let _ = app.emit("hosts-changed", ());
    ssh::status(&events, "connected", "");
    let _ = ready.send(Ok(ConnectInfo {
        auth_label: conn.auth_label.clone(),
        fingerprint: conn.fingerprint.clone(),
    }));

    let handle = std::sync::Arc::new(conn.handle);
    state
        .connections
        .lock()
        .unwrap()
        .insert(generation, (host.id.clone(), handle.clone()));
    {
        let (app, handle, host_id) = (app.clone(), handle.clone(), host.id.clone());
        tauri::async_runtime::spawn(async move {
            let probe = "cat /etc/os-release 2>/dev/null || uname -s";
            if let Ok(out) = ssh::exec_capture(&handle, probe).await {
                if let Some((id, name)) = ssh::parse_os(&out) {
                    let _ = app.state::<AppState>().db.set_os(&host_id, &id, &name);
                    let _ = app.emit("hosts-changed", ());
                }
            }
        });
    }

    let mut exit_code = None;
    loop {
        tokio::select! {
            cmd = rx.recv() => match cmd {
                Some(TerminalCmd::Input(bytes)) => {
                    if channel.data_bytes(bytes).await.is_err() { break; }
                }
                Some(TerminalCmd::Resize(c, r)) => { let _ = channel.window_change(c, r, 0, 0).await; }
                Some(TerminalCmd::Close) | None => { let _ = channel.close().await; break; }
            },
            msg = channel.wait() => match msg {
                Some(ChannelMsg::Data { data: bytes }) | Some(ChannelMsg::ExtendedData { data: bytes, .. }) => {
                    if data.send(InvokeResponseBody::Raw(bytes.to_vec())).is_err() { break; }
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => exit_code = Some(exit_status),
                Some(ChannelMsg::Eof) => {}
                Some(ChannelMsg::Close) | None => break,
                _ => {}
            }
        }
    }

    // SFTP may still be using this connection; the last user disconnects.
    state.connections.lock().unwrap().remove(&generation);
    if std::sync::Arc::strong_count(&handle) == 1 {
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
    }
    if let Some(row) = history {
        let _ = state.db.end_history(row);
    }
    let _ = events.send(SessionEvent::Exit { code: exit_code });
    ssh::status(&events, "closed", "");
    let mut terminals = state.terminals.lock().unwrap();
    if terminals
        .get(&session_id)
        .is_some_and(|e| e.generation == generation)
    {
        terminals.remove(&session_id);
    }
}

async fn wait_for_close(rx: &mut mpsc::UnboundedReceiver<TerminalCmd>) {
    while let Some(cmd) = rx.recv().await {
        if matches!(cmd, TerminalCmd::Close) {
            return;
        }
    }
}
