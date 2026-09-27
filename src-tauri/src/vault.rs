//! Envelope encryption for secrets too big for OS credential stores (Windows caps
//! entries at ~2.5 KB, less than an RSA-4096 key). A random 256-bit vault key lives
//! in the credential store; everything else is sealed with AES-256-GCM and kept in
//! SQLite as `nonce || ciphertext`.

use std::sync::OnceLock;

use aes_gcm::aead::{Aead, Generate, Key, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{anyhow, bail, Result};
use zeroize::Zeroizing;

use crate::secrets;

const ACCOUNT: &str = "vault:key";
const NONCE_LEN: usize = 12;

static KEY: OnceLock<Key<Aes256Gcm>> = OnceLock::new();

fn cipher() -> Result<Aes256Gcm> {
    if let Some(key) = KEY.get() {
        return Ok(Aes256Gcm::new(key));
    }
    let key = match secrets::get_bytes(ACCOUNT)? {
        Some(bytes) if bytes.len() == 32 => Key::<Aes256Gcm>::try_from(bytes.as_slice())
            .map_err(|_| anyhow!("Invalid vault key"))?,
        Some(_) => bail!("The vault key in the system keychain is corrupt"),
        // Only a store with no entry at all gets a fresh key; any other read
        // failure must not replace a key that existing records depend on.
        None => {
            let key = Key::<Aes256Gcm>::generate();
            secrets::set_bytes(ACCOUNT, key.as_slice())?;
            key
        }
    };
    Ok(Aes256Gcm::new(KEY.get_or_init(|| key)))
}

pub fn seal(plaintext: &[u8]) -> Result<Vec<u8>> {
    let nonce = Nonce::generate();
    let ciphertext = cipher()?
        .encrypt(&nonce, plaintext)
        .map_err(|_| anyhow!("Encryption failed"))?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

pub fn open(sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    if sealed.len() <= NONCE_LEN {
        bail!("Sealed data is truncated");
    }
    let (nonce, ciphertext) = sealed.split_at(NONCE_LEN);
    let nonce = Nonce::try_from(nonce).map_err(|_| anyhow!("Bad nonce"))?;
    let plaintext = cipher()?
        .decrypt(&nonce, ciphertext)
        .map_err(|_| anyhow!("Couldn't decrypt this key. The vault key may have changed."))?;
    Ok(Zeroizing::new(plaintext))
}

pub fn open_string(sealed: &[u8]) -> Result<Zeroizing<String>> {
    let bytes = open(sealed)?;
    Ok(Zeroizing::new(String::from_utf8(bytes.to_vec())?))
}

/// Tests use an in-memory key so they never touch the real credential store.
#[cfg(test)]
pub fn use_ephemeral_key() {
    let _ = KEY.set(Key::<Aes256Gcm>::generate());
}
