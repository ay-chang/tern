use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use russh::client::Handle;

use crate::db::Db;
use crate::sftp::SftpEntry;
use crate::ssh::{ClientHandler, Prompts};
use crate::terminal::TerminalEntry;

pub struct AppState {
    pub db: Db,
    pub prompts: Arc<Prompts>,
    /// Tern's own known_hosts. ~/.ssh/known_hosts is read but never written.
    pub known_hosts_path: PathBuf,
    pub terminals: Mutex<HashMap<String, TerminalEntry>>,
    /// Live terminal connections as (host id, handle), so SFTP can open a channel
    /// on one instead of logging in again. Keyed per terminal task.
    pub connections: Mutex<HashMap<u64, (String, Arc<Handle<ClientHandler>>)>>,
    pub sftp: Mutex<HashMap<String, SftpEntry>>,
    /// Cancellation flags for running transfers.
    pub transfers: Mutex<HashMap<String, Arc<AtomicBool>>>,
}
