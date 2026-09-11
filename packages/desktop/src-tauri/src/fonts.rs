use std::collections::BTreeSet;

/// List all font family names installed on the system.
/// On macOS, uses CoreText API.
/// On Linux, parses `fc-list` output.
/// On Windows, uses the registry.
///
/// This command is async and uses `spawn_blocking` to avoid blocking the main thread
/// with synchronous subprocess execution.
#[tauri::command]
#[specta::specta]
pub async fn list_system_fonts() -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(|| {
        let mut fonts = BTreeSet::new();

        #[cfg(target_os = "macos")]
        {
            let output = std::process::Command::new("swift")
                .arg("-e")
                .arg(
                    r#"
import CoreText
let families = CTFontManagerCopyAvailableFontFamilyNames() as! [String]
for f in families { print(f) }
"#,
                )
                .output()
                .map_err(|e| format!("Failed to run swift: {e}"))?;

            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let name = line.trim();
                if !name.is_empty() {
                    fonts.insert(name.to_string());
                }
            }
        }

        #[cfg(target_os = "linux")]
        {
            let output = std::process::Command::new("fc-list")
                .arg("--format=%{family}\\n")
                .output()
                .map_err(|e| format!("Failed to run fc-list: {e}"))?;
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let name = line.trim();
                if !name.is_empty() {
                    fonts.insert(name.to_string());
                }
            }
        }

        #[cfg(target_os = "windows")]
        {
            let output = crate::os::silent_command("powershell")
                .args(["-NoProfile", "-Command"])
                .arg(
                    r#"
Add-Type -AssemblyName System.Drawing
(New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }
"#,
                )
                .output()
                .map_err(|e| format!("Failed to run powershell: {e}"))?;

            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let name = line.trim();
                if !name.is_empty() {
                    fonts.insert(name.to_string());
                }
            }
        }

        Ok(fonts.into_iter().collect())
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}
