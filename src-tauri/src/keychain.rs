//! Saved SSH keys: import, generate, and load for authentication.
//!
//! The key file is stored exactly as imported (so it can be exported unchanged
//! later), sealed with the vault key along with its passphrase if it has one.

use anyhow::{anyhow, bail, Result};
use russh::keys::ssh_key::private::Ed25519Keypair;
use russh::keys::ssh_key::LineEnding;
use russh::keys::{self, Algorithm, EcdsaCurve, HashAlg, PrivateKey, PublicKey};

use crate::db::{Db, KeyInfo, NewKey};
use crate::vault;

/// Larger than any real private key; guards against picking the wrong file.
const MAX_KEY_FILE: u64 = 64 * 1024;

pub fn algorithm_label(key: &PublicKey) -> String {
    match key.algorithm() {
        Algorithm::Ed25519 => "ED25519".into(),
        Algorithm::Rsa { .. } => match key.key_data().rsa() {
            Some(rsa) => format!("RSA {}", rsa.key_size()),
            None => "RSA".into(),
        },
        Algorithm::Ecdsa { curve } => match curve {
            EcdsaCurve::NistP256 => "ECDSA P-256".into(),
            EcdsaCurve::NistP384 => "ECDSA P-384".into(),
            EcdsaCurve::NistP521 => "ECDSA P-521".into(),
        },
        Algorithm::SkEd25519 => "ED25519-SK".into(),
        Algorithm::SkEcdsaSha2NistP256 => "ECDSA-SK".into(),
        other => other.as_str().to_uppercase(),
    }
}

fn store(
    db: &Db,
    name: &str,
    key: &PrivateKey,
    pem: &str,
    passphrase: Option<&str>,
) -> Result<KeyInfo> {
    let public = key.public_key();
    let fingerprint = public.fingerprint(HashAlg::Sha256).to_string();
    if let Some(existing) = db.find_key_by_fingerprint(&fingerprint)? {
        bail!("This key is already in the keychain as “{existing}”");
    }
    // Label the public line with the keychain name rather than the file's original comment.
    let mut public_line = public.clone();
    public_line.set_comment(name);
    let id = db.insert_key(&NewKey {
        name,
        algorithm: &algorithm_label(public),
        fingerprint: &fingerprint,
        public_key: &public_line.to_openssh()?,
        sealed_private: &vault::seal(pem.as_bytes())?,
        sealed_passphrase: passphrase
            .map(|p| vault::seal(p.as_bytes()))
            .transpose()?
            .as_deref(),
    })?;
    db.list_keys()?
        .into_iter()
        .find(|k| k.id == id)
        .ok_or_else(|| anyhow!("Key vanished after saving"))
}

/// Imports a private key from its text, or from `path` when no text is given.
pub fn import(
    db: &Db,
    name: &str,
    pem: Option<String>,
    path: Option<String>,
    passphrase: Option<String>,
) -> Result<KeyInfo> {
    let pem = match (pem.filter(|p| !p.trim().is_empty()), path) {
        (Some(pem), _) => pem,
        (None, Some(path)) => {
            let path = crate::ssh::expand_tilde(&path);
            if std::fs::metadata(&path)?.len() > MAX_KEY_FILE {
                bail!("That file is too large to be a private key");
            }
            std::fs::read_to_string(&path)
                .map_err(|e| anyhow!("Couldn't read {}: {e}", path.display()))?
        }
        (None, None) => bail!("Paste a private key or choose a key file"),
    };
    let pem = pem.trim().to_string() + "\n";
    let passphrase = passphrase.filter(|p| !p.is_empty());

    let (key, passphrase) = match keys::decode_secret_key(&pem, None) {
        Ok(key) => (key, None),
        Err(keys::Error::KeyIsEncrypted) => {
            let Some(pass) = passphrase else {
                bail!("This key is protected by a passphrase. Enter it below to import the key.");
            };
            let key = keys::decode_secret_key(&pem, Some(&pass))
                .map_err(|_| anyhow!("That passphrase doesn't unlock this key"))?;
            (key, Some(pass))
        }
        Err(_) if pem.contains("PUBLIC KEY") || pem.starts_with("ssh-") => {
            bail!("That's a public key. Import the private key (the file without .pub).")
        }
        Err(e) => bail!("Not a private key Tern can read ({e})"),
    };

    let name = match name.trim() {
        "" => match key.comment().as_str().unwrap_or("").trim() {
            "" => algorithm_label(key.public_key()),
            comment => comment.to_string(),
        },
        n => n.to_string(),
    };
    store(db, &name, &key, &pem, passphrase.as_deref())
}

/// Creates a new Ed25519 key.
pub fn generate(db: &Db, name: &str) -> Result<KeyInfo> {
    let mut seed = zeroize::Zeroizing::new([0u8; 32]);
    getrandom::fill(seed.as_mut()).map_err(|e| anyhow!("No secure randomness available: {e}"))?;
    let mut key = PrivateKey::from(Ed25519Keypair::from_seed(&seed));
    let name = if name.trim().is_empty() {
        "ed25519"
    } else {
        name.trim()
    };
    key.set_comment(name);
    let pem = key.to_openssh(LineEnding::LF)?;
    store(db, name, &key, &pem, None)
}

/// Decrypts a saved key for authentication. Returns the key and its display name.
pub fn load(db: &Db, id: &str) -> Result<(PrivateKey, String)> {
    let (name, sealed_private, sealed_passphrase) = db.key_secret(id)?;
    let pem = vault::open_string(&sealed_private)?;
    let passphrase = sealed_passphrase
        .map(|s| vault::open_string(&s))
        .transpose()?;
    let key = keys::decode_secret_key(&pem, passphrase.as_ref().map(|p| p.as_str()))
        .map_err(|e| anyhow!("Couldn't load key “{name}”: {e}"))?;
    Ok((key, name))
}
