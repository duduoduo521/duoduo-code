use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::OnceLock;
use tracing_appender::non_blocking::WorkerGuard;

/// Size-based rotation threshold per stream (bytes).
const MAX_BYTES: u64 = 3 * 1024 * 1024;
/// Number of rotated generations kept (`backend.log.1` .. `backend.log.MAX_GEN`).
const MAX_GEN: usize = 5;

/// A `std::io::Write` wrapper that appends to `base` and rotates the file once
/// it exceeds `MAX_BYTES`, shifting existing generations (`backend.log.1`,
/// `backend.log.2`, …) and dropping the oldest. Mirrors the TS-side rotation
/// used by `packages/duoduo/src/util/log.ts`.
struct SizeRollingWriter {
    base: PathBuf,
    file: Option<File>,
    bytes: u64,
}

impl SizeRollingWriter {
    fn open(base: &std::path::Path) -> io::Result<Self> {
        let file = OpenOptions::new().create(true).append(true).open(base)?;
        let bytes = file.metadata()?.len();
        Ok(Self { base: base.to_path_buf(), file: Some(file), bytes })
    }

    fn gen_path(&self, generation: usize) -> PathBuf {
        self.base.with_extension(format!("log.{}", generation))
    }

    fn rotate(&mut self) -> io::Result<()> {
        if let Some(f) = self.file.as_mut() {
            f.flush()?;
        }
        // Drop the handle so the file can be renamed (Windows locks open files).
        self.file = None;
        let _ = fs::remove_file(self.gen_path(MAX_GEN));
        for g in (1..MAX_GEN).rev() {
            let src = self.gen_path(g);
            let dst = self.gen_path(g + 1);
            if src.exists() {
                let _ = fs::rename(&src, &dst);
            }
        }
        let _ = fs::rename(&self.base, self.gen_path(1));
        self.file = Some(OpenOptions::new().create(true).append(true).open(&self.base)?);
        self.bytes = 0;
        Ok(())
    }
}

impl io::Write for SizeRollingWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.bytes + buf.len() as u64 > MAX_BYTES {
            self.rotate()?;
        }
        let n = self
            .file
            .as_mut()
            .ok_or_else(|| io::Error::other("log writer closed"))?
            .write(buf)?;
        self.bytes += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        if let Some(f) = self.file.as_mut() {
            f.flush()
        } else {
            Ok(())
        }
    }
}

/// Keeps the non-blocking worker guards alive for the process lifetime so
/// buffered logs are flushed on shutdown.
static FILE_GUARDS: OnceLock<(WorkerGuard, WorkerGuard)> = OnceLock::new();

/// Initialize tracing with optional OTel support.
/// When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, configures an OTLP exporter
/// and registers a TraceContextPropagator for cross-service trace propagation.
///
/// Diagnostic logs are always written to the file store when `DUODUO_LOG_DIR`
/// is provided (set by the desktop host when spawning this sidecar). The
/// terminal (stdout/stderr) mirror is kept in debug builds or when
/// `DUODUO_LOG_CONSOLE` is set, so the canonical store is the file, not the
/// terminal.
///
/// All layers are always registered; disabled ones use a `LevelFilter::OFF`
/// filter so the subscriber type stays static (dynamic `dyn Layer` does not
/// propagate across `Layered` subscribers).
pub fn init_tracing() {
    use tracing_subscriber::EnvFilter;
    use tracing_subscriber::Layer;
    use tracing_subscriber::filter::LevelFilter;
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("duo_smart_layer=debug,tower_http=debug,agent_executor::intel_gear=info"));

    // OTel: only configure the exporter/provider when the endpoint is set. The
    // layer itself is always present and is a no-op without a configured provider.
    if let Ok(endpoint) = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT") {
        use opentelemetry::global::set_text_map_propagator;
        use opentelemetry_otlp::WithExportConfig;
        use opentelemetry_sdk::propagation::TraceContextPropagator;
        use opentelemetry_sdk::trace::TracerProvider as SdkTracerProvider;

        set_text_map_propagator(TraceContextPropagator::new());

        let traces_endpoint = if endpoint.trim_end_matches('/').ends_with("/v1/traces") {
            endpoint
        } else {
            format!("{}/v1/traces", endpoint.trim_end_matches('/'))
        };

        let exporter = opentelemetry_otlp::SpanExporter::builder()
            .with_http()
            .with_endpoint(traces_endpoint)
            .build()
            .expect("Failed to build OTLP span exporter");

        let tracer_provider = SdkTracerProvider::builder()
            .with_simple_exporter(exporter)
            .build();

        opentelemetry::global::set_tracer_provider(tracer_provider);
    }
    let otel_layer = tracing_opentelemetry::layer();

    // File store (canonical). Falls back to a temp dir when `DUODUO_LOG_DIR` is
    // unset, but stays silent via an `OFF` filter so it produces no output.
    let file_enabled = std::env::var("DUODUO_LOG_DIR").is_ok();
    let day_dir = if let Ok(d) = std::env::var("DUODUO_LOG_DIR") {
        std::path::PathBuf::from(d)
    } else {
        std::env::temp_dir().join("duo-smart-layer")
    };
    let _ = std::fs::create_dir_all(&day_dir);
    let (nb, ng) = tracing_appender::non_blocking(
        SizeRollingWriter::open(&day_dir.join("backend.log")).expect("failed to create backend log"),
    );
    let (eb, eg) = tracing_appender::non_blocking(
        SizeRollingWriter::open(&day_dir.join("backend.error.log")).expect("failed to create backend error log"),
    );
    FILE_GUARDS.get_or_init(|| (ng, eg));

    let normal_layer = tracing_subscriber::fmt::layer()
        .with_writer(nb)
        .with_ansi(false)
        .with_filter(if file_enabled { LevelFilter::INFO } else { LevelFilter::OFF });
    let error_layer = tracing_subscriber::fmt::layer()
        .with_writer(eb)
        .with_ansi(false)
        .with_filter(if file_enabled { LevelFilter::ERROR } else { LevelFilter::OFF });

    // Terminal mirror (dev only). In release the terminal is not the canonical
    // store; logs go to the file layer above.
    let stdout_layer = tracing_subscriber::fmt::layer()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .with_filter(if cfg!(debug_assertions) || std::env::var("DUODUO_LOG_CONSOLE").is_ok() {
            LevelFilter::TRACE
        } else {
            LevelFilter::OFF
        });

    tracing_subscriber::registry()
        .with(env_filter)
        .with(otel_layer)
        .with(stdout_layer)
        .with(normal_layer)
        .with(error_layer)
        .init();

    tracing::info!(
        "tracing initialized (file logging {})",
        if file_enabled { "enabled" } else { "disabled" }
    );
}

#[derive(Clone)]
pub struct ExtractedTraceContext(opentelemetry::Context);

impl ExtractedTraceContext {
    pub fn into_context(self) -> opentelemetry::Context {
        self.0
    }
}

/// Axum middleware that extracts traceparent from incoming request headers
/// and injects the extracted OTel context as a request extension.
/// Handler functions can then call `set_parent` on their own span using
/// the extension, ensuring the trace context propagates from the
/// middleware into the actual request handler span.
pub async fn otel_trace_extractor(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use opentelemetry::global::get_text_map_propagator;

    struct HeaderExtractor<'a>(&'a axum::http::HeaderMap);
    impl<'a> opentelemetry::propagation::Extractor for HeaderExtractor<'a> {
        fn get(&self, key: &str) -> Option<&str> {
            self.0.get(key).and_then(|v| v.to_str().ok())
        }
        fn keys(&self) -> Vec<&str> {
            self.0.keys().map(|k| k.as_str()).collect()
        }
    }

    let headers = req.headers().clone();
    let parent_cx =
        get_text_map_propagator(|propagator| propagator.extract(&HeaderExtractor(&headers)));

    // Inject the extracted context as a request extension so that handler
    // functions can set it as the parent of their own #[instrument] span.
    // This avoids the problem where set_parent on the middleware's ephemeral
    // span is lost before the handler runs.
    let mut req = req;
    req.extensions_mut()
        .insert(ExtractedTraceContext(parent_cx));

    next.run(req).await
}

pub mod duoduo_client;
#[path = "duoduo_sync.rs"]
pub mod duoduo_sync;
pub mod error;
pub mod im_bridge_impl;
pub mod im_runtime;
pub mod lazy_init;
pub mod project_tasks;
pub mod routes;
pub mod secure_store;
pub mod server;

use axum::Json;
use axum::extract::Request;
use axum::Router;
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use base64::Engine as _;
use http::Method;
use serde_json::{Value, json};
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::cors::{AllowOrigin, CorsLayer};

/// Lightweight health-check handler that does not depend on AppState.
/// Returns a simple 200 JSON response for liveness/readiness probes.
async fn health_probe() -> Json<Value> {
    Json(json!({
        "status": "ok"
    }))
}

/// Username expected in the `Authorization: Basic` header sent by clients
/// (TS sidecar / Tauri desktop). Matches the default used in
/// `packages/duoduo/src/smart-layer/index.ts` and the Rust desktop
/// `get_smart_layer_auth_header` helper.
const SMART_LAYER_AUTH_USER: &str = "smart-layer";

/// Axum middleware that authenticates every request against the password
/// distributed via the `DUO_SMART_LAYER_PASSWORD` environment variable.
///
/// Behavior (decision point 1 = "skip when unset"):
/// - If `DUO_SMART_LAYER_PASSWORD` is **not set** (e.g. bare CLI / manual
///   launch without the desktop-sidecar injection), the middleware is a
///   no-op and passes the request through unchanged. This preserves the
///   historical behavior for non-desktop launches and avoids breaking the
///   TS sidecar's own calls in `--mdns` / `0.0.0.0` modes (handled in P1-2).
/// - If the password **is set**, the request must carry a valid
///   `Authorization: Basic <base64("smart-layer:<password>")>` header;
///   otherwise a `401 Unauthorized` is returned.
///
/// The expected password is read once per process and cached in an
/// `OnceLock`, so the (potentially missing) env lookup happens at most once.
fn expected_password() -> Option<&'static str> {
    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    CACHE
        .get_or_init(|| std::env::var(duo_types::env_keys::smart_layer::PASSWORD).ok())
        .as_deref()
}

async fn require_auth(req: Request, next: Next) -> Response {
    // Decision point 1: no password configured → no auth required (legacy
    // bare-cli behavior preserved; desktop mode always injects one).
    let Some(expected) = expected_password() else {
        return next.run(req).await;
    };

    let unauthorized = || {
        (
            StatusCode::UNAUTHORIZED,
            [(
                axum::http::header::WWW_AUTHENTICATE,
                "Basic realm=\"duo-smart-layer\"",
            )],
            "unauthorized",
        )
            .into_response()
    };

    let header = match req.headers().get(axum::http::header::AUTHORIZATION) {
        Some(h) => h,
        None => return unauthorized(),
    };

    // Parse "Basic <token>".
    let value = match header.to_str() {
        Ok(v) => v,
        Err(_) => return unauthorized(),
    };
    let token = match value.strip_prefix("Basic ") {
        Some(t) => t.trim(),
        None => return unauthorized(),
    };

    // Decode base64 credentials ("user:password").
    let decoded = match base64::engine::general_purpose::STANDARD.decode(token) {
        Ok(d) => d,
        Err(_) => return unauthorized(),
    };
    let text = match std::str::from_utf8(&decoded) {
        Ok(t) => t,
        Err(_) => return unauthorized(),
    };
    let (user, pass) = match text.split_once(':') {
        Some((u, p)) => (u, p),
        None => return unauthorized(),
    };

    // Decision point 2: standard `==` comparison. The password is a 128-bit
    // random UUID, so timing-side-channel attacks are not feasible; no
    // constant-time crate is required.
    if user == SMART_LAYER_AUTH_USER && pass == expected {
        next.run(req).await
    } else {
        unauthorized()
    }
}

/// Default allowed origins used when `CORS_ALLOWED_ORIGINS` is unset, empty,
/// or contains no parseable entries.
///
/// Includes localhost variants and Tauri-specific schemes so that both
/// local development and the Tauri webview can reach the API.
fn default_allowed_origins() -> AllowOrigin {
    AllowOrigin::list([
        format!("http://{}", duo_types::DEFAULT_HOSTNAME)
            .parse()
            .expect("invariant: default origin built from compile-time const hostname is a valid header value"),
        "http://localhost"
            .parse()
            .expect("invariant: static origin literal is a valid header value"),
        "tauri://localhost"
            .parse()
            .expect("invariant: static origin literal is a valid header value"),
        "https://tauri.localhost"
            .parse()
            .expect("invariant: static origin literal is a valid header value"),
        "http://tauri.localhost"
            .parse()
            .expect("invariant: static origin literal is a valid header value"),
        "http://localhost:1420" // Vite dev server
            .parse()
            .expect("invariant: static origin literal is a valid header value"),
    ])
}

/// Build the allowed origins from the `CORS_ALLOWED_ORIGINS` environment variable.
/// - If not set or empty, falls back to localhost + Tauri default whitelist.
/// - If set, parses as a comma-separated list of origins and uses `AllowOrigin::list()`.
/// - If set but no entries parse successfully, also falls back to the default whitelist.
///
/// SAFETY: No code path in this function produces `AllowOrigin::any()`.
fn build_allowed_origins() -> AllowOrigin {
    match std::env::var(duo_types::env_keys::smart_layer::CORS_ALLOWED_ORIGINS) {
        Ok(val) if !val.is_empty() => {
            let origins: Vec<_> = val
                .split(',')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .filter_map(|s| s.parse().ok())
                .collect();
            if origins.is_empty() {
                tracing::warn!(
                    "CORS_ALLOWED_ORIGINS set but contained no valid origins; falling back to default whitelist"
                );
                default_allowed_origins()
            } else {
                tracing::info!(
                    "CORS: restricting allowed origins to {} entries",
                    origins.len()
                );
                AllowOrigin::list(origins)
            }
        }
        _ => {
            tracing::info!(
                "CORS_ALLOWED_ORIGINS not set; restricting to localhost + Tauri origins"
            );
            default_allowed_origins()
        }
    }
}

/// Build the complete axum router with all routes and the given app state.
/// This is the same router construction used in `main.rs`, exposed for testing.
pub fn build_router(app_state: server::AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::PATCH,
            Method::OPTIONS,
        ])
        .allow_headers([
            http::header::CONTENT_TYPE,
            http::header::AUTHORIZATION,
            http::header::ACCEPT,
            http::HeaderName::from_static("x-session-id"),
            http::HeaderName::from_static("traceparent"),
        ])
        .allow_origin(build_allowed_origins());

    // Stateless liveness probe (no AppState dependency, always returns 200).
    // Mounted OUTSIDE the auth layer (decision point 3: no callers currently
    // hit it, kept unauthenticated to stay a pure survival check).
    let healthz = Router::new().route("/healthz", get(health_probe));

    // Authenticated application routes. `require_auth` is applied to the
    // whole tree so every merged sub-router is protected. When
    // `DUO_SMART_LAYER_PASSWORD` is unset, `require_auth` is a no-op.
    let protected = Router::new()
        .merge(routes::health::router())
        .merge(routes::memory::router())
        .merge(routes::quality::router())
        .merge(routes::intent::router())
        .merge(routes::feedback::router())
        .merge(routes::session::router())
        .merge(routes::agent::router())
        .merge(routes::search::router())
        .merge(routes::graph::router())
        .merge(routes::ast::router())
        .merge(routes::blackboard::router())
        .merge(routes::plan::router())
        .merge(routes::dna::router())
        .merge(routes::events::router())
        .merge(routes::im::router())
        .merge(routes::context::router())
        .merge(routes::storage::router())
        .merge(routes::gear::router())
        .merge(routes::permission::router())
        .with_state(app_state)
        .layer(middleware::from_fn(require_auth));

    healthz
        .merge(protected)
        .layer(axum::middleware::from_fn(otel_trace_extractor))
        .layer(cors)
        .layer(CatchPanicLayer::new())
}
