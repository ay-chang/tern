//! Local SQLite store for hosts, groups and session history.
//!
//! Secrets never live here — see `secrets.rs`. Every record carries a UUID and
//! `updated_at` so an encrypted sync layer can be added later without a rewrite.

use std::path::Path;
use std::sync::Mutex;

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

/// Colors cycle through the design's accent tokens as groups are created.
const GROUP_COLORS: [&str; 5] = ["r", "a", "b", "g", "p"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: String,
    pub name: String,
    pub address: String,
    pub port: u16,
    pub username: String,
    pub group_id: Option<String>,
    /// "auto" (agent + default keys, then password), "password" or "key".
    pub auth: String,
    pub key_path: Option<String>,
    /// A key from the keychain; takes precedence over `key_path`.
    pub key_id: Option<String>,
    pub tags: Vec<String>,
    pub os_id: Option<String>,
    pub os_name: Option<String>,
    pub has_password: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_connected_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub started_at: i64,
    pub ended_at: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInput {
    pub id: Option<String>,
    pub name: String,
    pub address: String,
    pub port: u16,
    pub username: String,
    pub group_name: Option<String>,
    pub auth: String,
    pub key_path: Option<String>,
    #[serde(default)]
    pub key_id: Option<String>,
    pub tags: Vec<String>,
}

/// A keychain entry as the UI sees it. The private key never leaves the backend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    pub id: String,
    pub name: String,
    /// e.g. "ED25519", "RSA 4096", "ECDSA P-256"
    pub algorithm: String,
    pub fingerprint: String,
    /// OpenSSH one-line public key, ready for authorized_keys.
    pub public_key: String,
    /// Whether the stored key is protected by a passphrase (which is stored too).
    pub encrypted: bool,
    pub host_count: u32,
    pub created_at: i64,
}

pub struct NewKey<'a> {
    pub name: &'a str,
    pub algorithm: &'a str,
    pub fingerprint: &'a str,
    pub public_key: &'a str,
    pub sealed_private: &'a [u8],
    pub sealed_passphrase: Option<&'a [u8]>,
}

pub struct Db {
    conn: Mutex<Connection>,
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

const HOST_COLUMNS: &str = "id, name, address, port, username, group_id, auth, key_path, tags, \
     os_id, os_name, has_password, created_at, updated_at, \
     (SELECT MAX(started_at) FROM history WHERE history.host_id = hosts.id), key_id";

fn host_from_row(row: &Row) -> rusqlite::Result<Host> {
    let tags: String = row.get(8)?;
    Ok(Host {
        id: row.get(0)?,
        name: row.get(1)?,
        address: row.get(2)?,
        port: row.get(3)?,
        username: row.get(4)?,
        group_id: row.get(5)?,
        auth: row.get(6)?,
        key_path: row.get(7)?,
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        os_id: row.get(9)?,
        os_name: row.get(10)?,
        has_password: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
        last_connected_at: row.get(14)?,
        key_id: row.get(15)?,
    })
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn list_hosts(&self) -> Result<Vec<Host>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {HOST_COLUMNS} FROM hosts ORDER BY name COLLATE NOCASE"
        ))?;
        let hosts = stmt
            .query_map([], host_from_row)?
            .collect::<rusqlite::Result<_>>()?;
        Ok(hosts)
    }

    pub fn get_host(&self, id: &str) -> Result<Host> {
        let conn = self.conn();
        conn.query_row(
            &format!("SELECT {HOST_COLUMNS} FROM hosts WHERE id = ?1"),
            [id],
            host_from_row,
        )
        .optional()?
        .ok_or_else(|| anyhow!("Host not found"))
    }

    pub fn list_groups(&self) -> Result<Vec<Group>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT id, name, color FROM groups ORDER BY sort, name")?;
        let groups = stmt
            .query_map([], |r| {
                Ok(Group {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    color: r.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(groups)
    }

    /// Inserts or updates a host. Groups are referenced by name and created on demand.
    pub fn save_host(&self, input: &HostInput) -> Result<String> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let ts = now();

        let group_id = match input
            .group_name
            .as_deref()
            .map(str::trim)
            .filter(|g| !g.is_empty())
        {
            None => None,
            Some(name) => {
                let existing: Option<String> = tx
                    .query_row(
                        "SELECT id FROM groups WHERE name = ?1 COLLATE NOCASE",
                        [name],
                        |r| r.get(0),
                    )
                    .optional()?;
                match existing {
                    Some(id) => Some(id),
                    None => {
                        let count: i64 =
                            tx.query_row("SELECT COUNT(*) FROM groups", [], |r| r.get(0))?;
                        let id = uuid::Uuid::new_v4().to_string();
                        let color = GROUP_COLORS[count as usize % GROUP_COLORS.len()];
                        tx.execute(
                            "INSERT INTO groups (id, name, color, sort, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                            params![id, name, color, count, ts],
                        )?;
                        Some(id)
                    }
                }
            }
        };

        let tags = serde_json::to_string(&input.tags)?;
        let key_path = input
            .key_path
            .as_deref()
            .map(str::trim)
            .filter(|k| !k.is_empty());
        let key_id = input.key_id.as_deref().filter(|_| input.auth == "key");
        let id = match &input.id {
            Some(id) => {
                let changed = tx.execute(
                    "UPDATE hosts SET name = ?2, address = ?3, port = ?4, username = ?5, group_id = ?6, \
                     auth = ?7, key_path = ?8, tags = ?9, updated_at = ?10, key_id = ?11 WHERE id = ?1",
                    params![id, input.name, input.address, input.port, input.username, group_id, input.auth, key_path, tags, ts, key_id],
                )?;
                if changed == 0 {
                    return Err(anyhow!("Host not found"));
                }
                id.clone()
            }
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO hosts (id, name, address, port, username, group_id, auth, key_path, tags, created_at, updated_at, key_id) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11)",
                    params![id, input.name, input.address, input.port, input.username, group_id, input.auth, key_path, tags, ts, key_id],
                )?;
                id
            }
        };
        prune_groups(&tx)?;
        tx.commit()?;
        Ok(id)
    }

    pub fn list_keys(&self) -> Result<Vec<KeyInfo>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, name, algorithm, fingerprint, public_key, sealed_passphrase IS NOT NULL, \
             (SELECT COUNT(*) FROM hosts WHERE hosts.key_id = keys.id), created_at \
             FROM keys ORDER BY name COLLATE NOCASE",
        )?;
        let keys = stmt
            .query_map([], |r| {
                Ok(KeyInfo {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    algorithm: r.get(2)?,
                    fingerprint: r.get(3)?,
                    public_key: r.get(4)?,
                    encrypted: r.get(5)?,
                    host_count: r.get(6)?,
                    created_at: r.get(7)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(keys)
    }

    pub fn insert_key(&self, key: &NewKey) -> Result<String> {
        let id = uuid::Uuid::new_v4().to_string();
        self.conn().execute(
            "INSERT INTO keys (id, name, algorithm, fingerprint, public_key, sealed_private, sealed_passphrase, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            params![id, key.name, key.algorithm, key.fingerprint, key.public_key, key.sealed_private, key.sealed_passphrase, now()],
        )?;
        Ok(id)
    }

    /// (name, sealed private key, sealed passphrase)
    pub fn key_secret(&self, id: &str) -> Result<(String, Vec<u8>, Option<Vec<u8>>)> {
        self.conn()
            .query_row(
                "SELECT name, sealed_private, sealed_passphrase FROM keys WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| anyhow!("This key is no longer in the keychain"))
    }

    pub fn find_key_by_fingerprint(&self, fingerprint: &str) -> Result<Option<String>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT name FROM keys WHERE fingerprint = ?1",
                [fingerprint],
                |r| r.get(0),
            )
            .optional()?)
    }

    pub fn rename_key(&self, id: &str, name: &str) -> Result<()> {
        self.conn().execute(
            "UPDATE keys SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, name, now()],
        )?;
        Ok(())
    }

    /// Hosts that used the key fall back to automatic authentication.
    pub fn delete_key(&self, id: &str) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            "UPDATE hosts SET key_id = NULL, auth = CASE WHEN key_path IS NULL THEN 'auto' ELSE auth END, \
             updated_at = ?2 WHERE key_id = ?1",
            params![id, now()],
        )?;
        tx.execute("DELETE FROM keys WHERE id = ?1", [id])?;
        tx.commit()?;
        Ok(())
    }

    pub fn delete_host(&self, id: &str) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM history WHERE host_id = ?1", [id])?;
        tx.execute("DELETE FROM hosts WHERE id = ?1", [id])?;
        prune_groups(&tx)?;
        tx.commit()?;
        Ok(())
    }

    pub fn set_has_password(&self, id: &str, has: bool) -> Result<()> {
        self.conn().execute(
            "UPDATE hosts SET has_password = ?2 WHERE id = ?1",
            params![id, has],
        )?;
        Ok(())
    }

    pub fn set_os(&self, id: &str, os_id: &str, os_name: &str) -> Result<()> {
        self.conn().execute(
            "UPDATE hosts SET os_id = ?2, os_name = ?3 WHERE id = ?1",
            params![id, os_id, os_name],
        )?;
        Ok(())
    }

    pub fn start_history(&self, host_id: &str) -> Result<i64> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO history (host_id, started_at) VALUES (?1, ?2)",
            params![host_id, now()],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn end_history(&self, row: i64) -> Result<()> {
        self.conn().execute(
            "UPDATE history SET ended_at = ?2 WHERE rowid = ?1",
            params![row, now()],
        )?;
        Ok(())
    }

    pub fn host_history(&self, host_id: &str, limit: u32) -> Result<Vec<HistoryEntry>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT started_at, ended_at FROM history WHERE host_id = ?1 ORDER BY started_at DESC LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![host_id, limit], |r| {
                Ok(HistoryEntry {
                    started_at: r.get(0)?,
                    ended_at: r.get(1)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }
}

/// Groups exist only while at least one host uses them.
fn prune_groups(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM groups WHERE id NOT IN (SELECT group_id FROM hosts WHERE group_id IS NOT NULL)", [])?;
    Ok(())
}

fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version < 1 {
        conn.execute_batch(
            "CREATE TABLE groups (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                color TEXT NOT NULL,
                sort INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE hosts (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                address TEXT NOT NULL,
                port INTEGER NOT NULL DEFAULT 22,
                username TEXT NOT NULL,
                group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
                auth TEXT NOT NULL DEFAULT 'auto',
                key_path TEXT,
                tags TEXT NOT NULL DEFAULT '[]',
                os_id TEXT,
                os_name TEXT,
                has_password INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE history (
                host_id TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                ended_at INTEGER
            );
            CREATE INDEX history_host ON history(host_id, started_at);
            PRAGMA user_version = 1;",
        )?;
    }
    if version < 2 {
        conn.execute_batch(
            "CREATE TABLE keys (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                algorithm TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                public_key TEXT NOT NULL,
                -- Both sealed with the vault key (see vault.rs).
                sealed_private BLOB NOT NULL,
                sealed_passphrase BLOB,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            ALTER TABLE hosts ADD COLUMN key_id TEXT REFERENCES keys(id) ON DELETE SET NULL;
            PRAGMA user_version = 2;",
        )?;
    }
    Ok(())
}
