//! Passwords and key passphrases live in the OS credential store
//! (macOS Keychain, Windows Credential Manager, Secret Service on Linux).

use anyhow::Result;

const SERVICE: &str = "dev.tern.app";

fn entry(account: &str) -> Result<keyring::Entry> {
    Ok(keyring::Entry::new(SERVICE, account)?)
}

pub fn host_password_account(host_id: &str) -> String {
    format!("host:{host_id}:password")
}

pub fn key_passphrase_account(key_path: &str) -> String {
    format!("key:{key_path}:passphrase")
}

pub fn get(account: &str) -> Option<String> {
    entry(account).ok()?.get_password().ok()
}

pub fn set(account: &str, secret: &str) -> Result<()> {
    entry(account)?.set_password(secret)?;
    Ok(())
}

pub fn delete(account: &str) {
    if let Ok(e) = entry(account) {
        let _ = e.delete_credential();
    }
}

/// Raw bytes, distinguishing "nothing stored" (`Ok(None)`) from a store that can't be read.
pub fn get_bytes(account: &str) -> Result<Option<Vec<u8>>> {
    match entry(account)?.get_secret() {
        Ok(bytes) => Ok(Some(bytes)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn set_bytes(account: &str, secret: &[u8]) -> Result<()> {
    entry(account)?.set_secret(secret)?;
    Ok(())
}
