mod db;
mod keychain;
mod secrets;
mod sftp;
mod ssh;
mod state;
mod terminal;
#[cfg(test)]
mod tests;
mod vault;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};

use db::{Db, Group, HistoryEntry, Host, HostInput, KeyInfo};
use sftp::{FileEntry, SftpInfo, TransferRequest};
use ssh::{PromptReply, SessionEvent};
use state::AppState;
use terminal::{ConnectInfo, TerminalCmd};

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
fn list_hosts(state: State<AppState>) -> CmdResult<Vec<Host>> {
    state.db.list_hosts().map_err(err)
}

#[tauri::command]
fn list_groups(state: State<AppState>) -> CmdResult<Vec<Group>> {
    state.db.list_groups().map_err(err)
}

/// `password`: omitted leaves the saved password alone, "" removes it, anything else replaces it.
#[tauri::command]
fn save_host(
    state: State<AppState>,
    input: HostInput,
    password: Option<String>,
) -> CmdResult<Host> {
    let id = state.db.save_host(&input).map_err(err)?;
    let account = secrets::host_password_account(&id);
    match password.as_deref() {
        None => {}
        Some("") => {
            secrets::delete(&account);
            state.db.set_has_password(&id, false).map_err(err)?;
        }
        Some(pw) => {
            secrets::set(&account, pw)
                .map_err(|e| format!("Couldn't save the password to the keychain: {e}"))?;
            state.db.set_has_password(&id, true).map_err(err)?;
        }
    }
    state.db.get_host(&id).map_err(err)
}

#[tauri::command]
fn delete_host(state: State<AppState>, id: String) -> CmdResult<()> {
    secrets::delete(&secrets::host_password_account(&id));
    state.db.delete_host(&id).map_err(err)
}

#[tauri::command]
fn host_history(state: State<AppState>, id: String) -> CmdResult<Vec<HistoryEntry>> {
    state.db.host_history(&id, 5).map_err(err)
}

#[tauri::command]
fn list_keys(state: State<AppState>) -> CmdResult<Vec<KeyInfo>> {
    state.db.list_keys().map_err(err)
}

/// Imports from `private_key` text, or reads `path` when no text is given.
#[tauri::command]
fn import_key(
    state: State<AppState>,
    name: String,
    private_key: Option<String>,
    path: Option<String>,
    passphrase: Option<String>,
) -> CmdResult<KeyInfo> {
    keychain::import(&state.db, &name, private_key, path, passphrase).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn generate_key(state: State<AppState>, name: String) -> CmdResult<KeyInfo> {
    keychain::generate(&state.db, &name).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn rename_key(state: State<AppState>, id: String, name: String) -> CmdResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Name can't be empty".into());
    }
    state.db.rename_key(&id, name).map_err(err)
}

#[tauri::command]
fn delete_key(state: State<AppState>, id: String) -> CmdResult<()> {
    state.db.delete_key(&id).map_err(err)
}

#[derive(Deserialize)]
struct ProbeTarget {
    id: String,
    address: String,
    port: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeResult {
    id: String,
    latency_ms: Option<u32>,
}

/// TCP reachability and connect latency, for the status dots in the host list.
#[tauri::command]
async fn probe_hosts(targets: Vec<ProbeTarget>) -> Vec<ProbeResult> {
    let mut set = tokio::task::JoinSet::new();
    for t in targets {
        set.spawn(async move {
            let start = Instant::now();
            let ok = tokio::time::timeout(
                Duration::from_secs(3),
                tokio::net::TcpStream::connect((t.address.as_str(), t.port)),
            )
            .await
            .is_ok_and(|r| r.is_ok());
            ProbeResult {
                id: t.id,
                latency_ms: ok.then(|| start.elapsed().as_millis() as u32),
            }
        });
    }
    let mut out = Vec::new();
    while let Some(Ok(r)) = set.join_next().await {
        out.push(r);
    }
    out
}

#[tauri::command]
async fn terminal_open(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    host_id: String,
    cols: u32,
    rows: u32,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<SessionEvent>,
) -> CmdResult<ConnectInfo> {
    let host = state.db.get_host(&host_id).map_err(err)?;
    let args = terminal::OpenArgs {
        host,
        cols,
        rows,
        data: on_data,
        events: on_event,
    };
    terminal::open(app, session_id, args).await
}

#[tauri::command]
fn terminal_write(app: AppHandle, session_id: String, data: String) {
    terminal::send(&app, &session_id, TerminalCmd::Input(data.into_bytes()));
}

#[tauri::command]
fn terminal_resize(app: AppHandle, session_id: String, cols: u32, rows: u32) {
    terminal::send(&app, &session_id, TerminalCmd::Resize(cols, rows));
}

#[tauri::command]
fn terminal_close(app: AppHandle, session_id: String) {
    terminal::close(&app, &session_id);
}

#[tauri::command]
fn respond_prompt(state: State<AppState>, request_id: u64, reply: PromptReply) {
    state.prompts.answer(request_id, reply);
}

#[tauri::command]
async fn sftp_open(
    app: AppHandle,
    state: State<'_, AppState>,
    sftp_id: String,
    host_id: String,
    on_event: Channel<SessionEvent>,
) -> CmdResult<SftpInfo> {
    let host = state.db.get_host(&host_id).map_err(err)?;
    sftp::open(&app, host, sftp_id, on_event)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn sftp_close(app: AppHandle, sftp_id: String) {
    sftp::close(&app, &sftp_id).await;
}

#[tauri::command]
async fn sftp_list(app: AppHandle, sftp_id: String, path: String) -> CmdResult<Vec<FileEntry>> {
    sftp::list(&app, &sftp_id, &path).await
}

#[tauri::command]
async fn sftp_mkdir(app: AppHandle, sftp_id: String, path: String) -> CmdResult<()> {
    sftp::mkdir(&app, &sftp_id, &path).await
}

#[tauri::command]
async fn sftp_rename(app: AppHandle, sftp_id: String, from: String, to: String) -> CmdResult<()> {
    sftp::rename(&app, &sftp_id, &from, &to).await
}

#[tauri::command]
async fn sftp_remove(app: AppHandle, sftp_id: String, path: String, is_dir: bool) -> CmdResult<()> {
    sftp::remove(&app, &sftp_id, &path, is_dir).await
}

#[tauri::command]
fn local_home() -> String {
    sftp::local_home()
}

#[tauri::command]
async fn local_list(path: String) -> CmdResult<Vec<FileEntry>> {
    sftp::local_list(&path)
}

#[tauri::command]
fn local_mkdir(path: String) -> CmdResult<()> {
    sftp::local_mkdir(&path)
}

#[tauri::command]
fn transfer_start(app: AppHandle, request: TransferRequest) -> CmdResult<()> {
    sftp::start_transfer(app, request)
}

#[tauri::command]
fn transfer_cancel(app: AppHandle, id: String) {
    sftp::cancel_transfer(&app, &id);
}

#[cfg(target_os = "macos")]
fn build_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
    use tauri::Emitter;

    let sep = || PredefinedMenuItem::separator(app);
    let app_menu = Submenu::with_items(
        app,
        "Tern",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Tern"), None)?,
            &sep()?,
            &MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?,
            &sep()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &sep()?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    // ⌘W closes the active tab, not the window, so the menu owns that shortcut.
    let session = Submenu::with_items(
        app,
        "Session",
        true,
        &[
            &MenuItem::with_id(
                app,
                "new-connection",
                "New Connection…",
                true,
                Some("CmdOrCtrl+T"),
            )?,
            &MenuItem::with_id(app, "new-host", "New Host…", true, Some("CmdOrCtrl+N"))?,
            &sep()?,
            &MenuItem::with_id(app, "close-tab", "Close Tab", true, Some("CmdOrCtrl+W"))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &sep()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItem::with_id(
                app,
                "toggle-sidebar",
                "Toggle Sidebar",
                true,
                Some("CmdOrCtrl+B"),
            )?,
            &MenuItem::with_id(app, "palette", "Command Palette", true, Some("CmdOrCtrl+K"))?,
            &sep()?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
        ],
    )?;
    app.set_menu(Menu::with_items(
        app,
        &[&app_menu, &session, &edit, &view, &window],
    )?)?;
    app.on_menu_event(|app, event| {
        let _ = app.emit("menu", event.id().0.as_str());
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let db = Db::open(&data_dir.join("tern.db"))?;
            app.manage(AppState {
                db,
                prompts: Arc::new(ssh::Prompts::default()),
                known_hosts_path: data_dir.join("known_hosts"),
                terminals: Mutex::new(HashMap::new()),
                connections: Mutex::new(HashMap::new()),
                sftp: Mutex::new(HashMap::new()),
                transfers: Mutex::new(HashMap::new()),
            });
            #[cfg(target_os = "macos")]
            build_menu(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_hosts,
            list_groups,
            save_host,
            delete_host,
            host_history,
            probe_hosts,
            list_keys,
            import_key,
            generate_key,
            rename_key,
            delete_key,
            terminal_open,
            terminal_write,
            terminal_resize,
            terminal_close,
            respond_prompt,
            sftp_open,
            sftp_close,
            sftp_list,
            sftp_mkdir,
            sftp_rename,
            sftp_remove,
            local_home,
            local_list,
            local_mkdir,
            transfer_start,
            transfer_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tern");
}
