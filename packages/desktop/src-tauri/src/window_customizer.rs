use tauri::{Manager, Runtime, Window, plugin::Plugin};

pub struct PinchZoomDisablePlugin;

impl Default for PinchZoomDisablePlugin {
    fn default() -> Self {
        Self
    }
}

impl<R: Runtime> Plugin<R> for PinchZoomDisablePlugin {
    fn name(&self) -> &'static str {
        "Does not matter here"
    }

    fn window_created(&mut self, window: Window<R>) {
        let Some(webview_window) = window.get_webview_window(window.label()) else {
            return;
        };

        let _ = webview_window.with_webview(|_webview| {
            #[cfg(target_os = "linux")]
            unsafe {
                use gtk::GestureZoom;
                use gtk::glib::ObjectExt;
                use webkit2gtk::glib::gobject_ffi;

                if let Some(data) = _webview.inner().data::<GestureZoom>("wk-view-zoom-gesture") {
                    gobject_ffi::g_signal_handlers_destroy(data.as_ptr().cast());
                }
            }

            #[cfg(target_os = "macos")]
            unsafe {
                use objc2::rc::Retained;
                use objc2_web_kit::WKWebView;

                // Get the WKWebView pointer and disable magnification gestures
                // This prevents Cmd+Ctrl+scroll and pinch-to-zoom from changing the zoom level
                // Best-effort: a failed retain only means magnification stays enabled;
                // panicking here would abort webview setup inside the plugin callback.
                if let Some(wk_webview) = Retained::retain(_webview.inner().cast()) {
                    let wk_webview: Retained<WKWebView> = wk_webview;
                    wk_webview.setAllowsMagnification(false);
                } else {
                    tracing::warn!("failed to retain WKWebView; magnification stays enabled");
                }
            }

            // Windows WebView2: Disable the default context menu and pinch zoom.
            //
            // 1. Set AreDefaultContextMenusEnabled = false on the WebView2 settings
            //    to prevent the native right-click menu (Back, Refresh, Save As,
            //    Print, Inspect) from appearing. Without this, WebView2 shows its
            //    native context menu even when the web content calls e.preventDefault()
            //    on the contextmenu event, because WebView2 may trigger the native
            //    menu before the DOM event fully bubbles through SolidJS's delegated
            //    event system.
            //
            // 2. Pinch zoom is disabled via CSS touch-action and WebView2 command-line
            //    args set in windows.rs (disable-features).
            #[cfg(windows)]
            unsafe {
                // Best-effort customization: a WebView2 COM failure must not
                // abort webview setup — the user just keeps the default
                // context menu / pinch zoom.
                let controller = _webview.controller();
                let Ok(core_webview) = controller.CoreWebView2() else {
                    tracing::error!("failed to get CoreWebView2 from controller; context menu customization skipped");
                    return;
                };
                let Ok(settings) = core_webview.Settings() else {
                    tracing::error!("failed to get WebView2 settings; context menu customization skipped");
                    return;
                };
                if let Err(e) = settings.SetAreDefaultContextMenusEnabled(false) {
                    tracing::error!("failed to disable WebView2 default context menu: {e}");
                }
            }
        });
    }
}
