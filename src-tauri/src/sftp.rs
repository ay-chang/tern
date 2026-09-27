//! SFTP sessions, local file listing, and the transfer queue.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, UNIX_EPOCH};

use anyhow::{anyhow, Result};
use russh::client::Handle;
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::db::Host;
use crate::ssh::{self, ClientHandler, SessionEvent};
use crate::state::AppState;

pub struct SftpEntry {
    sftp: Arc<SftpSession>,
    handle: Arc<Handle<ClientHandler>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    /// "dir", "file", "link" or "other"
    pub kind: &'static str,
    /// True for directories and for links that point at one.
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<i64>,
    pub executable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpInfo {
    pub home: String,
}

fn session<R: Runtime>(app: &AppHandle<R>, sftp_id: &str) -> Result<Arc<SftpSession>, String> {
    app.state::<AppState>()
        .sftp
        .lock()
        .unwrap()
        .get(sftp_id)
        .map(|e| e.sftp.clone())
        .ok_or_else(|| "SFTP session is closed".to_string())
}

pub fn remote_join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

fn remote_name(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path)
        .to_string()
}

fn sort_entries(entries: &mut [FileEntry]) {
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

pub async fn open<R: Runtime>(
    app: &AppHandle<R>,
    host: Host,
    sftp_id: String,
    events: Channel<SessionEvent>,
) -> Result<SftpInfo> {
    // Reuse an open terminal's connection to this host so there's no second login.
    let shared = app
        .state::<AppState>()
        .connections
        .lock()
        .unwrap()
        .values()
        .find(|(host_id, _)| host_id == &host.id)
        .map(|(_, handle)| handle.clone());
    let reused = match shared {
        Some(handle) => start_sftp(&handle).await.ok().map(|sftp| (handle, sftp)),
        None => None,
    };
    let (handle, sftp) = match reused {
        Some(pair) => pair,
        None => {
            let conn = ssh::connect(app, &host, &events).await?;
            let handle = Arc::new(conn.handle);
            let sftp = start_sftp(&handle).await?;
            (handle, sftp)
        }
    };
    let home = sftp.canonicalize(".").await.unwrap_or_else(|_| "/".into());
    ssh::status(&events, "connected", "");
    app.state::<AppState>().sftp.lock().unwrap().insert(
        sftp_id,
        SftpEntry {
            sftp: Arc::new(sftp),
            handle,
        },
    );
    Ok(SftpInfo { home })
}

async fn start_sftp(handle: &Handle<ClientHandler>) -> Result<SftpSession> {
    let channel = handle.channel_open_session().await?;
    channel.request_subsystem(true, "sftp").await?;
    SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| anyhow!("The server doesn't support SFTP ({e})"))
}

pub async fn close<R: Runtime>(app: &AppHandle<R>, sftp_id: &str) {
    let entry = app.state::<AppState>().sftp.lock().unwrap().remove(sftp_id);
    if let Some(entry) = entry {
        let _ = entry.sftp.close().await;
        // A terminal may share this connection; only the last user disconnects.
        if Arc::strong_count(&entry.handle) == 1 {
            let _ = entry
                .handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
        }
    }
}

pub async fn list<R: Runtime>(
    app: &AppHandle<R>,
    sftp_id: &str,
    path: &str,
) -> Result<Vec<FileEntry>, String> {
    let sftp = session(app, sftp_id)?;
    let dir = sftp
        .read_dir(path)
        .await
        .map_err(|e| format!("Couldn't open {path}: {e}"))?;
    let mut entries = Vec::new();
    for entry in dir {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let meta = entry.metadata();
        let full = remote_join(path, &name);
        let (kind, is_dir) = if meta.is_dir() {
            ("dir", true)
        } else if meta.is_symlink() {
            let target_dir = sftp
                .metadata(full.clone())
                .await
                .map(|m| m.is_dir())
                .unwrap_or(false);
            ("link", target_dir)
        } else if meta.is_regular() {
            ("file", false)
        } else {
            ("other", false)
        };
        entries.push(FileEntry {
            name,
            path: full,
            kind,
            is_dir,
            size: meta.size.unwrap_or(0),
            modified: meta.mtime.map(i64::from),
            executable: meta.permissions.is_some_and(|p| p & 0o111 != 0),
        });
    }
    sort_entries(&mut entries);
    Ok(entries)
}

pub async fn mkdir<R: Runtime>(
    app: &AppHandle<R>,
    sftp_id: &str,
    path: &str,
) -> Result<(), String> {
    session(app, sftp_id)?
        .create_dir(path)
        .await
        .map_err(|e| e.to_string())
}

pub async fn rename<R: Runtime>(
    app: &AppHandle<R>,
    sftp_id: &str,
    from: &str,
    to: &str,
) -> Result<(), String> {
    session(app, sftp_id)?
        .rename(from, to)
        .await
        .map_err(|e| e.to_string())
}

pub async fn remove<R: Runtime>(
    app: &AppHandle<R>,
    sftp_id: &str,
    path: &str,
    is_dir: bool,
) -> Result<(), String> {
    let sftp = session(app, sftp_id)?;
    if !is_dir {
        return sftp.remove_file(path).await.map_err(|e| e.to_string());
    }
    // Depth-first: collect everything, then delete files before their directories.
    let mut dirs = vec![path.to_string()];
    let mut i = 0;
    let mut files = Vec::new();
    while i < dirs.len() {
        let dir = dirs[i].clone();
        for entry in sftp
            .read_dir(dir.clone())
            .await
            .map_err(|e| e.to_string())?
        {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let full = remote_join(&dir, &name);
            if entry.metadata().is_dir() {
                dirs.push(full);
            } else {
                files.push(full);
            }
        }
        i += 1;
    }
    for f in files {
        sftp.remove_file(f).await.map_err(|e| e.to_string())?;
    }
    for d in dirs.into_iter().rev() {
        sftp.remove_dir(d).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn local_home() -> String {
    dirs::home_dir()
        .map(|h| h.display().to_string())
        .unwrap_or_else(|| "/".into())
}

pub fn local_list(path: &str) -> Result<Vec<FileEntry>, String> {
    let read = std::fs::read_dir(path).map_err(|e| format!("Couldn't open {path}: {e}"))?;
    let mut entries = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let full = entry.path();
        let Ok(link_meta) = entry.metadata() else {
            continue;
        };
        let is_link = link_meta.file_type().is_symlink();
        let meta = if is_link {
            std::fs::metadata(&full).unwrap_or(link_meta)
        } else {
            link_meta
        };
        let kind = if is_link {
            "link"
        } else if meta.is_dir() {
            "dir"
        } else if meta.is_file() {
            "file"
        } else {
            "other"
        };
        #[cfg(unix)]
        let executable = {
            use std::os::unix::fs::PermissionsExt;
            meta.is_file() && meta.permissions().mode() & 0o111 != 0
        };
        #[cfg(not(unix))]
        let executable = false;
        entries.push(FileEntry {
            name,
            path: full.display().to_string(),
            kind,
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            modified: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64),
            executable,
        });
    }
    sort_entries(&mut entries);
    Ok(entries)
}

pub fn local_mkdir(path: &str) -> Result<(), String> {
    std::fs::create_dir(path).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferRequest {
    pub id: String,
    pub sftp_id: String,
    /// "upload" (local → remote) or "download" (remote → local)
    pub direction: String,
    /// The file or directory being copied.
    pub source: String,
    /// The directory it's copied into.
    pub dest_dir: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TransferEvent {
    id: String,
    direction: String,
    name: String,
    dest: String,
    bytes: u64,
    total: u64,
    /// "running", "done", "failed" or "cancelled"
    state: &'static str,
    error: Option<String>,
}

struct Item {
    src: String,
    dst: String,
    size: u64,
    is_dir: bool,
}

pub fn start_transfer<R: Runtime>(app: AppHandle<R>, req: TransferRequest) -> Result<(), String> {
    let sftp = session(&app, &req.sftp_id)?;
    let cancel = Arc::new(AtomicBool::new(false));
    app.state::<AppState>()
        .transfers
        .lock()
        .unwrap()
        .insert(req.id.clone(), cancel.clone());
    tauri::async_runtime::spawn(async move {
        let upload = req.direction == "upload";
        let name = if upload {
            Path::new(&req.source)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default()
        } else {
            remote_name(&req.source)
        };
        let mut event = TransferEvent {
            id: req.id.clone(),
            direction: req.direction.clone(),
            name,
            dest: req.dest_dir.clone(),
            bytes: 0,
            total: 0,
            state: "running",
            error: None,
        };
        let _ = app.emit("transfer", event.clone());

        let result = run_transfer(&app, &sftp, &req, &cancel, &mut event).await;
        match result {
            Ok(()) => event.state = "done",
            Err(_) if cancel.load(Ordering::Relaxed) => event.state = "cancelled",
            Err(e) => {
                event.state = "failed";
                event.error = Some(format!("{e:#}"));
            }
        }
        let _ = app.emit("transfer", event);
        app.state::<AppState>()
            .transfers
            .lock()
            .unwrap()
            .remove(&req.id);
    });
    Ok(())
}

pub fn cancel_transfer<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if let Some(flag) = app.state::<AppState>().transfers.lock().unwrap().get(id) {
        flag.store(true, Ordering::Relaxed);
    }
}

async fn run_transfer<R: Runtime>(
    app: &AppHandle<R>,
    sftp: &SftpSession,
    req: &TransferRequest,
    cancel: &AtomicBool,
    event: &mut TransferEvent,
) -> Result<()> {
    let upload = req.direction == "upload";
    let items = if upload {
        plan_upload(Path::new(&req.source), &req.dest_dir)?
    } else {
        plan_download(sftp, &req.source, Path::new(&req.dest_dir)).await?
    };
    event.total = items.iter().map(|i| i.size).sum();

    let mut last_emit = Instant::now();
    let mut buf = vec![0u8; 256 * 1024];
    for item in &items {
        if cancel.load(Ordering::Relaxed) {
            return Err(anyhow!("cancelled"));
        }
        if item.is_dir {
            if upload {
                // An existing directory is fine; anything else surfaces on the first file write.
                let _ = sftp.create_dir(item.dst.clone()).await;
            } else {
                tokio::fs::create_dir_all(&item.dst).await?;
            }
            continue;
        }

        let (mut reader, mut writer): (
            Box<dyn tokio::io::AsyncRead + Unpin + Send>,
            Box<dyn tokio::io::AsyncWrite + Unpin + Send>,
        ) = if upload {
            (
                Box::new(tokio::fs::File::open(&item.src).await?),
                Box::new(
                    sftp.create(item.dst.clone())
                        .await
                        .map_err(|e| anyhow!("{}: {e}", item.dst))?,
                ),
            )
        } else {
            (
                Box::new(
                    sftp.open(item.src.clone())
                        .await
                        .map_err(|e| anyhow!("{}: {e}", item.src))?,
                ),
                Box::new(tokio::fs::File::create(&item.dst).await?),
            )
        };
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(anyhow!("cancelled"));
            }
            let n = reader.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            writer.write_all(&buf[..n]).await?;
            event.bytes += n as u64;
            if last_emit.elapsed() > Duration::from_millis(120) {
                let _ = app.emit("transfer", event.clone());
                last_emit = Instant::now();
            }
        }
        writer.shutdown().await?;
    }
    Ok(())
}

fn plan_upload(src: &Path, dest_dir: &str) -> Result<Vec<Item>> {
    let mut items = Vec::new();
    let name = src
        .file_name()
        .ok_or_else(|| anyhow!("Invalid source"))?
        .to_string_lossy()
        .into_owned();
    let mut stack: Vec<(PathBuf, String)> = vec![(src.to_path_buf(), remote_join(dest_dir, &name))];
    while let Some((local, remote)) = stack.pop() {
        let meta = std::fs::metadata(&local)?;
        if meta.is_dir() {
            items.push(Item {
                src: local.display().to_string(),
                dst: remote.clone(),
                size: 0,
                is_dir: true,
            });
            for entry in std::fs::read_dir(&local)?.flatten() {
                let child = entry.file_name().to_string_lossy().into_owned();
                stack.push((entry.path(), remote_join(&remote, &child)));
            }
        } else if meta.is_file() {
            items.push(Item {
                src: local.display().to_string(),
                dst: remote,
                size: meta.len(),
                is_dir: false,
            });
        }
    }
    // Directories were pushed before their children, so creation order is already correct.
    Ok(items)
}

async fn plan_download(sftp: &SftpSession, src: &str, dest_dir: &Path) -> Result<Vec<Item>> {
    let mut items = Vec::new();
    let mut stack = vec![(src.to_string(), dest_dir.join(remote_name(src)))];
    while let Some((remote, local)) = stack.pop() {
        let meta = sftp
            .metadata(remote.clone())
            .await
            .map_err(|e| anyhow!("{remote}: {e}"))?;
        if meta.is_dir() {
            items.push(Item {
                src: remote.clone(),
                dst: local.display().to_string(),
                size: 0,
                is_dir: true,
            });
            for entry in sftp.read_dir(remote.clone()).await? {
                let name = entry.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                stack.push((remote_join(&remote, &name), local.join(&name)));
            }
        } else {
            items.push(Item {
                src: remote,
                dst: local.display().to_string(),
                size: meta.size.unwrap_or(0),
                is_dir: false,
            });
        }
    }
    Ok(items)
}
