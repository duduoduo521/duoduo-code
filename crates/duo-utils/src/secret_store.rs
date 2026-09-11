//! Secret storage shared by every long-lived credential the app persists.
//!
//! # Architecture
//!
//! - **Primary storage**: OS keyring (macOS Keychain / Windows Credential
//!   Manager / Linux Secret Service via DBus)
//! - **Fallback storage**: AES-256-GCM encrypted file, used when the keyring is
//!   unavailable (e.g. headless Linux without DBus)
//!
//! Secrets are addressed by a caller-chosen `id`. Keeping a single
//! implementation here means LLM provider keys, IM app secrets and anything
//! added later all get the same protection, instead of each subsystem writing
//! its own plaintext file — which is exactly how the Feishu App Secret used to
//! end up readable in `config.toml`.
//!
//! This is a **persistence layer**, not a real-time read layer: callers resolve
//! a secret once and keep it in memory, so no blocking keyring I/O happens on
//! the tokio runtime per request.

use std::path::{Path, PathBuf};

use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
use base64::Engine;

// ─── Constants ───────────────────────────────────────────────────────────

const SERVICE_NAME: &str = "com.duoduocode.ide";
const FALLBACK_STORE_FILENAME: &str = "secure-keys.enc.json";

// ─── Public API ──────────────────────────────────────────────────────────

/// Store `secret` under `id`.
pub fn store_secret(id: &str, secret: &str) -> anyhow::Result<()> {
    match try_keyring_store(id, secret) {
        Ok(()) => {
            tracing::debug!(id = id, "Secret stored in OS keyring");
            // Keep the fallback in sync so both sources agree.
            let _ = fallback_store(id, secret);
            Ok(())
        }
        Err(e) => {
            tracing::warn!(
                id = id,
                error = %e,
                "OS keyring unavailable, falling back to encrypted file"
            );
            fallback_store(id, secret)
        }
    }
}

/// Load the secret stored under `id`, or `None` if it is absent.
pub fn load_secret(id: &str) -> Option<String> {
    try_keyring_load(id).or_else(|| fallback_load(id))
}

/// Delete the secret stored under `id` (from both stores).
pub fn delete_secret(id: &str) -> anyhow::Result<()> {
    let keyring_result = try_keyring_delete(id);
    let fallback_result = fallback_delete(id);

    // Report a failure only when neither store could be cleaned.
    match (keyring_result, fallback_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(e), Ok(())) => {
            tracing::warn!(error = %e, "Keyring delete failed, but fallback succeeded");
            Ok(())
        }
        (Ok(()), Err(e)) => {
            tracing::warn!(error = %e, "Fallback delete failed, but keyring succeeded");
            Ok(())
        }
        (Err(ke), Err(fe)) => Err(anyhow::anyhow!(
            "Both keyring ({ke}) and fallback ({fe}) delete failed"
        )),
    }
}

/// Whether a secret is stored under `id`.
///
/// Does **not** reveal the value, so it is safe to expose to the frontend.
pub fn has_secret(id: &str) -> bool {
    load_secret(id).is_some()
}

// ─── OS Keyring (primary) ────────────────────────────────────────────────

fn try_keyring_store(id: &str, secret: &str) -> anyhow::Result<()> {
    let entry = keyring::Entry::new(SERVICE_NAME, id)
        .map_err(|e| anyhow::anyhow!("Failed to create keyring entry: {e}"))?;
    entry
        .set_password(secret)
        .map_err(|e| anyhow::anyhow!("Failed to set keyring password: {e}"))?;
    Ok(())
}

fn try_keyring_load(id: &str) -> Option<String> {
    let entry = keyring::Entry::new(SERVICE_NAME, id).ok()?;
    match entry.get_password() {
        Ok(secret) => Some(secret),
        Err(keyring::Error::NoEntry) => None,
        Err(e) => {
            tracing::warn!(error = %e, "Failed to read from OS keyring");
            None
        }
    }
}

fn try_keyring_delete(id: &str) -> anyhow::Result<()> {
    let entry = keyring::Entry::new(SERVICE_NAME, id)
        .map_err(|e| anyhow::anyhow!("Failed to create keyring entry: {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // Already gone — not an error
        Err(e) => Err(anyhow::anyhow!("Failed to delete from keyring: {e}")),
    }
}

// ─── Encrypted File Fallback ─────────────────────────────────────────────

/// Derive an AES-256 encryption key from device-specific entropy.
///
/// The key is derived via HKDF-SHA512 from:
/// - Machine ID (`/etc/machine-id` on Linux, IOPlatformSerialNumber on macOS,
///   HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid on Windows)
/// - User UID (Unix) or username (Windows)
/// - A random seed file stored in the app data directory (0o600 permissions)
///
/// **Security note**: strictly better than a plaintext file (an attacker must
/// locate and combine several pieces of information) but weaker than the OS
/// keyring, which uses hardware-backed secrets on some platforms. On headless
/// Linux without a Secret Service this is the best available option.
fn derive_encryption_key(data_dir: &Path) -> [u8; 32] {
    use hkdf::Hkdf;
    use sha2::Sha512;

    let mut entropy = String::new();

    if let Some(machine_id) = get_machine_id() {
        entropy.push_str(&machine_id);
    }

    #[cfg(unix)]
    {
        // SAFETY: getuid() is always safe to call
        let uid = unsafe { libc::getuid() };
        entropy.push_str(&format!("uid:{uid}"));
    }
    #[cfg(windows)]
    {
        if let Ok(username) = std::env::var("USERNAME") {
            entropy.push_str(&format!("user:{username}"));
        }
    }

    entropy.push_str(&data_dir.to_string_lossy());

    let seed_path = data_dir.join(".key-seed");
    let seed = if seed_path.exists() {
        std::fs::read(&seed_path).unwrap_or_default()
    } else {
        let seed: [u8; 32] = rand::random();
        if let Err(e) = std::fs::write(&seed_path, seed) {
            tracing::warn!(path = %seed_path.display(), error = %e, "Failed to write key seed file");
        } else {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ =
                    std::fs::set_permissions(&seed_path, std::fs::Permissions::from_mode(0o600));
            }
        }
        seed.to_vec()
    };

    let hk = Hkdf::<Sha512>::new(
        Some(b"duoduocode-ide-keyring-fallback-v1"),
        format!("{entropy}{:?}", seed).as_bytes(),
    );
    let mut key = [0u8; 32];
    hk.expand(b"encryption-key", &mut key)
        .expect("invariant: 32 is a valid HKDF expand length for SHA512");

    key
}

#[cfg(target_os = "linux")]
fn get_machine_id() -> Option<String> {
    std::fs::read_to_string("/etc/machine-id")
        .ok()
        .map(|s| s.trim().to_string())
}

#[cfg(target_os = "macos")]
fn get_machine_id() -> Option<String> {
    std::process::Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()
        .and_then(|out| {
            let stdout = String::from_utf8_lossy(&out.stdout);
            stdout
                .lines()
                .find(|l| l.contains("IOPlatformSerialNumber"))
                .map(|l| l.to_string())
        })
}

#[cfg(target_os = "windows")]
fn get_machine_id() -> Option<String> {
    let output = crate::platform::silent_command("reg")
        .args([
            "query",
            r"HKLM\SOFTWARE\Microsoft\Cryptography",
            "/v",
            "MachineGuid",
        ])
        .output()
        .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .find(|l| l.contains("MachineGuid"))
        .and_then(|l| l.split_whitespace().last())
        .map(|s| s.to_string())
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn get_machine_id() -> Option<String> {
    None
}

fn fallback_store(id: &str, secret: &str) -> anyhow::Result<()> {
    let data_dir = get_data_dir()?;
    let enc_key = derive_encryption_key(&data_dir);

    let nonce_bytes: [u8; 12] = rand::random();
    let nonce = Nonce::from_slice(&nonce_bytes);

    let cipher = Aes256Gcm::new_from_slice(&enc_key)
        .map_err(|e| anyhow::anyhow!("Failed to create AES cipher: {e}"))?;
    let ciphertext = cipher
        .encrypt(nonce, secret.as_bytes())
        .map_err(|e| anyhow::anyhow!("AES encryption failed: {e}"))?;

    // Stored as nonce || ciphertext, base64-encoded.
    let mut combined = Vec::with_capacity(12 + ciphertext.len());
    combined.extend_from_slice(&nonce_bytes);
    combined.extend_from_slice(&ciphertext);
    let encoded = base64::engine::general_purpose::STANDARD.encode(&combined);

    let store_path = data_dir.join(FALLBACK_STORE_FILENAME);
    let mut store = load_fallback_store_raw(&store_path);
    store.insert(id.to_string(), serde_json::Value::String(encoded));

    let json = serde_json::to_string_pretty(&store)?;
    std::fs::write(&store_path, json)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&store_path, std::fs::Permissions::from_mode(0o600));
    }

    Ok(())
}

fn fallback_load(id: &str) -> Option<String> {
    let data_dir = get_data_dir().ok()?;
    let enc_key = derive_encryption_key(&data_dir);
    let store_path = data_dir.join(FALLBACK_STORE_FILENAME);

    let store = load_fallback_store_raw(&store_path);
    let encoded = store.get(id).and_then(|v| v.as_str())?;

    let combined = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;

    if combined.len() < 13 {
        tracing::warn!(id = id, "Encrypted secret data too short");
        return None;
    }

    let (nonce_bytes, ciphertext) = combined.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);

    let cipher = Aes256Gcm::new_from_slice(&enc_key).ok()?;
    let plaintext = cipher.decrypt(nonce, ciphertext).ok()?;

    String::from_utf8(plaintext).ok()
}

fn fallback_delete(id: &str) -> anyhow::Result<()> {
    let data_dir = get_data_dir()?;
    let store_path = data_dir.join(FALLBACK_STORE_FILENAME);

    let mut store = load_fallback_store_raw(&store_path);
    if store.remove(id).is_some() {
        let json = serde_json::to_string_pretty(&store)?;
        std::fs::write(&store_path, json)?;
    }

    Ok(())
}

fn load_fallback_store_raw(path: &Path) -> serde_json::Map<String, serde_json::Value> {
    if !path.exists() {
        return serde_json::Map::new();
    }
    let content = std::fs::read_to_string(path).unwrap_or_default();
    serde_json::from_str::<serde_json::Value>(&content)
        .ok()
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn get_data_dir() -> anyhow::Result<PathBuf> {
    dirs::data_dir()
        .map(|d| d.join("duoduo-ai"))
        .ok_or_else(|| anyhow::anyhow!("Could not determine app data directory"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derive_encryption_key_is_deterministic() {
        let dir = std::env::temp_dir().join("duoduo-utils-test-key-derive");
        let _ = std::fs::create_dir_all(&dir);
        assert_eq!(derive_encryption_key(&dir), derive_encryption_key(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
