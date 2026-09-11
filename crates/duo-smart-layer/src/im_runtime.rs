use std::sync::{Arc, OnceLock};

use im_bridge::{ImBridge, config::ImConfig};

type BridgeCell = tokio::sync::Mutex<Option<Arc<ImBridge>>>;

static IM_BRIDGE: OnceLock<Arc<BridgeCell>> = OnceLock::new();

fn cell() -> Arc<BridgeCell> {
    IM_BRIDGE
        .get_or_init(|| Arc::new(tokio::sync::Mutex::new(None)))
        .clone()
}

pub async fn start_or_restart(
    config: ImConfig,
    state: crate::server::AppState,
) -> anyhow::Result<()> {
    let cell = cell();
    let mut guard = cell.lock().await;

    if let Some(existing) = guard.take() {
        existing.stop().await;
    }

    if !config.enabled {
        tracing::info!("IM bridge disabled by config");
        return Ok(());
    }

    let bridge_impl = Arc::new(crate::im_bridge_impl::SmartLayerBridgeImpl::new(state));
    let bridge = Arc::new(ImBridge::new(config, bridge_impl));
    let runner = bridge.clone();
    tokio::spawn(async move {
        runner.start().await;
    });
    *guard = Some(bridge);
    tracing::info!("IM bridge started/restarted");
    Ok(())
}

pub async fn stop() {
    let cell = cell();
    let mut guard = cell.lock().await;
    if let Some(existing) = guard.take() {
        existing.stop().await;
    }
}

pub async fn is_running() -> bool {
    cell().lock().await.is_some()
}
