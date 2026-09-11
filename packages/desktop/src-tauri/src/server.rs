use std::time::{Duration, Instant};

use tauri::AppHandle;
use tauri_plugin_store::StoreExt;
use tokio::task::JoinHandle;

use crate::{
    cli,
    cli::{CommandChild, TerminatedPayload},
    constants::{DEFAULT_SERVER_URL_KEY, GEAR_DATA_DIR_KEY, SETTINGS_STORE, WSL_ENABLED_KEY},
};

#[derive(Clone, serde::Serialize, serde::Deserialize, specta::Type, Debug, Default)]
pub struct WslConfig {
    pub enabled: bool,
}

#[tauri::command]
#[specta::specta]
pub async fn get_default_server_url(app: AppHandle) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let store = app
            .store(SETTINGS_STORE)
            .map_err(|e| format!("Failed to open settings store: {}", e))?;

        let value = store.get(DEFAULT_SERVER_URL_KEY);
        match value {
            Some(v) => Ok(v.as_str().map(String::from)),
            None => Ok(None),
        }
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

#[tauri::command]
#[specta::specta]
pub async fn set_default_server_url(app: AppHandle, url: Option<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let store = app
            .store(SETTINGS_STORE)
            .map_err(|e| format!("Failed to open settings store: {}", e))?;

        match url {
            Some(u) => {
                store.set(DEFAULT_SERVER_URL_KEY, serde_json::Value::String(u));
            }
            None => {
                store.delete(DEFAULT_SERVER_URL_KEY);
            }
        }

        store
            .save()
            .map_err(|e| format!("Failed to save settings: {}", e))?;

        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

#[tauri::command]
#[specta::specta]
pub async fn get_gear_data_dir(app: AppHandle) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        // 始终返回当前生效的目录：未自定义则返回按操作系统推导的默认目录，
        // 前端输入框即可直接展示该默认保存位置（Windows / macOS / Linux 不同）。
        Ok(Some(
            crate::smart_layer::compute_gears_dir(&app).to_string_lossy().to_string(),
        ))
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

#[tauri::command]
#[specta::specta]
pub async fn set_gear_data_dir(app: AppHandle, dir: Option<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let store = app
            .store(SETTINGS_STORE)
            .map_err(|e| format!("Failed to open settings store: {}", e))?;

        match dir {
            Some(d) => {
                let trimmed = d.trim();
                if trimmed.is_empty() {
                    store.delete(GEAR_DATA_DIR_KEY);
                } else {
                    store.set(GEAR_DATA_DIR_KEY, serde_json::Value::String(trimmed.to_string()));
                }
            }
            None => {
                store.delete(GEAR_DATA_DIR_KEY);
            }
        }

        store
            .save()
            .map_err(|e| format!("Failed to save settings: {}", e))?;

        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

#[tauri::command]
#[specta::specta]
pub fn get_wsl_config(_app: AppHandle) -> Result<WslConfig, String> {
    // let store = app
    //     .store(SETTINGS_STORE)
    //     .map_err(|e| format!("Failed to open settings store: {}", e))?;

    // let enabled = store
    //     .get(WSL_ENABLED_KEY)
    //     .as_ref()
    //     .and_then(|v| v.as_bool())
    //     .unwrap_or(false);

    Ok(WslConfig { enabled: false })
}

#[tauri::command]
#[specta::specta]
pub async fn set_wsl_config(app: AppHandle, config: WslConfig) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let store = app
            .store(SETTINGS_STORE)
            .map_err(|e| format!("Failed to open settings store: {}", e))?;

        store.set(WSL_ENABLED_KEY, serde_json::Value::Bool(config.enabled));

        store
            .save()
            .map_err(|e| format!("Failed to save settings: {}", e))?;

        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

pub fn spawn_local_server(
    app: AppHandle,
    hostname: String,
    port: u32,
    password: String,
    directory: Option<String>,
    extra_envs: Option<Vec<(&'static str, String)>>,
) -> Result<(CommandChild, HealthCheck, JoinHandle<TerminatedPayload>), String> {
    let (child, exit_handle) =
        cli::serve(&app, &hostname, port, &password, directory.as_deref(), extra_envs)?;

    let health_check = HealthCheck(tokio::spawn(async move {
        let url = format!("http://{hostname}:{port}");
        let timestamp = Instant::now();

        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;

            if check_health(&url, Some(&password)).await {
                tracing::info!(elapsed = ?timestamp.elapsed(), "Server ready");
                return Ok(());
            }
        }
    }));

    Ok((child, health_check, exit_handle))
}

pub struct HealthCheck(pub JoinHandle<Result<(), String>>);

async fn check_health(url: &str, password: Option<&str>) -> bool {
    let Ok(url) = reqwest::Url::parse(url) else {
        return false;
    };

    let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(7));

    if url
        .host_str()
        .is_some_and(|host| {
            host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        })
    {
        // Some environments set proxy variables (HTTP_PROXY/HTTPS_PROXY/ALL_PROXY) without
        // excluding loopback. reqwest respects these by default, which can prevent the desktop
        // app from reaching its own local sidecar server.
        builder = builder.no_proxy();
    }

    let Ok(client) = builder.build() else {
        return false;
    };
    let Ok(health_url) = url.join("/global/health") else {
        return false;
    };

    let mut req = client.get(health_url);

    if let Some(password) = password {
        req = req.basic_auth("duoduo", Some(password));
    }

    req.send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}
