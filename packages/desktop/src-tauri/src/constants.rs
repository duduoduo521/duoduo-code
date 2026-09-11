use tauri_plugin_window_state::StateFlags;

pub const SETTINGS_STORE: &str = "duoduo.settings.dat";
pub const DEFAULT_SERVER_URL_KEY: &str = "defaultServerUrl";
pub const WSL_ENABLED_KEY: &str = "wslEnabled";
/// Custom gear data directory (overrides the default `data/gears` location).
pub const GEAR_DATA_DIR_KEY: &str = "gearDataDir";
pub const UPDATER_ENABLED: bool = option_env!("TAURI_SIGNING_PRIVATE_KEY").is_some();

// Smart Layer (duo-smart-layer) constants
#[allow(dead_code)]
pub const SMART_LAYER_STORE: &str = "duoduo-smart-layer-settings";
pub const SMART_LAYER_HEALTH_TIMEOUT_SECS: u64 = 30;
pub const SMART_LAYER_HEALTH_INTERVAL_MS: u64 = 500;
pub const SMART_LAYER_PORT_DISCOVERY_TIMEOUT_SECS: u64 = 5;

pub fn window_state_flags() -> StateFlags {
    StateFlags::all() - StateFlags::DECORATIONS - StateFlags::VISIBLE
}
