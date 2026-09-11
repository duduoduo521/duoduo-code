use crate::{
    constants::{UPDATER_ENABLED, window_state_flags},
    server::get_wsl_config,
};
use std::{ops::Deref, sync::atomic::Ordering, time::Duration};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
#[cfg(target_os = "macos")]
use tauri::window::Color;
use tauri_plugin_window_state::AppHandleExt;
use tokio::sync::mpsc;

#[cfg(target_os = "linux")]
use std::sync::OnceLock;

#[cfg(target_os = "linux")]
pub fn use_decorations() -> bool {
    static DECORATIONS: OnceLock<bool> = OnceLock::new();
    *DECORATIONS.get_or_init(|| {
        crate::linux_windowing::use_decorations(&crate::linux_windowing::SessionEnv::capture())
    })
}

#[cfg(not(target_os = "linux"))]
pub fn use_decorations() -> bool {
    true
}

pub struct MainWindow(WebviewWindow);

impl Deref for MainWindow {
    type Target = WebviewWindow;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl MainWindow {
    pub const LABEL: &str = "main";

    pub fn create(app: &AppHandle) -> Result<Self, tauri::Error> {
        if let Some(window) = app.get_webview_window(Self::LABEL) {
            let _ = window.set_focus();
            let _ = window.unminimize();
            return Ok(Self(window));
        }

        let wsl_enabled = get_wsl_config(app.clone())
            .ok()
            .map(|v| v.enabled)
            .unwrap_or(false);
        let decorations = use_decorations();
        let window_builder = base_window_config(
            WebviewWindowBuilder::new(app, Self::LABEL, WebviewUrl::App("/".into())),
            app,
            decorations,
        )
        .title("DuoDuoCode")
        .disable_drag_drop_handler()
        .zoom_hotkeys_enabled(false)
        // Start invisible — let tauri-plugin-window-state restore the saved
        // position/size/maximized state first, then make the window visible.
        // Without this, the window flashes as maximized before resizing to
        // the previously saved (smaller) dimensions.
        .visible(false)
        .initialization_script(format!(
            r#"
            window.__DUODUO__ ??= {{}};
            window.__DUODUO__.updaterEnabled = {UPDATER_ENABLED};
            window.__DUODUO__.wsl = {wsl_enabled};
          "#
        ));

        let window = window_builder.build()?;

        // Intercept window close: prevent the default close, perform async
        // sidecar/smart-layer cleanup on a background task, then exit the
        // process.  This avoids blocking the main thread (which would freeze
        // the UI and show the spinning cursor on Windows/macOS).
        setup_close_handler(app, &window);

        // tauri-plugin-window-state restores the saved position/size/maximized
        // state asynchronously after window creation. Since we created the window
        // as invisible, we delay showing it slightly so the state restoration
        // completes first — this prevents the visual "maximize then shrink" glitch.
        // For first launch (no saved state), default to maximized.
        let window_clone = window.clone();
        tokio::spawn(async move {
            // Give window-state plugin time to restore the saved state
            tokio::time::sleep(Duration::from_millis(100)).await;

            let is_maximized = window_clone.is_maximized().unwrap_or(false);
            if !is_maximized {
                // First launch: no saved state — maximize the window
                let _ = window_clone.maximize();
            }
            let _ = window_clone.show();
            let _ = window_clone.set_focus();
        });

        setup_window_state_listener(app, &window);

        Ok(Self(window))
    }
}

/// Intercept the main window close request. Instead of letting the window
/// close immediately (which triggers synchronous sidecar cleanup on the main
/// thread and freezes the UI), we:
/// 1. Prevent the default close.
/// 2. Hide the window so the user perceives the app as closed.
/// 3. Spawn an async task that gracefully shuts down the sidecar and
///    smart-layer process.
/// 4. Call `app.exit(0)` once cleanup finishes.
fn setup_close_handler(app: &AppHandle, window: &WebviewWindow) {
    let app_clone = app.clone();
    let window_clone = window.clone();

    window.on_window_event(move |event| {
        let tauri::WindowEvent::CloseRequested { api, .. } = event else {
            return;
        };

        // If a shutdown is already in progress (e.g. triggered by the
        // kill_sidecar command from the updater), let the default close
        // proceed normally.
        if crate::SHUTTING_DOWN.load(Ordering::SeqCst) {
            return;
        }

        // Block the default window close.
        api.prevent_close();

        // Immediately hide the window so the app appears to have closed.
        let _ = window_clone.hide();

        // Perform async cleanup, then exit.
        let app = app_clone.clone();
        tauri::async_runtime::spawn(async move {
            crate::shutdown_sidecar_and_smart_layer(&app).await;

            // Close/destroy all windows before app.exit(0) to release
            // WebView2 resources on Windows.  Without this, the
            // Chrome_WidgetWin_0 window class is still registered when
            // the process exits, causing Error 1410 on Windows shutdown.
            for window in app.webview_windows().values() {
                let _ = window.close();
            }

            // Give WebView2 a brief moment to fully release resources
            // before process exit, avoiding Error 1412 ("Class still in use")
            // on Windows.
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;

            app.exit(0);
        });
    });
}

fn setup_window_state_listener(app: &AppHandle, window: &WebviewWindow) {
    let (tx, mut rx) = mpsc::channel::<()>(1);

    window.on_window_event(move |event| {
        use tauri::WindowEvent;
        if !matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
            return;
        }
        let _ = tx.try_send(());
    });

    tokio::spawn({
        let app = app.clone();

        async move {
            let save = || {
                let handle = app.clone();
                let app = app.clone();
                let _ = handle.run_on_main_thread(move || {
                    let _ = app.save_window_state(window_state_flags());
                });
            };

            while rx.recv().await.is_some() {
                tokio::time::sleep(Duration::from_millis(200)).await;

                save();
            }
        }
    });
}



pub fn base_window_config<'a, R: Runtime, M: Manager<R>>(
    window_builder: WebviewWindowBuilder<'a, R, M>,
    _app: &AppHandle,
    decorations: bool,
) -> WebviewWindowBuilder<'a, R, M> {
    let window_builder = window_builder.decorations(decorations);

    #[cfg(windows)]
    let window_builder = window_builder
        // Some VPNs set a global/system proxy that WebView2 applies even for loopback
        // connections, which breaks the app's localhost sidecar server.
        // Note: when setting additional args, we must re-apply wry's default
        // `--disable-features=...` flags.
        .additional_browser_args(
            "--proxy-bypass-list=<-loopback> --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection",
        )
        .data_directory(
            _app.path()
                .config_dir()
                .expect("invariant: config_dir resolves on any initialized Tauri app")
                .join(
                    _app.config()
                        .product_name
                        .clone()
                        .expect("invariant: productName is set in tauri.conf.json"),
                ),
        )
        .decorations(false)
        // Provide a sensible initial size and center the window so the splash
        // screen renders at a reasonable size in the middle of the screen,
        // instead of Tauri's default 800x600 anchored at top-left (which made
        // the loading logo appear in the corner before the async maximize
        // kicks in). `tauri-plugin-window-state` will override these when it
        // restores the user's saved window state.
        .inner_size(1280.0, 800.0)
        .center();

    #[cfg(target_os = "linux")]
    let window_builder = window_builder
        // Same rationale as Windows: avoid the default 800x600 top-left anchor
        // so the splash screen is centered on first launch.
        .inner_size(1280.0, 800.0)
        .center();

    #[cfg(target_os = "macos")]
    let window_builder = window_builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(12.0, 18.0))
        // Match the splash screen background (#101010 dark / #f8f8f8 light) so the
        // native window background never flashes a different color under the
        // Overlay title bar or before the WebView paints its first frame.
        .background_color(Color(0x10, 0x10, 0x10, 0xFF));

    window_builder
}
