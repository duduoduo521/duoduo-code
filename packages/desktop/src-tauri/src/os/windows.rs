use std::{
    collections::HashMap,
    ffi::c_void,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::Command,
};
use windows_sys::Win32::{
    Foundation::ERROR_SUCCESS,
    System::{
        Registry::{
            RegGetValueW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, REG_EXPAND_SZ, REG_SZ,
            RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ,
        },
        Threading::{CREATE_NEW_CONSOLE, CREATE_NO_WINDOW},
    },
};

// ── Registry-backed environment discovery ───────────────────────────────

/// Environment variable names worth reading from the registry.
///
/// Mirrors the login-shell probe list used on Unix (`cli::probe_shell_env`) so
/// both platforms expose the same set, plus the Windows-specific locations a
/// shell-less launch is missing (`USERPROFILE` and friends have no Unix
/// counterpart and are frequently absent from a Start-menu environment).
const REGISTRY_ENV_KEYS: &[&str] = &[
    "PATH",
    "PATHEXT",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "HOME",
    "LANG",
    "TERM",
    "COLORTERM",
    "EDITOR",
    "GOPATH",
    "CARGO_HOME",
    "RUSTUP_HOME",
    "PYTHONPATH",
    "NODE_PATH",
    "JAVA_HOME",
    "DOCKER_HOST",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
];

/// Subkey holding the machine-wide environment.
const MACHINE_ENV_SUBKEY: &str = r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment";
/// Subkey holding the per-user environment.
const USER_ENV_SUBKEY: &str = "Environment";

/// Registry environment entries this process does not already have.
///
/// Windows has no login shell, so there is no `~/.bashrc` to source: the
/// authoritative per-user / per-machine store is the registry. A process
/// started from the Start menu or a desktop shortcut inherits the environment
/// snapshot Explorer took at logon, which does **not** include entries added
/// afterwards (scoop, nvm-windows, chocolatey, custom installers) unless the
/// installer broadcast `WM_SETTINGCHANGE`. Reading the registry directly closes
/// that gap without spawning a subprocess and without a timeout.
///
/// Only *missing* values are returned: the inherited environment is what
/// Windows actually resolved for this session, so it is never shadowed. `PATH`
/// is the one exception — it is a list, so entries the process never saw are
/// appended to the inherited ordering instead of replacing it.
pub fn missing_registry_env() -> HashMap<String, String> {
    let mut extra = HashMap::new();
    for key in REGISTRY_ENV_KEYS {
        let Some(value) = registry_env_value(key) else {
            continue;
        };
        match std::env::var(key) {
            // Present: the inherited value wins (except for PATH below).
            Ok(_) if !key.eq_ignore_ascii_case("PATH") => {}
            Ok(inherited) => {
                if let Some(merged) = append_missing_path_entries(&inherited, &value) {
                    extra.insert((*key).to_string(), merged);
                }
            }
            Err(std::env::VarError::NotPresent) => {
                extra.insert((*key).to_string(), value);
            }
            // Non-UTF-8 value already present: leave it untouched.
            Err(_) => {}
        }
    }
    extra
}

/// Append the `;`-separated entries of `discovered` that `inherited` lacks.
///
/// The inherited ordering is preserved — Windows resolves `PATH` left to right,
/// so prepending registry entries could shadow a working tool with an older
/// one. Returns `None` when nothing is new, so callers leave the environment
/// untouched rather than writing back an identical value.
fn append_missing_path_entries(inherited: &str, discovered: &str) -> Option<String> {
    let known: Vec<PathBuf> = std::env::split_paths(inherited).collect();
    let mut merged = inherited.to_string();
    let mut changed = false;
    for entry in std::env::split_paths(discovered) {
        if known.iter().any(|k| same_path_entry(k, &entry)) {
            continue;
        }
        if !merged.is_empty() && !merged.ends_with(';') {
            merged.push(';');
        }
        merged.push_str(&entry.to_string_lossy());
        changed = true;
    }
    changed.then_some(merged)
}

/// Compare two PATH entries the way Windows resolves them: case-insensitively
/// and ignoring a trailing separator. `PathBuf`'s `PartialEq` is byte-for-byte,
/// so `C:\Tools` vs `c:\tools\` was treated as new and appended a second time
/// on every startup (P1-33).
fn same_path_entry(a: &Path, b: &Path) -> bool {
    let normalize = |p: &Path| {
        p.to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .to_ascii_lowercase()
    };
    normalize(a) == normalize(b)
}

/// Read one environment variable from the registry.
///
/// User-level (`HKCU\Environment`) wins over machine-level, matching the
/// precedence Windows itself uses when it builds a new process environment.
/// Lookup is case-insensitive, so `"PATH"` matches the `Path` value name.
fn registry_env_value(key: &str) -> Option<String> {
    reg_string(HKEY_CURRENT_USER, USER_ENV_SUBKEY, key)
        .or_else(|| reg_string(HKEY_LOCAL_MACHINE, MACHINE_ENV_SUBKEY, key))
        .filter(|value| !value.trim().is_empty())
}

/// Read a `REG_SZ` / `REG_EXPAND_SZ` value, expanding `%VARS%` on the way.
fn reg_string(root: *mut c_void, subkey: &str, value_name: &str) -> Option<String> {
    let subkey = to_wide(subkey);
    let value_name = to_wide(value_name);
    let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ;
    let mut kind: u32 = 0;
    let mut size: u32 = 0;

    // First call measures the buffer. A value that changes size between the two
    // calls reports a short read; we simply skip it rather than loop.
    let status = unsafe {
        RegGetValueW(
            root,
            subkey.as_ptr(),
            value_name.as_ptr(),
            flags,
            &mut kind,
            std::ptr::null_mut(),
            &mut size,
        )
    };
    if status != ERROR_SUCCESS || size < 2 {
        return None;
    }
    if kind != REG_SZ && kind != REG_EXPAND_SZ {
        return None;
    }

    let mut data = vec![0u8; size as usize];
    let status = unsafe {
        RegGetValueW(
            root,
            subkey.as_ptr(),
            value_name.as_ptr(),
            flags,
            &mut kind,
            data.as_mut_ptr() as *mut c_void,
            &mut size,
        )
    };
    if status != ERROR_SUCCESS || size < 2 {
        return None;
    }

    let words =
        unsafe { std::slice::from_raw_parts(data.as_ptr().cast::<u16>(), (size as usize) / 2) };
    let len = words.iter().position(|v| *v == 0).unwrap_or(words.len());
    Some(String::from_utf16_lossy(&words[..len]))
}

fn to_wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn resolve_windows_app_path(app_name: &str) -> Option<String> {
    fn expand_env(value: &str) -> String {
        let mut out = String::with_capacity(value.len());
        let mut index = 0;

        while let Some(start) = value[index..].find('%') {
            let start = index + start;
            out.push_str(&value[index..start]);

            let Some(end_rel) = value[start + 1..].find('%') else {
                out.push_str(&value[start..]);
                return out;
            };

            let end = start + 1 + end_rel;
            let key = &value[start + 1..end];
            if key.is_empty() {
                out.push('%');
                index = end + 1;
                continue;
            }

            if let Ok(v) = std::env::var(key) {
                out.push_str(&v);
                index = end + 1;
                continue;
            }

            out.push_str(&value[start..=end]);
            index = end + 1;
        }

        out.push_str(&value[index..]);
        out
    }

    fn extract_exe(value: &str) -> Option<String> {
        let value = value.trim();
        if value.is_empty() {
            return None;
        }

        if let Some(rest) = value.strip_prefix('"')
            && let Some(end) = rest.find('"') {
                let inner = rest[..end].trim();
                if inner.to_ascii_lowercase().contains(".exe") {
                    return Some(inner.to_string());
                }
            }

        let lower = value.to_ascii_lowercase();
        let end = lower.find(".exe")?;
        Some(value[..end + 4].trim().trim_matches('"').to_string())
    }

    fn candidates(app_name: &str) -> Vec<String> {
        let app_name = app_name.trim().trim_matches('"');
        if app_name.is_empty() {
            return vec![];
        }

        let mut out = Vec::<String>::new();
        let mut push = |value: String| {
            let value = value.trim().trim_matches('"').to_string();
            if value.is_empty() {
                return;
            }
            if out.iter().any(|v| v.eq_ignore_ascii_case(&value)) {
                return;
            }
            out.push(value);
        };

        push(app_name.to_string());

        let lower = app_name.to_ascii_lowercase();
        if !lower.ends_with(".exe") {
            push(format!("{app_name}.exe"));
        }

        let snake = {
            let mut s = String::new();
            let mut underscore = false;
            for c in lower.chars() {
                if c.is_ascii_alphanumeric() {
                    s.push(c);
                    underscore = false;
                    continue;
                }
                if underscore {
                    continue;
                }
                s.push('_');
                underscore = true;
            }
            s.trim_matches('_').to_string()
        };

        if !snake.is_empty() {
            push(snake.clone());
            if !snake.ends_with(".exe") {
                push(format!("{snake}.exe"));
            }
        }

        let alnum = lower
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect::<String>();

        if !alnum.is_empty() {
            push(alnum.clone());
            push(format!("{alnum}.exe"));
        }

        match lower.as_str() {
            "sublime text" | "sublime-text" | "sublime_text" | "sublime text.exe" => {
                push("subl".to_string());
                push("subl.exe".to_string());
                push("sublime_text".to_string());
                push("sublime_text.exe".to_string());
            }
            _ => {}
        }

        out
    }

    fn reg_app_path(exe: &str) -> Option<String> {
        let exe = exe.trim().trim_matches('"');
        if exe.is_empty() {
            return None;
        }

        let query = |root: *mut c_void, subkey: &str| -> Option<String> {
            let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ;
            let mut kind: u32 = 0;
            let mut size = 0u32;

            let mut key = subkey.encode_utf16().collect::<Vec<_>>();
            key.push(0);

            let status = unsafe {
                RegGetValueW(
                    root,
                    key.as_ptr(),
                    std::ptr::null(),
                    flags,
                    &mut kind,
                    std::ptr::null_mut(),
                    &mut size,
                )
            };

            if status != ERROR_SUCCESS || size == 0 {
                return None;
            }

            if kind != REG_SZ && kind != REG_EXPAND_SZ {
                return None;
            }

            let mut data = vec![0u8; size as usize];
            let status = unsafe {
                RegGetValueW(
                    root,
                    key.as_ptr(),
                    std::ptr::null(),
                    flags,
                    &mut kind,
                    data.as_mut_ptr() as *mut c_void,
                    &mut size,
                )
            };

            if status != ERROR_SUCCESS || size < 2 {
                return None;
            }

            let words = unsafe {
                std::slice::from_raw_parts(data.as_ptr().cast::<u16>(), (size as usize) / 2)
            };
            let len = words.iter().position(|v| *v == 0).unwrap_or(words.len());
            let value = String::from_utf16_lossy(&words[..len]).trim().to_string();

            if value.is_empty() {
                return None;
            }

            Some(value)
        };

        let keys = [
            (
                HKEY_CURRENT_USER,
                format!(r"Software\Microsoft\Windows\CurrentVersion\App Paths\{exe}"),
            ),
            (
                HKEY_LOCAL_MACHINE,
                format!(r"Software\Microsoft\Windows\CurrentVersion\App Paths\{exe}"),
            ),
            (
                HKEY_LOCAL_MACHINE,
                format!(r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\{exe}"),
            ),
        ];

        for (root, key) in keys {
            let Some(value) = query(root, &key) else {
                continue;
            };

            let Some(exe) = extract_exe(&value) else {
                continue;
            };

            let exe = expand_env(&exe);
            let path = Path::new(exe.trim().trim_matches('"'));
            if path.exists() {
                return Some(path.to_string_lossy().to_string());
            }
        }

        None
    }

    let app_name = app_name.trim().trim_matches('"');
    if app_name.is_empty() {
        return None;
    }

    let direct = Path::new(app_name);
    if direct.is_absolute() && direct.exists() {
        return Some(direct.to_string_lossy().to_string());
    }

    let key = app_name
        .chars()
        .filter(|v| v.is_ascii_alphanumeric())
        .flat_map(|v| v.to_lowercase())
        .collect::<String>();

    let has_ext = |path: &Path, ext: &str| {
        path.extension()
            .and_then(|v| v.to_str())
            .map(|v| v.eq_ignore_ascii_case(ext))
            .unwrap_or(false)
    };

    let resolve_cmd = |path: &Path| -> Option<String> {
        let bytes = std::fs::read(path).ok()?;
        let content = String::from_utf8_lossy(&bytes);

        for token in content.split('"') {
            let Some(exe) = extract_exe(token) else {
                continue;
            };

            let lower = exe.to_ascii_lowercase();
            if let Some(index) = lower.find("%~dp0") {
                let base = path.parent()?;
                let suffix = &exe[index + 5..];
                let mut resolved = PathBuf::from(base);

                for part in suffix.replace('/', "\\").split('\\') {
                    if part.is_empty() || part == "." {
                        continue;
                    }
                    if part == ".." {
                        let _ = resolved.pop();
                        continue;
                    }
                    resolved.push(part);
                }

                if resolved.exists() {
                    return Some(resolved.to_string_lossy().to_string());
                }

                continue;
            }

            let resolved = PathBuf::from(expand_env(&exe));
            if resolved.exists() {
                return Some(resolved.to_string_lossy().to_string());
            }
        }

        None
    };

    let resolve_where = |query: &str| -> Option<String> {
        let output = Command::new("where")
            .creation_flags(CREATE_NO_WINDOW)
            .arg(query)
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }

        let paths = String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(PathBuf::from)
            .collect::<Vec<_>>();

        if paths.is_empty() {
            return None;
        }

        if let Some(path) = paths.iter().find(|path| has_ext(path, "exe")) {
            return Some(path.to_string_lossy().to_string());
        }

        for path in &paths {
            if (has_ext(path, "cmd") || has_ext(path, "bat"))
                && let Some(resolved) = resolve_cmd(path) {
                    return Some(resolved);
                }

            if path.extension().is_none() {
                let cmd = path.with_extension("cmd");
                if cmd.exists()
                    && let Some(resolved) = resolve_cmd(&cmd) {
                        return Some(resolved);
                    }

                let bat = path.with_extension("bat");
                if bat.exists()
                    && let Some(resolved) = resolve_cmd(&bat) {
                        return Some(resolved);
                    }
            }
        }

        if !key.is_empty() {
            for path in &paths {
                let dirs = [
                    path.parent(),
                    path.parent().and_then(|dir| dir.parent()),
                    path.parent()
                        .and_then(|dir| dir.parent())
                        .and_then(|dir| dir.parent()),
                ];

                for dir in dirs.into_iter().flatten() {
                    if let Ok(entries) = std::fs::read_dir(dir) {
                        for entry in entries.flatten() {
                            let candidate = entry.path();
                            if !has_ext(&candidate, "exe") {
                                continue;
                            }

                            let Some(stem) = candidate.file_stem().and_then(|v| v.to_str()) else {
                                continue;
                            };

                            let name = stem
                                .chars()
                                .filter(|v| v.is_ascii_alphanumeric())
                                .flat_map(|v| v.to_lowercase())
                                .collect::<String>();

                            if name.contains(&key) || key.contains(&name) {
                                return Some(candidate.to_string_lossy().to_string());
                            }
                        }
                    }
                }
            }
        }

        paths.first().map(|path| path.to_string_lossy().to_string())
    };

    let list = candidates(app_name);
    for query in &list {
        if let Some(path) = resolve_where(query) {
            return Some(path);
        }
    }

    let mut exes = Vec::<String>::new();
    for query in &list {
        let query = query.trim().trim_matches('"');
        if query.is_empty() {
            continue;
        }

        let name = Path::new(query)
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or(query);

        let exe = if name.to_ascii_lowercase().ends_with(".exe") {
            name.to_string()
        } else {
            format!("{name}.exe")
        };

        if exes.iter().any(|v| v.eq_ignore_ascii_case(&exe)) {
            continue;
        }

        exes.push(exe);
    }

    for exe in exes {
        if let Some(path) = reg_app_path(&exe) {
            return Some(path);
        }
    }

    None
}

pub fn open_in_powershell(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    let dir = if path.is_dir() {
        path
    } else if let Some(parent) = path.parent() {
        parent.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| format!("Failed to determine current directory: {e}"))?
    };

    Command::new("powershell.exe")
        .creation_flags(CREATE_NEW_CONSOLE)
        .current_dir(dir)
        .args(["-NoExit"])
        .spawn()
        .map_err(|e| format!("Failed to start PowerShell: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_path_entries_are_appended_in_order() {
        let merged = append_missing_path_entries(
            r"C:\Windows;C:\Windows\System32",
            r"C:\Windows\System32;C:\Users\u\scoop\shims",
        )
        .expect("scoop shims are missing from the inherited PATH");
        assert_eq!(
            merged,
            r"C:\Windows;C:\Windows\System32;C:\Users\u\scoop\shims"
        );
    }

    #[test]
    fn path_is_untouched_when_nothing_is_new() {
        assert!(append_missing_path_entries(r"C:\a;C:\b", r"C:\b;C:\a").is_none());
    }

    /// Regression (P1-33): a registry entry that differs only in case or a
    /// trailing separator must NOT be appended again — `PathBuf`'s byte-wise
    /// equality used to treat `c:\tools\` as new next to `C:\Tools`, so every
    /// startup appended another copy of the same directory.
    #[test]
    fn path_entries_are_deduplicated_case_insensitively() {
        assert!(
            append_missing_path_entries(r"C:\Tools;C:\Windows", r"c:\tools\").is_none(),
            "a case/trailing-separator variant of an existing entry must be skipped"
        );
    }

    /// A blank registry value must not blank out the inherited environment.
    #[test]
    fn registry_values_are_never_blank() {
        for key in REGISTRY_ENV_KEYS {
            if let Some(value) = registry_env_value(key) {
                assert!(!value.trim().is_empty(), "{key} contributed a blank value");
            }
        }
    }
}
