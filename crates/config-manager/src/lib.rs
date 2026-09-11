//! config-manager crate for DuoDuo smart layer.
//!
//! Provides configuration loading from TOML files with environment
//! variable overrides. See [`SmartLayerConfig`] for the full schema
//! and [`load_config`] for the resolution order.

pub mod feature_flags;
pub mod loader;
pub mod model;

pub use loader::{SECRET_MASK, load_config, save_im_config, save_loop_config};
pub use model::SmartLayerConfig;

use anyhow::Result;
use std::sync::RwLock;

/// Manages the loaded configuration for the DuoDuo smart layer.
///
/// Created via [`ConfigManager::new`] which loads configuration from
/// disk and applies environment variable overrides.
///
/// `loop_config` is additionally tracked through a runtime override so the
/// UI settings panel can change quality switches (语法校验 / 审校) without
/// restarting the process. The override is persisted to config.toml via
/// [`save_loop_config`] and takes effect on the next run_loop.
pub struct ConfigManager {
    config: SmartLayerConfig,
    loop_config_override: RwLock<Option<model::LoopConfig>>,
}

impl ConfigManager {
    /// Create a new `ConfigManager` by loading configuration.
    ///
    /// Resolution order (later wins):
    /// 1. Built-in defaults
    /// 2. TOML file at `config_dir()/duoduo/config.toml`
    /// 3. Environment variable overrides
    pub fn new() -> Result<Self> {
        let config = load_config()?;
        let loop_cfg = config.loop_config.clone();
        Ok(Self {
            config,
            loop_config_override: RwLock::new(loop_cfg),
        })
    }

    /// Returns a reference to the loaded configuration.
    pub fn config(&self) -> &SmartLayerConfig {
        &self.config
    }

    /// Effective loop configuration.
    ///
    /// Prefers any runtime override set via [`set_loop_config`] (e.g. from the
    /// UI settings panel) and falls back to the value loaded from config.toml
    /// at startup. Returns `None` when no loop config was ever provided
    /// (callers then apply built-in defaults).
    pub fn loop_config(&self) -> Option<model::LoopConfig> {
        duo_utils::sync::read(&self.loop_config_override).clone()
    }

    /// Update the loop configuration at runtime.
    ///
    /// Persists the new value to config.toml (so it survives restart) and
    /// updates the in-memory override so subsequent run_loop invocations pick
    /// it up immediately.
    pub fn set_loop_config(&self, lc: model::LoopConfig) -> Result<()> {
        // Persist first — if the file write fails, we must not advertise a
        // change the process cannot restore after a restart.
        save_loop_config(&lc)?;
        *duo_utils::sync::write(&self.loop_config_override) = Some(lc);
        Ok(())
    }
}

impl Default for ConfigManager {
    fn default() -> Self {
        Self::new().expect("Failed to initialize config-manager")
    }
}
