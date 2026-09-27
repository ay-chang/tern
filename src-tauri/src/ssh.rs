//! SSH connection setup shared by terminal and SFTP sessions: TCP connect,
//! host key verification, and authentication.
//!
//! Anything that needs the user (trusting a host key, a password, a key
//! passphrase, a 2FA code) goes out as a `SessionEvent` on the session's event
//! channel and waits for `respond_prompt` to answer it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use russh::client::{self, AuthResult, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::agent::client::AgentClient;
use russh::keys::agent::AgentIdentity;
use russh::keys::{
    self, known_hosts, HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate,
};
use russh::MethodKind;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::oneshot;

use crate::db::Host;
use crate::secrets;
use crate::state::AppState;

#[derive(Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SessionEvent {
    Status {
        state: &'static str,
        message: String,
    },
    HostKey {
        request_id: u64,
        /// "unknown" or "changed"
        status: &'static str,
        host: String,
        port: u16,
        key_type: String,
        fingerprint: String,
        /// False when the conflicting entry is in ~/.ssh/known_hosts, which Tern never edits.
        can_replace: bool,
    },
    Prompt {
        request_id: u64,
        title: String,
        instructions: String,
        fields: Vec<PromptField>,
        allow_save: bool,
    },
    Banner {
        text: String,
    },
    Exit {
        code: Option<u32>,
    },
}

#[derive(Clone, Serialize)]
pub struct PromptField {
    pub label: String,
    pub secret: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptReply {
    pub accept: bool,
    #[serde(default)]
    pub answers: Vec<String>,
    #[serde(default)]
    pub save: bool,
}

/// Pending questions to the UI, keyed by request id.
#[derive(Default)]
pub struct Prompts {
    next: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<PromptReply>>>,
}

impl Prompts {
    async fn ask(
        &self,
        events: &Channel<SessionEvent>,
        build: impl FnOnce(u64) -> SessionEvent,
    ) -> Result<PromptReply> {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);

        struct Cleanup<'a>(&'a Prompts, u64);
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                self.0.pending.lock().unwrap().remove(&self.1);
            }
        }
        let _cleanup = Cleanup(self, id);

        events.send(build(id))?;
        rx.await.map_err(|_| anyhow!("Cancelled"))
    }

    pub fn answer(&self, id: u64, reply: PromptReply) {
        if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
            let _ = tx.send(reply);
        }
    }
}

pub fn status(events: &Channel<SessionEvent>, state: &'static str, message: impl Into<String>) {
    let _ = events.send(SessionEvent::Status {
        state,
        message: message.into(),
    });
}

pub struct ClientHandler {
    host: String,
    port: u16,
    events: Channel<SessionEvent>,
    prompts: Arc<Prompts>,
    known_hosts: PathBuf,
    /// Why the handshake was aborted, since russh only surfaces a generic error.
    rejection: Arc<Mutex<Option<String>>>,
    fingerprint: Arc<Mutex<Option<String>>>,
}

impl client::Handler for ClientHandler {
    type Error = anyhow::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool> {
        let key = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(cert) => PublicKey::from(cert.public_key().clone()),
        };
        *self.fingerprint.lock().unwrap() = Some(key.fingerprint(HashAlg::Sha256).to_string());
        match self.verify_host_key(&key).await {
            Ok(()) => Ok(true),
            Err(e) => {
                *self.rejection.lock().unwrap() = Some(e.to_string());
                Err(e)
            }
        }
    }

    async fn auth_banner(&mut self, banner: &str, _session: &mut client::Session) -> Result<()> {
        let _ = self.events.send(SessionEvent::Banner {
            text: banner.to_string(),
        });
        Ok(())
    }
}

impl ClientHandler {
    async fn verify_host_key(&self, key: &PublicKey) -> Result<()> {
        let mut changed_in_user_file = false;
        if let Some(home) = dirs::home_dir() {
            match known_hosts::check_known_hosts_path(
                &self.host,
                self.port,
                key,
                home.join(".ssh/known_hosts"),
            ) {
                Ok(true) => return Ok(()),
                Err(keys::Error::KeyChanged { .. }) => changed_in_user_file = true,
                _ => {}
            }
        }
        let mut changed_line = None;
        match known_hosts::check_known_hosts_path(&self.host, self.port, key, &self.known_hosts) {
            Ok(true) => return Ok(()),
            Err(keys::Error::KeyChanged { line }) => changed_line = Some(line),
            _ => {}
        }

        let changed = changed_in_user_file || changed_line.is_some();
        let reply = self
            .prompts
            .ask(&self.events, |request_id| SessionEvent::HostKey {
                request_id,
                status: if changed { "changed" } else { "unknown" },
                host: self.host.clone(),
                port: self.port,
                key_type: key.algorithm().as_str().to_string(),
                fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
                can_replace: !changed_in_user_file,
            })
            .await?;
        if !reply.accept {
            bail!("Host key not trusted, connection closed");
        }
        if changed_in_user_file {
            bail!(
                "Host key changed. Remove the old entry with: ssh-keygen -R {}",
                self.host
            );
        }
        if let Some(line) = changed_line {
            remove_line(&self.known_hosts, line)?;
        }
        known_hosts::learn_known_hosts_path(&self.host, self.port, key, &self.known_hosts)?;
        Ok(())
    }
}

/// Drops a 1-based line from Tern's own known_hosts file.
fn remove_line(path: &Path, line: usize) -> Result<()> {
    let contents = std::fs::read_to_string(path)?;
    let kept: Vec<&str> = contents
        .lines()
        .enumerate()
        .filter(|(i, _)| i + 1 != line)
        .map(|(_, l)| l)
        .collect();
    std::fs::write(path, kept.join("\n") + "\n")?;
    Ok(())
}

pub struct Connection {
    pub handle: Handle<ClientHandler>,
    /// How we got in, e.g. "agent · ED25519" — shown in the status bar.
    pub auth_label: String,
    pub fingerprint: String,
}

pub async fn connect<R: Runtime>(
    app: &AppHandle<R>,
    host: &Host,
    events: &Channel<SessionEvent>,
) -> Result<Connection> {
    let state = app.state::<AppState>();
    status(
        events,
        "connecting",
        format!("Connecting to {}:{}…", host.address, host.port),
    );

    let socket = tokio::time::timeout(
        Duration::from_secs(15),
        tokio::net::TcpStream::connect((host.address.as_str(), host.port)),
    )
    .await
    .map_err(|_| anyhow!("Timed out connecting to {}:{}", host.address, host.port))?
    .map_err(|e| anyhow!("Couldn't reach {}:{} ({e})", host.address, host.port))?;
    let _ = socket.set_nodelay(true);

    let config = client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        inactivity_timeout: None,
        nodelay: true,
        ..Default::default()
    };
    let rejection = Arc::new(Mutex::new(None));
    let fingerprint = Arc::new(Mutex::new(None));
    let handler = ClientHandler {
        host: host.address.clone(),
        port: host.port,
        events: events.clone(),
        prompts: state.prompts.clone(),
        known_hosts: state.known_hosts_path.clone(),
        rejection: rejection.clone(),
        fingerprint: fingerprint.clone(),
    };

    let explain = |e: anyhow::Error| match rejection.lock().unwrap().take() {
        Some(reason) => anyhow!(reason),
        None => e,
    };
    let mut handle = client::connect_stream(Arc::new(config), socket, handler)
        .await
        .map_err(explain)?;

    status(
        events,
        "authenticating",
        format!("Authenticating as {}…", host.username),
    );
    let mut auth = Auth {
        handle: &mut handle,
        host,
        events,
        prompts: state.prompts.clone(),
        methods: Vec::new(),
    };
    let auth_label = auth.run(&state).await.map_err(explain)?;
    let fingerprint = fingerprint.lock().unwrap().clone().unwrap_or_default();
    Ok(Connection {
        handle,
        auth_label,
        fingerprint,
    })
}

struct Auth<'a> {
    handle: &'a mut Handle<ClientHandler>,
    host: &'a Host,
    events: &'a Channel<SessionEvent>,
    prompts: Arc<Prompts>,
    /// Methods the server still accepts, updated after every attempt.
    methods: Vec<MethodKind>,
}

impl Auth<'_> {
    fn accepts(&self, m: MethodKind) -> bool {
        self.methods.contains(&m)
    }

    fn outcome(&mut self, r: AuthResult) -> bool {
        match r {
            AuthResult::Success => true,
            AuthResult::Failure {
                remaining_methods, ..
            } => {
                self.methods = remaining_methods.to_vec();
                false
            }
        }
    }

    async fn ask(
        &self,
        title: &str,
        instructions: String,
        fields: Vec<PromptField>,
        allow_save: bool,
    ) -> Result<PromptReply> {
        self.prompts
            .ask(self.events, |request_id| SessionEvent::Prompt {
                request_id,
                title: title.to_string(),
                instructions,
                fields,
                allow_save,
            })
            .await
    }

    async fn run(&mut self, state: &AppState) -> Result<String> {
        let user = self.host.username.clone();
        let r = self.handle.authenticate_none(&user).await?;
        if self.outcome(r) {
            return Ok("none".into());
        }

        if self.host.auth != "password" && self.accepts(MethodKind::PublicKey) {
            if let Some(label) = self.try_public_keys(state).await? {
                return Ok(label);
            }
        }
        if self.accepts(MethodKind::Password) {
            if let Some(label) = self.try_password(state).await? {
                return Ok(label);
            }
        } else if self.accepts(MethodKind::KeyboardInteractive) {
            if let Some(label) = self.try_keyboard_interactive(state).await? {
                return Ok(label);
            }
        }

        if self.host.auth == "key" && (self.host.key_id.is_some() || self.host.key_path.is_some()) {
            bail!("Permission denied: the server rejected the key");
        }
        let offered: Vec<&str> = self.methods.iter().map(<&str>::from).collect();
        if offered.is_empty() {
            bail!("Permission denied");
        }
        bail!(
            "Permission denied. The server accepts: {}",
            offered.join(", ")
        );
    }

    async fn try_public_keys(&mut self, state: &AppState) -> Result<Option<String>> {
        if self.host.auth == "key" {
            if let Some(id) = self.host.key_id.clone() {
                let (key, name) = crate::keychain::load(&state.db, &id)?;
                return self.try_key(key, name).await;
            }
            if let Some(path) = self.host.key_path.clone() {
                return self.try_key_file(&expand_tilde(&path), true).await;
            }
        }

        if let Some(label) = self.try_agent().await? {
            return Ok(Some(label));
        }
        if let Some(home) = dirs::home_dir() {
            for name in ["id_ed25519", "id_ecdsa", "id_rsa"] {
                let path = home.join(".ssh").join(name);
                if path.exists() && self.accepts(MethodKind::PublicKey) {
                    if let Some(label) = self.try_key_file(&path, false).await? {
                        return Ok(Some(label));
                    }
                }
            }
        }
        Ok(None)
    }

    async fn rsa_hash(&self, key_is_rsa: bool) -> Result<Option<HashAlg>> {
        if !key_is_rsa {
            return Ok(None);
        }
        Ok(self.handle.best_supported_rsa_hash().await?.flatten())
    }

    async fn try_agent(&mut self) -> Result<Option<String>> {
        let Some(mut agent) = connect_agent().await else {
            return Ok(None);
        };
        let Ok(identities) = agent.request_identities().await else {
            return Ok(None);
        };
        let user = self.host.username.clone();
        for identity in identities {
            let AgentIdentity::PublicKey { key, .. } = identity else {
                continue;
            };
            if !self.accepts(MethodKind::PublicKey) {
                break;
            }
            let hash = self.rsa_hash(key.algorithm().is_rsa()).await?;
            let label = format!("agent · {}", crate::keychain::algorithm_label(&key));
            if let Ok(r) = self
                .handle
                .authenticate_publickey_with(&user, key, hash, &mut agent)
                .await
            {
                if self.outcome(r) {
                    return Ok(Some(label));
                }
            }
        }
        Ok(None)
    }

    /// `explicit` keys report read errors; auto-discovered ones are skipped quietly.
    async fn try_key_file(&mut self, path: &Path, explicit: bool) -> Result<Option<String>> {
        let display = tilde_path(path);
        let key = match keys::load_secret_key(path, None) {
            Ok(k) => k,
            Err(keys::Error::KeyIsEncrypted) => {
                let account = secrets::key_passphrase_account(&path.to_string_lossy());
                let saved = secrets::get(&account);
                let mut attempt = 0;
                loop {
                    let (pass, save) = match (&saved, attempt) {
                        (Some(p), 0) => (p.clone(), false),
                        _ => {
                            let note = if attempt > 0 {
                                "That passphrase didn't work. "
                            } else {
                                ""
                            };
                            let reply = self
                                .ask(
                                    "Key passphrase",
                                    format!("{note}Enter the passphrase for {display}."),
                                    vec![PromptField {
                                        label: "Passphrase".into(),
                                        secret: true,
                                    }],
                                    true,
                                )
                                .await?;
                            if !reply.accept {
                                return Ok(None);
                            }
                            (
                                reply.answers.into_iter().next().unwrap_or_default(),
                                reply.save,
                            )
                        }
                    };
                    match keys::load_secret_key(path, Some(&pass)) {
                        Ok(k) => {
                            if save {
                                let _ = secrets::set(&account, &pass);
                            }
                            break k;
                        }
                        Err(_) if attempt < 3 => attempt += 1,
                        Err(_) => return Ok(None),
                    }
                }
            }
            Err(e) if explicit => bail!("Couldn't read key {display}: {e}"),
            Err(_) => return Ok(None),
        };

        self.try_key(key, display).await
    }

    async fn try_key(&mut self, key: keys::PrivateKey, name: String) -> Result<Option<String>> {
        let hash = self.rsa_hash(key.algorithm().is_rsa()).await?;
        let label = format!(
            "{name} · {}",
            crate::keychain::algorithm_label(key.public_key())
        );
        let r = self
            .handle
            .authenticate_publickey(
                &self.host.username,
                PrivateKeyWithHashAlg::new(Arc::new(key), hash),
            )
            .await?;
        Ok(self.outcome(r).then_some(label))
    }

    async fn try_password(&mut self, state: &AppState) -> Result<Option<String>> {
        let account = secrets::host_password_account(&self.host.id);
        let saved = if self.host.has_password {
            secrets::get(&account)
        } else {
            None
        };
        let label = format!("Password for {}@{}", self.host.username, self.host.address);
        for attempt in 0..4 {
            let (password, save) = match (&saved, attempt) {
                (Some(p), 0) => (p.clone(), false),
                _ => {
                    let note = if attempt > 0 {
                        "Permission denied, try again."
                    } else {
                        ""
                    };
                    let reply = self
                        .ask(
                            "Password",
                            note.into(),
                            vec![PromptField {
                                label: label.clone(),
                                secret: true,
                            }],
                            true,
                        )
                        .await?;
                    if !reply.accept {
                        bail!("Authentication cancelled");
                    }
                    (
                        reply.answers.into_iter().next().unwrap_or_default(),
                        reply.save,
                    )
                }
            };
            let r = self
                .handle
                .authenticate_password(&self.host.username, &password)
                .await?;
            if self.outcome(r) {
                if save {
                    self.remember_password(state, &account, &password);
                }
                return Ok(Some("password".into()));
            }
            if !self.accepts(MethodKind::Password) {
                break;
            }
        }
        Ok(None)
    }

    /// Keyboard-interactive covers servers that ask for the password this way,
    /// plus one-time codes and other challenges, which are forwarded to the UI.
    async fn try_keyboard_interactive(&mut self, state: &AppState) -> Result<Option<String>> {
        let account = secrets::host_password_account(&self.host.id);
        let mut saved = if self.host.has_password {
            secrets::get(&account)
        } else {
            None
        };
        for _round in 0..3 {
            let mut to_save: Option<String> = None;
            let mut resp = self
                .handle
                .authenticate_keyboard_interactive_start(&self.host.username, None)
                .await?;
            loop {
                match resp {
                    KeyboardInteractiveAuthResponse::Success => {
                        if let Some(p) = to_save {
                            self.remember_password(state, &account, &p);
                        }
                        return Ok(Some("keyboard-interactive".into()));
                    }
                    KeyboardInteractiveAuthResponse::Failure {
                        remaining_methods, ..
                    } => {
                        self.methods = remaining_methods.to_vec();
                        break;
                    }
                    KeyboardInteractiveAuthResponse::InfoRequest {
                        name,
                        instructions,
                        prompts,
                    } => {
                        let is_password = prompts.len() == 1
                            && !prompts[0].echo
                            && prompts[0].prompt.to_lowercase().contains("password");
                        let answers = if prompts.is_empty() {
                            Vec::new()
                        } else if let (true, Some(p)) = (is_password, saved.take()) {
                            vec![p]
                        } else {
                            let title = if name.trim().is_empty() {
                                "Authentication"
                            } else {
                                name.trim()
                            };
                            let reply = self
                                .ask(
                                    title,
                                    instructions.trim().to_string(),
                                    prompts
                                        .iter()
                                        .map(|p| PromptField {
                                            label: p.prompt.trim().to_string(),
                                            secret: !p.echo,
                                        })
                                        .collect(),
                                    is_password,
                                )
                                .await?;
                            if !reply.accept {
                                bail!("Authentication cancelled");
                            }
                            if is_password && reply.save {
                                to_save = reply.answers.first().cloned();
                            }
                            reply.answers
                        };
                        resp = self
                            .handle
                            .authenticate_keyboard_interactive_respond(answers)
                            .await?;
                    }
                }
            }
            if !self.accepts(MethodKind::KeyboardInteractive) {
                break;
            }
        }
        Ok(None)
    }

    fn remember_password(&self, state: &AppState, account: &str, password: &str) {
        if secrets::set(account, password).is_ok() {
            let _ = state.db.set_has_password(&self.host.id, true);
        }
    }
}

type DynAgent = AgentClient<Box<dyn keys::agent::client::AgentStream + Send + Unpin + 'static>>;

async fn connect_agent() -> Option<DynAgent> {
    #[cfg(unix)]
    {
        AgentClient::connect_env().await.ok().map(|a| a.dynamic())
    }
    #[cfg(windows)]
    {
        AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent")
            .await
            .ok()
            .map(|a| a.dynamic())
    }
}

pub fn expand_tilde(path: &str) -> PathBuf {
    match (path.strip_prefix("~/"), dirs::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(path),
    }
}

fn tilde_path(path: &Path) -> String {
    if let Some(home) = dirs::home_dir() {
        if let Ok(rest) = path.strip_prefix(&home) {
            return format!("~/{}", rest.display());
        }
    }
    path.display().to_string()
}

/// Runs a command on its own channel and returns stdout, for small probes like OS detection.
pub async fn exec_capture(handle: &Handle<ClientHandler>, command: &str) -> Result<String> {
    let mut channel = handle.channel_open_session().await?;
    channel.exec(true, command).await?;
    let mut out = Vec::new();
    let read = async {
        while let Some(msg) = channel.wait().await {
            match msg {
                russh::ChannelMsg::Data { data } => out.extend_from_slice(&data),
                russh::ChannelMsg::Eof | russh::ChannelMsg::Close => break,
                _ => {}
            }
        }
    };
    let _ = tokio::time::timeout(Duration::from_secs(5), read).await;
    Ok(String::from_utf8_lossy(&out).into_owned())
}

/// Returns (short id, pretty name) from `/etc/os-release` or `uname` output.
pub fn parse_os(output: &str) -> Option<(String, String)> {
    let mut id = None;
    let mut pretty = None;
    for line in output.lines() {
        let unquote = |v: &str| v.trim().trim_matches('"').to_string();
        if let Some(v) = line.strip_prefix("ID=") {
            id = Some(unquote(v));
        } else if let Some(v) = line.strip_prefix("PRETTY_NAME=") {
            pretty = Some(unquote(v));
        }
    }
    if let Some(id) = id {
        let name = pretty.unwrap_or_else(|| id.clone());
        return Some((id, name));
    }
    let first = output.lines().next()?.trim();
    match first {
        "Darwin" => Some(("macos".into(), "macOS".into())),
        "" => None,
        other => Some((other.to_lowercase(), other.to_string())),
    }
}
