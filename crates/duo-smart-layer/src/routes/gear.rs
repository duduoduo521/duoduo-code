//! Gear (IntelGear) management routes.
//!
//! Exposes CRUD + marketplace + MCP-server bridging for the unified capability
//! packages that *replace* the legacy Skill / MCP / Tool concepts. Gears live under
//! the directory named by `DUODUO_GEARS_DIR` (set by the desktop launcher), the same
//! path `agent_executor::intel_gear::load_gears_from_env` reads for prompt injection,
//! so a gear installed here is automatically picked up by the next agent run.
//!
//! The `tools/mcp.json` declaration written by [`add_mcp`] is consumed on the
//! desktop path by `agent_executor::mcp` (`ensure_gear_mcp`): the Rust run loop
//! connects the declared MCP server, lists its tools, merges them into the LLM
//! tool list, and routes calls back to it — so a gear installed here immediately
//! bridges its external MCP server into the agent's tool half (per
//! `01-架构设计.md` §2.1). This route only persists the declaration.

use axum::{
    Json, Router,
    extract::{Path as AxumPath, Query, State},
};
use duo_utils::sync::MutexPoisonRecover;
use serde::{Deserialize, Serialize};
use unified_error::{Result, UnifiedError};

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::server::AppState;

/// In-memory cache for `/gears/mcp/config` lookups. The resolved config rarely
/// changes, so we cache it for a long TTL to avoid re-fetching the upstream
/// registry on every install confirmation dialog.
struct McpConfigCacheEntry {
    at: Instant,
    cfg: agent_executor::intel_gear::market::McpServerConfig,
}

static MCP_CONFIG_CACHE: OnceLock<Mutex<HashMap<String, McpConfigCacheEntry>>> = OnceLock::new();
// Long-lived process cache: the upstream MCP config for a pinned server rarely
// changes, and the cache only lives as long as this process. A `refresh` query
// param bypasses it for on-demand re-validation (compliance/security).
const MCP_CONFIG_TTL: Duration = Duration::from_secs(60 * 60 * 24 * 7); // 7 days

fn mcp_config_cache() -> &'static Mutex<HashMap<String, McpConfigCacheEntry>> {
    MCP_CONFIG_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn mcp_config_cache_key(source: &str, server_id: &str, version: &str, token: &str) -> String {
    format!("{}|{}|{}|{}", source, server_id, version, token)
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/gears", axum::routing::get(list).post(create))
        .route("/gears/:name", axum::routing::delete(delete))
        .route("/gears/:name/activate", axum::routing::post(activate))
        .route(
            "/gears/:name/activation",
            axum::routing::post(set_activation).patch(set_activation),
        )
        .route("/gears/:name/enable", axum::routing::post(enable_gear))
        .route("/gears/:name/disable", axum::routing::post(disable_gear))
        .route("/gears/market", axum::routing::get(market))
        .route("/gears/install", axum::routing::post(install))
        .route("/gears/mcp", axum::routing::post(add_mcp))
        .route(
            "/gears/mcp/import",
            axum::routing::post(import_mcp),
        )
        .route(
            "/gears/mcp/config",
            axum::routing::get(mcp_config),
        )
        .route(
            "/gears/registry-sources",
            axum::routing::get(registry_sources),
        )
}

// ── Manifest model (subset of `01-架构设计.md` §2.2) ──

#[derive(Debug, Serialize, Deserialize, Default)]
struct GearCapabilities {
    #[serde(default)]
    instructions: bool,
    #[serde(default)]
    tools: Vec<String>,
    #[serde(default)]
    strategies: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct GearMetaToml {
    #[serde(default)]
    name: String,
    /// Gear kind: "native" | "skill" | "plugin" | "mcp" | "builtin". Written by
    /// `write_mcp_gear` as "mcp" so the gear is classified correctly on reload and
    /// surfaced as an MCP gear in the UI. It used to be omitted, leaving the kind
    /// empty (and defaulting to Native after a restart).
    #[serde(default)]
    kind: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    /// Marketplace spec this gear was installed from (e.g.
    /// `modelscope:Alipay/alipay-subscription`). Surfaced so the UI can show the
    /// same id/title as the market and backfill `display_name` for older gears.
    #[serde(default)]
    spec: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct GearManifestToml {
    #[serde(default)]
    meta: GearMetaToml,
    #[serde(default)]
    capabilities: GearCapabilities,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct GearInfo {
    id: String,
    name: String,
    /// Human-friendly title (mirrors the manifest's `display_name`); the UI
    /// falls back to `name` when this is `None`.
    #[serde(default)]
    display_name: Option<String>,
    /// Marketplace spec this gear was installed from (e.g.
    /// `modelscope:Alipay/alipay-subscription`), so the UI can show the same id.
    #[serde(default)]
    spec: Option<String>,
    version: String,
    description: String,
    kind: String,
    /// Activation policy: `command` | `auto` | `global`.
    activation: String,
    enabled: bool,
    license: Option<String>,
    has_instructions: bool,
    /// Declared capability tags (instructions/tools/strategies) for the UI.
    #[serde(default)]
    capabilities: GearCapabilities,
}

impl GearInfo {
    fn from_host(e: &agent_executor::intel_gear::host::GearInfo) -> Self {
        GearInfo {
            id: e.id.clone(),
            name: e.name.clone(),
            display_name: e.display_name.clone(),
            spec: e.spec.clone(),
            version: e.version.clone(),
            description: e.description.clone(),
            kind: format!("{:?}", e.kind).to_lowercase(),
            activation: format!("{:?}", e.activation).to_lowercase(),
            enabled: e.enabled,
            license: e.license.clone(),
            has_instructions: e.has_instructions,
            capabilities: GearCapabilities {
                instructions: e.capabilities.instructions,
                tools: e.capabilities.tools.clone(),
                strategies: e.capabilities.strategies.clone(),
            },
        }
    }

    fn from_dir(dir: &Path, name: &str) -> Self {
        let mut info = GearInfo {
            id: format!("native__{name}@1.0.0"),
            name: name.to_string(),
            version: "1.0.0".into(),
            ..Default::default()
        };
        if let Ok(txt) = fs::read_to_string(dir.join("manifest.toml"))
            && let Ok(manifest) = toml::from_str::<GearManifestToml>(&txt) {
                info.version = manifest.meta.version.unwrap_or_else(|| "1.0.0".into());
                info.description = manifest.meta.description.unwrap_or_default();
                info.display_name = manifest.meta.display_name.filter(|s| !s.trim().is_empty());
                info.spec = manifest.meta.spec.filter(|s| !s.trim().is_empty());
                // Carry the gear kind (e.g. "mcp" for marketplace MCP servers) so
                // the installed gear is shown as an MCP gear rather than an
                // unclassified one. Previously omitted, leaving `kind` empty.
                let k = manifest.meta.kind.trim();
                if !k.is_empty() {
                    info.kind = k.to_string();
                }
                info.capabilities = manifest.capabilities;
            }
        info.has_instructions = fs::read_to_string(dir.join("instructions.md"))
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        info
    }
}

// ── Helpers ──

/// Resolve the gear root directory from `DUODUO_GEARS_DIR`, the env var the desktop
/// launcher injects (same one `intel_gear::load_gears_from_env` reads).
fn gears_dir() -> std::result::Result<PathBuf, UnifiedError> {
    match std::env::var("DUODUO_GEARS_DIR") {
        Ok(d) if !d.trim().is_empty() => Ok(PathBuf::from(d)),
        _ => Err(UnifiedError::Configuration(
            "DUODUO_GEARS_DIR is not set; the desktop must launch the smart-layer with it".into(),
        )),
    }
}

/// Gear names are filesystem-safe identifiers.
fn is_valid_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && !name.starts_with('.')
}

/// Normalize a gear name / spec id to an alphanumeric-lowercase key so that
/// different sanitization schemes (market-skill `sanitize_name` lowercases and
/// maps `/`→`_`, while MCP `replace(['/',' '],"-")` does neither) still resolve
/// to the same installed gear.
fn norm_key(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_lowercase()
}

/// Whether a marketplace entry (spec like `modelscope-skill:<id>` or
/// `modelscope:<server_id>`) is already installed, by comparing its resolved
/// gear name against the set of installed gear names.
fn entry_installed(spec: &str, installed_norm: &std::collections::HashSet<String>) -> bool {
    let id = spec.split_once(':').map(|(_, v)| v).unwrap_or(spec);
    let expected = norm_key(&agent_executor::intel_gear::host::sanitize_name(id));
    installed_norm.contains(&expected)
}

/// Best-effort resolution of a marketplace entry's human title from its `spec`
/// (e.g. `modelscope:Alipay/alipay-subscription`), reusing the cached market
/// search so repeated calls are cheap. Returns `None` on any failure so the
/// caller can fall back to the stored `name`.
async fn resolve_market_title(spec: &str) -> Option<String> {
    let (source, id) = spec.split_once(':')?;
    match source {
        // Precise, id-based lookup: the list/search endpoint can't match ids
        // that contain `/` (e.g. `Alipay/alipay-subscription`), so resolve the
        // human title straight from the server detail endpoint.
        "modelscope" => {
            agent_executor::intel_gear::market::fetch_modelscope_server_title(id).await
        }
        // Skills: best-effort search fallback (no precise per-id meta endpoint).
        "modelscope-skill" => {
            let (entries, _, _, errors) =
                agent_executor::intel_gear::market::search_market_page(id, 1, 20, Some("skill"), false)
                    .await;
            if entries.is_empty() && !errors.is_empty() {
                return None;
            }
            let target = norm_key(spec);
            entries
                .into_iter()
                .find(|e| norm_key(&e.spec) == target)
                .map(|e| e.display_name)
                .filter(|s| !s.trim().is_empty())
        }
        _ => None,
    }
}

/// Best-effort: write a resolved marketplace title back into the gear's
/// `manifest.toml` so Settings shows it without a network round-trip afterwards
/// (and keeps working offline). Any failure is ignored.
fn persist_gear_display_name(name: &str, title: &str) {
    let Ok(base) = gears_dir() else { return };
    let Some(dir) = resolve_gear_dir(&base, name) else { return };
    let manifest_path = dir.join("manifest.toml");
    let Ok(txt) = fs::read_to_string(&manifest_path) else { return };
    let Ok(mut manifest) = toml::from_str::<GearManifestToml>(&txt) else { return };
    if manifest
        .meta
        .display_name
        .as_deref()
        .is_some_and(|s| !s.trim().is_empty())
    {
        return;
    }
    manifest.meta.display_name = Some(title.to_string());
    if let Ok(s) = toml::to_string_pretty(&manifest) {
        let _ = fs::write(manifest_path, s);
    }
}

/// Backfill market display names for installed gears that lack one (installed
/// before `display_name` was persisted), so Settings shows the same title the
/// market uses. Best-effort and network-guarded: only marketplace-sourced gears
/// are queried, and any failure is ignored (the stored `name` remains). A
/// successfully resolved title is also persisted to the manifest so it survives
/// offline and later opens.
async fn enrich_market_titles(gears: &mut [GearInfo]) {
    for g in gears.iter_mut() {
        let needs = g.display_name.as_deref().is_none_or(|s| s.trim().is_empty());
        if !needs {
            continue;
        }
        // Stored marketplace spec, or — for an older MCP gear without one —
        // reconstruct `modelscope:<server_id>` by reversing the slug's first `-`.
        let spec = match g.spec.clone() {
            Some(s) if !s.trim().is_empty() => s,
            None if g.kind == "mcp" => format!("modelscope:{}", g.name.replacen('-', "/", 1)),
            _ => continue,
        };
        if let Some(title) = resolve_market_title(&spec).await {
            g.display_name = Some(title.clone());
            persist_gear_display_name(&g.name, &title);
        }
    }
}

// ── Handlers ──

/// GET /gears — list installed gears. Prefers the GearHost registry (which carries
/// kind/activation/enabled), then merges any filesystem-only gear dirs not yet loaded.
async fn list(State(state): State<AppState>) -> Result<Json<Vec<GearInfo>>> {
    let mut out: Vec<GearInfo> = state
        .gear_host
        .list_detailed()
        .iter()
        .map(GearInfo::from_host)
        .collect();

    // Merge filesystem gear dirs the host hasn't loaded (e.g. just dropped in).
    if let Ok(dir) = gears_dir()
        && let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                // M7 (B5): interrupted installs leave `.tmp-*` / `.broken-*`
                // staging dirs — never list them as installed gears.
                let raw_name = entry.file_name().to_string_lossy().to_string();
                if raw_name.contains(".tmp-") || raw_name.contains(".broken-") {
                    continue;
                }
                // The directory name can differ from the gear's manifest name
                // (e.g. marketplace skills are stored under `skill-<name>`). Read
                // the manifest so we dedup against the real gear name rather than
                // the raw directory name — otherwise an installed skill would be
                // listed twice (once from the host registry, once from this scan).
                let manifest_name = fs::read_to_string(path.join("manifest.toml"))
                    .ok()
                    .and_then(|txt| toml::from_str::<GearManifestToml>(&txt).ok())
                    .map(|m| m.meta.name);
                let name = manifest_name
                    .clone()
                    .unwrap_or_else(|| entry.file_name().to_string_lossy().to_string());
                if !out.iter().any(|g| g.name.eq_ignore_ascii_case(&name)) {
                    out.push(GearInfo::from_dir(&path, &name));
                }
            }
        }

    out.sort_by(|a, b| a.name.cmp(&b.name));
    // Backfill market titles so Settings mirrors the market (best-effort).
    enrich_market_titles(&mut out).await;
    Ok(Json(out))
}

#[derive(Debug, Deserialize)]
struct CreateGearReq {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    instructions: String,
}

/// POST /gears — scaffold a new local gear (manifest.toml + optional instructions.md).
async fn create(
    State(_state): State<AppState>,
    Json(req): Json<CreateGearReq>,
) -> Result<Json<GearInfo>> {
    let name = req.name.trim();
    if name.is_empty() {
        return Err(UnifiedError::BadRequest("gear name is required".into()));
    }
    if !is_valid_name(name) {
        return Err(UnifiedError::BadRequest(
            "gear name must be alphanumeric, '-' or '_' (no leading dot)".into(),
        ));
    }
    let dir = gears_dir()?;
    let gear_dir = dir.join(name);
    if gear_dir.exists() {
        return Err(UnifiedError::BadRequest(format!(
            "gear '{name}' already exists"
        )));
    }

    fs::create_dir_all(&gear_dir)
        .map_err(|e| UnifiedError::Internal(format!("create gear dir: {e}")))?;

    let manifest = GearManifestToml {
        meta: GearMetaToml {
            name: name.to_string(),
            kind: "native".to_string(),
            version: Some("1.0.0".into()),
            description: Some(req.description.trim().to_string()),
            author: Some("user".into()),
            display_name: None,
            spec: None,
        },
        capabilities: GearCapabilities {
            instructions: !req.instructions.trim().is_empty(),
            ..Default::default()
        },
    };
    let toml_str = toml::to_string_pretty(&manifest)
        .map_err(|e| UnifiedError::Internal(format!("serialize manifest: {e}")))?;
    fs::write(gear_dir.join("manifest.toml"), toml_str)
        .map_err(|e| UnifiedError::Internal(format!("write manifest: {e}")))?;

    if !req.instructions.trim().is_empty() {
        fs::write(gear_dir.join("instructions.md"), req.instructions.trim())
            .map_err(|e| UnifiedError::Internal(format!("write instructions: {e}")))?;
    }

    Ok(Json(GearInfo::from_dir(&gear_dir, name)))
}

/// Resolve the on-disk directory for a gear addressed by its UI name (the
/// manifest `name`). Install paths disagree on the directory name:
/// marketplace skills live under `skill-<name>` (see `market_gear_dir`), while
/// native/MCP gears live under `<name>`. We probe the literal name, the
/// `skill-` prefix, and finally scan each `manifest.toml` for a matching
/// `meta.name` so deletion works regardless of how the gear was installed.
fn resolve_gear_dir(base: &Path, name: &str) -> Option<PathBuf> {
    let exact = base.join(name);
    if exact.is_dir() {
        return Some(exact);
    }
    let prefixed = base.join(format!("skill-{}", name));
    if prefixed.is_dir() {
        return Some(prefixed);
    }
    let entries = fs::read_dir(base).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        if let Ok(txt) = fs::read_to_string(p.join("manifest.toml"))
            && let Ok(mani) = toml::from_str::<GearManifestToml>(&txt)
                && mani.meta.name.eq_ignore_ascii_case(name) {
                    return Some(p);
                }
    }
    None
}

/// DELETE /gears/:name — remove an installed gear.
async fn delete(
    State(state): State<AppState>,
    AxumPath(name): AxumPath<String>,
) -> Result<Json<serde_json::Value>> {
    if !is_valid_name(&name) {
        return Err(UnifiedError::BadRequest("invalid gear name".into()));
    }
    let base = gears_dir()?;
    // Drop the in-memory registry entry first (idempotent if already absent),
    // so a stale "still showing" entry is cleared even when its files are gone.
    let registry_id = state.gear_host.find_id_by_name(&name);
    if let Some(id) = &registry_id {
        let _ = state.gear_host.uninstall(id);
    }
    match resolve_gear_dir(&base, &name) {
        Some(dir) => {
            // On Windows the gear's MCP subprocess (or an indexer) may briefly hold
            // file handles, so retry a few times before giving up — a half-removed
            // directory would otherwise re-appear after the next restart.
            let mut last_err: Option<std::io::Error> = None;
            for _ in 0..3 {
                match fs::remove_dir_all(&dir) {
                    Ok(()) => {
                        last_err = None;
                        break;
                    }
                    Err(e) => {
                        last_err = Some(e);
                        std::thread::sleep(std::time::Duration::from_millis(200));
                    }
                }
            }
            if let Some(e) = last_err {
                return Err(UnifiedError::Internal(format!("remove gear '{name}': {e}")));
            }
        }
        None => {
            // Nothing on disk. If it was only a stale registry entry it is now
            // removed; otherwise there is genuinely nothing to delete.
            if registry_id.is_none() {
                return Err(UnifiedError::NotFound(format!("gear '{name}' not found")));
            }
        }
    }
    // Drop any persisted activation override so the deleted gear leaves no
    // leftover entry in `.activation_overrides.json`.
    state.gear_host.clear_activation_override(&name);
    // Tear down any live MCP stdio child process owned by this gear. The gear files
    // are already gone, but the spawn handler in `agent-executor::mcp` keeps the
    // process (and its pipes) alive until explicitly killed — otherwise it leaks.
    agent_executor::mcp::shutdown_gear_mcp_by_gear(&name).await;
    Ok(Json(serde_json::json!({ "deleted": name })))
}

// ── Marketplace ──

#[derive(Debug, Serialize, Deserialize, Clone)]
struct GearMarketEntry {
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    version: Option<String>,
    /// "native" | "skill" | "plugin" | "mcp" | "builtin"
    #[serde(default)]
    kind: String,
    /// Relative file paths fetched from the registry base URL.
    #[serde(default)]
    files: Vec<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    homepage: Option<String>,
    #[serde(default)]
    license: Option<String>,
    #[serde(default)]
    activation: Option<String>,
    #[serde(default)]
    installed: bool,
    /// Full spec string, e.g. "mcp:my-server" or "skill:my-skill"
    #[serde(default)]
    spec: String,
    /// Direct download URL for the marketplace install pipeline
    /// (`source_url` for skills).
    #[serde(default)]
    download_url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct GearMarketIndex {
    #[serde(default)]
    gears: Vec<GearMarketEntry>,
    /// Total number of entries matching the query + kind filter (before paging).
    /// Surfaced so the UI can show a count and decide when to stop paging.
    #[serde(default)]
    total: usize,
    /// Page number that was served (echoed from the request).
    #[serde(default)]
    page: usize,
    /// Page size that was used (echoed from the request).
    #[serde(default)]
    page_size: usize,
    /// Whether more pages exist after the current one (drives infinite scroll).
    #[serde(default)]
    has_more: bool,
    /// True when one or more upstream sources failed to respond. The UI shows a
    /// non-blocking banner (e.g. "数据源连接失败，请检查网络/代理") instead of
    /// silently leaving the list empty — this is what turns the old "stuck on
    /// skeleton / no data" symptom into an explainable, retryable error.
    #[serde(default)]
    degraded: bool,
    /// Human-readable reason for `degraded` (first upstream error). `None` when
    /// every source succeeded.
    #[serde(default)]
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MarketQuery {
    #[serde(default)]
    url: Option<String>,
    /// Optional explicit source id (e.g. "modelscope", "mcp-registry" or a
    /// custom git-index URL). When absent/empty/"all", the aggregated
    /// multi-source list (ModelScope MCP + ModelScope Skills) is
    /// returned with TTL caching.
    #[serde(default)]
    source: Option<String>,
    /// When true, bypass the aggregated-list TTL cache and refetch upstream.
    #[serde(default)]
    refresh: Option<bool>,
    /// Server-side kind filter applied before paging: "all" | "mcp" | "skill"
    /// (also native/plugin/builtin). "all"/absent ⇒ no filter. Lets the UI drive
    /// on-demand (infinite-scroll) paging over a pre-filtered list instead of
    /// filtering client-side.
    #[serde(default)]
    kind: Option<String>,
    /// 1-based page number for on-demand paging.
    #[serde(default)]
    page: Option<usize>,
    /// Page size for on-demand paging (default 20).
    #[serde(default)]
    page_size: Option<usize>,
}

/// GET /gears/market — unified marketplace search (paged).
/// Query params: `url` (search query string), optional `source` (legacy
/// single-source mode), `kind` (all|mcp|skill), `page`, `page_size`, `refresh`.
async fn market(
    State(state): State<AppState>,
    Query(q): Query<MarketQuery>,
) -> Result<Json<GearMarketIndex>> {
    let query = q.url.unwrap_or_default();
    let source_id = q
        .source
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("all"));
    let page = q.page.unwrap_or(1).max(1);
    let page_size = q.page_size.unwrap_or(20).max(1);
    let kind = q
        .kind
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("all"));

    // The backend fetches ONLY the requested page (never the whole catalog), so
    // this stays bounded (~1-2 upstream calls) and the UI's skeleton always
    // clears even when the upstream catalog is large. `kind` is applied at the
    // source level so the returned entries already match the filter.
    let page_u32 = page as u32;
    let page_size_u32 = page_size as u32;
    let (entries, has_more, total, errors) = match source_id {
        Some(sid) => {
            agent_executor::intel_gear::market::search_source_page(sid, &query, page_u32, page_size_u32).await
        }
        None => {
            agent_executor::intel_gear::market::search_market_page(
                &query,
                page_u32,
                page_size_u32,
                kind,
                q.refresh.unwrap_or(false),
            )
            .await
        }
    };

    // Surface upstream failures. `degraded` is true whenever at least one source
    // errored (even if other sources returned partial data, or when we fell back
    // to a cached page) — so the UI shows a clear "连接失败，显示缓存" banner with
    // the reason rather than an unexplained empty list / skeleton.
    let degraded = !errors.is_empty();
    let message = if degraded {
        errors.first().cloned()
    } else {
        None
    };

    // Compute which marketplace entries are already installed, so the market's
    // "installed" flag agrees with Settings → Smart Market and stays correct
    // within a session. The in-memory registry (`list_detailed`) is only populated
    // at startup via `load_all`; marketplace MCP imports write to disk via
    // `write_mcp_gear` but are NOT re-registered in memory, so a pure registry scan
    // would miss them until the next restart — which is exactly the "已安装 → 安装"
    // flicker after closing and reopening the market. We therefore merge the
    // filesystem gear dirs too (mirroring `GET /gears`), and normalize every name
    // to an alphanumeric-lowercase key so the different sanitization schemes
    // (market-skill `sanitize_name` vs MCP `replace('/','-')`) resolve to the same
    // gear.
    let mut installed_norm: std::collections::HashSet<String> = state
        .gear_host
        .list_detailed()
        .iter()
        .map(|g| norm_key(&g.name))
        .collect();
    if let Ok(dir) = gears_dir()
        && let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    // M7 (B5): staging dirs from interrupted installs are not
                    // installed gears — exclude them from the installed set.
                    if name.contains(".tmp-") || name.contains(".broken-") {
                        continue;
                    }
                    installed_norm.insert(norm_key(&name));
                }
            }
        }

    let gears: Vec<GearMarketEntry> = entries
        .into_iter()
        .map(|e| {
            let kind = match e.source_type {
                agent_executor::intel_gear::model::CapabilitySource::Native => "native",
                agent_executor::intel_gear::model::CapabilitySource::Skill => "skill",
                agent_executor::intel_gear::model::CapabilitySource::Plugin => "plugin",
                agent_executor::intel_gear::model::CapabilitySource::Mcp => "mcp",
                agent_executor::intel_gear::model::CapabilitySource::Builtin => "builtin",
            };
            GearMarketEntry {
                name: e.display_name,
                description: Some(e.description),
                version: Some(e.version),
                kind: kind.to_string(),
                files: e.files,
                tags: e.tags,
                author: e.author,
                homepage: e.homepage,
                license: e.license,
                activation: e.activation,
                installed: entry_installed(&e.spec, &installed_norm),
                spec: e.spec,
                download_url: e.download_url,
            }
        })
        .collect();

    Ok(Json(GearMarketIndex {
        gears,
        total,
        page,
        page_size,
        has_more,
        degraded,
        message,
    }))
}

/// GET /gears/registry-sources — list available registry sources (GitHub, Gitee, ...).
async fn registry_sources(
) -> Result<Json<Vec<agent_executor::intel_gear::market::RegistrySource>>> {
    Ok(Json(agent_executor::intel_gear::market::builtin_registry_sources()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallReq {
    #[serde(default)]
    name: String,
    /// Registry source id: "github" | "gitee". Used when installing by bare name
    /// from the gear registry. Defaults to "github".
    #[serde(default)]
    source: Option<String>,
    /// Absolute path to a local gear directory (folder).
    /// When set, install from disk via the unified directory-pack pipeline.
    #[serde(default)]
    path: Option<String>,
    /// User's auto-call choice at install time: `command` | `auto` | `global` | `progressive`.
    /// Overrides the manifest's declared activation.
    #[serde(default)]
    activation: Option<String>,
    /// Marketplace install pipeline: the skill's `source_url`, supplied by the
    /// UI from the market entry.
    #[serde(default)]
    download_url: Option<String>,
    /// Marketplace install pipeline: requested version (falls back to a default).
    #[serde(default)]
    version: Option<String>,
    /// Human-friendly title from the marketplace entry, so the installed gear
    /// shows the same name the user saw in the market.
    #[serde(default)]
    display_name: Option<String>,
}

/// Parse an activation string into the typed enum (defaults to `command` when absent).
fn parse_activation(s: &Option<String>) -> Option<agent_executor::intel_gear::manifest::ActivationMode> {
    use agent_executor::intel_gear::manifest::ActivationMode;
    s.as_deref().map(|v| match v.to_lowercase().as_str() {
        "auto" => ActivationMode::Auto,
        "global" => ActivationMode::Global,
        "progressive" => ActivationMode::Progressive,
        _ => ActivationMode::Command,
    })
}

/// POST /gears/install — install a gear via GearHost unified pipeline (01 §6.1).
/// Three modes:
///   1. local directory: `{ "path": "C:\\...\\my-gear", "activation": "command" }`
///   2. spec string:     `{ "name": "plugin:foo@1.0" | "mcp:bar" | "skill:./x.md" }`
///   3. registry name:   `{ "name": "bare-name", "source": "github" }` — download from git
async fn install(
    State(state): State<AppState>,
    Json(req): Json<InstallReq>,
) -> Result<Json<GearInfo>> {
    // Mode 1: install from a local directory (folder).
    if let Some(path) = req.path.as_deref().filter(|p| !p.trim().is_empty()) {
        let dir = PathBuf::from(path);
        if !dir.is_dir() {
            return Err(UnifiedError::BadRequest(format!(
                "path is not a directory: {path}"
            )));
        }
        let gear_id = state
            .gear_host
            .install_local_pack(&dir, parse_activation(&req.activation))
            .await
            .map_err(|e| UnifiedError::Internal(format!("local gear install: {e}")))?;
        let info = state
            .gear_host
            .get_info(&gear_id)
            .as_ref()
            .map(GearInfo::from_host)
            .unwrap_or_else(|| GearInfo {
                id: gear_id.0.clone(),
                name: gear_id.0.clone(),
                enabled: true,
                ..Default::default()
            });
        return Ok(Json(info));
    }

    let name = req.name.trim();
    if name.is_empty() {
        return Err(UnifiedError::BadRequest("gear name or path is required".into()));
    }

    // Marketplace components (ModelScope skills) are not expressible as a
    // local/remote/mcp spec, so route them through the dedicated download +
    // install pipeline.
    if name.starts_with("modelscope-skill:") {
        let gear_id = state
            .gear_host
            .install_market(name, req.download_url.clone(), req.version.clone(), req.display_name.clone())
            .await
            .map_err(|e| UnifiedError::Internal(format!("market gear install: {e}")))?;
        let info = state.gear_host.get_info(&gear_id);
        let info = info
            .as_ref()
            .map(GearInfo::from_host)
            .unwrap_or_else(|| GearInfo {
                id: gear_id.0.clone(),
                name: gear_id.0.clone(),
                enabled: true,
                ..Default::default()
            });
        return Ok(Json(info));
    }

    // Mode 2: unified pipeline (handles plugin:/mcp:/skill: prefixed specs)
    if name.contains(':') || name.starts_with('.') || name.starts_with('/') {
        let gear_id = state.gear_host.install(name).await
            .map_err(|e| UnifiedError::Internal(format!("gear install: {e}")))?;
        let info = state
            .gear_host
            .get_info(&gear_id)
            .as_ref()
            .map(GearInfo::from_host)
            .unwrap_or_else(|| GearInfo {
                id: gear_id.0.clone(),
                name: gear_id.0.clone(),
                enabled: true,
                ..Default::default()
            });
        return Ok(Json(info));
    }

    // Mode 3: install by bare name from a custom git-index registry source.
    // GitHub/Gitee builtins have been removed; only env-var-configured custom
    // URLs or explicit URL sources are supported here. MCP marketplace gears
    // (ModelScope / official registry) install via /gears/mcp/import instead.
    let source = agent_executor::intel_gear::market::resolve_source(req.source.as_deref())
        .ok_or_else(|| {
            UnifiedError::BadRequest(
                "no git-index registry source configured; MCP marketplace gears install via /gears/mcp/import".into(),
            )
        })?;
    let entries =
        agent_executor::intel_gear::market::search_source(Some(&source.id), name).await;
    let entry = entries
        .into_iter()
        .find(|e| e.display_name.eq_ignore_ascii_case(name))
        .ok_or_else(|| {
            UnifiedError::NotFound(format!(
                "gear '{name}' not found in registry source '{}'",
                source.id
            ))
        })?;

    let dir = gears_dir()?;
    // H3: `name` reaches `dir.join(name)` below — a registry-supplied name
    // with path separators / `..` segments would point the whole install at
    // an arbitrary directory outside the gears store. (`..`-leading names are
    // already routed to the unified pipeline by the starts_with('.') check
    // above; interior `..` segments are not.) Mirror the CLI discovery
    // pipeline's contract: reject separators, `..` segments and drive letters.
    if name.contains('\\')
        || name.contains('/')
        || name.split(['\\', '/']).any(|seg| seg == ".." || seg.contains(':'))
    {
        return Err(UnifiedError::BadRequest(format!(
            "invalid gear name {name:?}: path separators, '..' segments and drive letters are not allowed"
        )));
    }
    let gear_dir = dir.join(name);
    if gear_dir.exists() {
        return Err(UnifiedError::BadRequest(format!(
            "gear '{name}' already installed"
        )));
    }
    fs::create_dir_all(&gear_dir)
        .map_err(|e| UnifiedError::Internal(format!("create gear dir: {e}")))?;

    // Shared EXTERNAL client: connect 10s + overall 60s, honors the process
    // proxy environment. A bare `Client::new()` here had NO timeouts — one
    // black-holed registry mirror stalled the install route forever.
    let client = crate::duoduo_sync::external_http_client().clone();
    for rel in &entry.files {
        // H3: same contract for registry-supplied file paths — `..` segments,
        // absolute paths and drive letters must never escape `gear_dir`
        // (mirrors the CLI discovery pipeline / discovery.ts isSafeRelPath).
        // The joined-path prefix check below is the belt-and-suspenders
        // backstop: `Path::starts_with` compares components, so a `..`
        // component cannot pass it even if the segment scan were bypassed.
        let normalized = rel.replace('\\', "/");
        if normalized.is_empty()
            || normalized.starts_with('/')
            || normalized.split('/').any(|seg| seg == ".." || seg.contains(':'))
        {
            return Err(UnifiedError::BadRequest(format!(
                "gear file path {rel:?} would escape the gear directory; refusing install"
            )));
        }
        let file_url = format!(
            "{}/gears/{}/{}",
            source.files_base.trim_end_matches('/'),
            name,
            rel.trim_start_matches('/')
        );
        let resp = client
            .get(&file_url)
            .send()
            .await
            .map_err(|e| UnifiedError::Internal(format!("fetch {rel}: {e}")))?;
        if !resp.status().is_success() {
            return Err(UnifiedError::Internal(format!(
                "fetch {rel} returned status {}",
                resp.status()
            )));
        }
        let body = resp
            .text()
            .await
            .map_err(|e| UnifiedError::Internal(format!("read {rel}: {e}")))?;
        let dest = gear_dir.join(rel);
        if !dest.starts_with(&gear_dir) {
            return Err(UnifiedError::BadRequest(format!(
                "gear file path {rel:?} would escape the gear directory; refusing install"
            )));
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| UnifiedError::Internal(format!("create dir for {rel}: {e}")))?;
        }
        fs::write(&dest, body)
            .map_err(|e| UnifiedError::Internal(format!("write {rel}: {e}")))?;
    }

    // Delegate to the unified install pipeline via install_local_pack
    let activation = parse_activation(&req.activation);
    let gear_id = state
        .gear_host
        .install_local_pack(&gear_dir, activation)
        .await
        .map_err(|e| UnifiedError::Internal(format!("gear install from registry: {e}")))?;

    let info = state
        .gear_host
        .get_info(&gear_id)
        .as_ref()
        .map(GearInfo::from_host)
        .unwrap_or_else(|| GearInfo {
            id: gear_id.0.clone(),
            name: gear_id.0.clone(),
            enabled: true,
            ..Default::default()
        });
    Ok(Json(info))
}

// ── Activation & enable/disable ──

/// POST /gears/:name/activate — trigger a `command` gear for the current session
/// (the `/<name>` handler). Injects its instructions; no-op for auto/global gears.
async fn activate(
    State(state): State<AppState>,
    AxumPath(name): AxumPath<String>,
) -> Result<Json<serde_json::Value>> {
    state
        .gear_host
        .activate_command_by_name(&name)
        .map_err(|e| UnifiedError::NotFound(format!("activate gear: {e}")))?;
    Ok(Json(serde_json::json!({ "activated": name })))
}

#[derive(Debug, Deserialize)]
struct SetActivationReq {
    /// New activation policy: `command` | `auto` | `global` | `progressive`.
    activation: String,
}

/// PATCH /gears/:name/activation — change a gear's auto-call policy (the UI toggle).
async fn set_activation(
    State(state): State<AppState>,
    AxumPath(name): AxumPath<String>,
    Json(req): Json<SetActivationReq>,
) -> Result<Json<serde_json::Value>> {
    let mode = parse_activation(&Some(req.activation.clone()))
        .ok_or_else(|| UnifiedError::BadRequest("invalid activation".into()))?;
    state
        .gear_host
        .set_activation_by_name(&name, mode)
        .map_err(|e| UnifiedError::NotFound(format!("set activation: {e}")))?;
    Ok(Json(serde_json::json!({ "name": name, "activation": req.activation })))
}

/// POST /gears/:name/enable — enable an installed gear (persisted; honored by
/// the runtime prompt loader and MCP tool exposure).
async fn enable_gear(
    State(state): State<AppState>,
    AxumPath(name): AxumPath<String>,
) -> Result<Json<serde_json::Value>> {
    state
        .gear_host
        .set_enabled_by_name(&name, true)
        .map_err(|e| UnifiedError::NotFound(format!("enable gear: {e}")))?;
    Ok(Json(serde_json::json!({ "enabled": name })))
}

/// POST /gears/:name/disable — disable an installed gear (persisted; honored by
/// the runtime prompt loader and MCP tool exposure).
async fn disable_gear(
    State(state): State<AppState>,
    AxumPath(name): AxumPath<String>,
) -> Result<Json<serde_json::Value>> {
    state
        .gear_host
        .set_enabled_by_name(&name, false)
        .map_err(|e| UnifiedError::NotFound(format!("disable gear: {e}")))?;
    Ok(Json(serde_json::json!({ "disabled": name })))
}

// ── MCP server bridging (covers the legacy "add MCP server" entry) ──

#[derive(Debug, Deserialize)]
struct AddMcpReq {
    /// Gear name to host this MCP server (also the connection alias).
    name: String,
    /// "stdio" (command launched locally) or "sse" (remote URL).
    #[serde(default = "default_kind")]
    kind: String,
    #[serde(default)]
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    url: String,
    /// Environment variables injected into a stdio child process (e.g. API keys).
    /// Required for `npx`/`uvx` servers that read secrets from the environment.
    #[serde(default)]
    env: HashMap<String, String>,
    #[serde(default)]
    description: String,
}

fn default_kind() -> String {
    "stdio".to_string()
}

/// POST /gears/mcp — persist an external MCP server as a gear (manifest + tools/mcp.json).
async fn add_mcp(
    State(_state): State<AppState>,
    Json(req): Json<AddMcpReq>,
) -> Result<Json<GearInfo>> {
    let name = req.name.trim();
    if name.is_empty() {
        return Err(UnifiedError::BadRequest("gear name is required".into()));
    }
    if req.kind != "stdio" && req.kind != "sse" {
        return Err(UnifiedError::BadRequest(
            "kind must be 'stdio' or 'sse'".into(),
        ));
    }
    if req.kind == "stdio" && req.command.trim().is_empty() {
        return Err(UnifiedError::BadRequest(
            "stdio MCP requires a command".into(),
        ));
    }
    if req.kind == "sse" && req.url.trim().is_empty() {
        return Err(UnifiedError::BadRequest("sse MCP requires a url".into()));
    }

    let info = write_mcp_gear(McpGearSpec {
        name,
        kind: &req.kind,
        command: &req.command,
        args: &req.args,
        url: &req.url,
        env: &req.env,
        description: &req.description,
        author: "user",
        display_name: None,
        spec: None,
    })?;
    Ok(Json(info))
}

/// Shared persistence for both [`add_mcp`] and [`import_modelscope`]: write
/// `manifest.toml` + `tools/mcp.json` for an external MCP server under a gear
/// directory. `ensure_gear_mcp` connects it on the next agent run.
/// Everything needed to materialise one MCP gear on disk.
///
/// Grouped so the write path takes a single argument; the fields are named, so
/// a caller can no longer transpose two adjacent `&str` parameters by accident.
struct McpGearSpec<'a> {
    name: &'a str,
    kind: &'a str,
    command: &'a str,
    args: &'a [String],
    url: &'a str,
    env: &'a HashMap<String, String>,
    description: &'a str,
    author: &'a str,
    display_name: Option<String>,
    spec: Option<String>,
}

fn write_mcp_gear(
    McpGearSpec {
        name,
        kind,
        command,
        args,
        url,
        env,
        description,
        author,
        display_name,
        spec,
    }: McpGearSpec<'_>,
) -> Result<GearInfo> {
    if !is_valid_name(name) {
        return Err(UnifiedError::BadRequest("invalid gear name".into()));
    }
    let dir = gears_dir()?;
    let gear_dir = dir.join(name);
    // Idempotent: re-importing (e.g. from the market) overwrites the previous
    // install instead of erroring, so an already-installed gear can pick up an
    // updated `display_name` / config. Mirrors the marketplace skill path.
    if gear_dir.exists() {
        let _ = std::fs::remove_dir_all(&gear_dir);
    }
    fs::create_dir_all(gear_dir.join("tools"))
        .map_err(|e| UnifiedError::Internal(format!("create gear dir: {e}")))?;

    // Persist the marketplace's human title so the installed gear shows the same
    // name the user saw in the market (the `name` field stays the stable,
    // filesystem-safe slug used for identity / delete / idempotency).
    let friendly = display_name
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.replace('"', "'"));

    let manifest = GearManifestToml {
        meta: GearMetaToml {
            name: name.to_string(),
            kind: "mcp".to_string(),
            version: Some("1.0.0".into()),
            description: Some(description.trim().to_string()),
            author: Some(author.to_string()),
            display_name: friendly,
            spec: spec.filter(|s| !s.trim().is_empty()).map(|s| s.replace('"', "'")),
        },
        capabilities: GearCapabilities {
            tools: vec!["mcp".to_string()],
            ..Default::default()
        },
    };
    let toml_str = toml::to_string_pretty(&manifest)
        .map_err(|e| UnifiedError::Internal(format!("serialize manifest: {e}")))?;
    fs::write(gear_dir.join("manifest.toml"), toml_str)
        .map_err(|e| UnifiedError::Internal(format!("write manifest: {e}")))?;

    let mcp_json = serde_json::json!({
        "name": name,
        "kind": kind,
        "command": command,
        "args": args,
        "url": url,
        "env": env,
    });
    fs::write(
        gear_dir.join("tools").join("mcp.json"),
        serde_json::to_string_pretty(&mcp_json)
            .map_err(|e| UnifiedError::Internal(format!("serialize mcp.json: {e}")))?,
    )
    .map_err(|e| UnifiedError::Internal(format!("write mcp.json: {e}")))?;

    // Connect the freshly installed MCP server in the background so its tools
    // are available on the next agent run without blocking that run (a dead
    // server fails fast in the background and is cooled down).
    agent_executor::mcp::ensure_gear_mcp();

    Ok(GearInfo::from_dir(&gear_dir, name))
}

// ── MCP marketplace import (ModelScope + official registry) ──

/// Which marketplace an import request refers to.
#[derive(Debug, Deserialize)]
struct ImportMcpReq {
    /// Marketplace id: `modelscope` | `mcp-registry` (official).
    #[serde(default = "default_mcp_source")]
    source: String,
    /// Marketplace server id (ModelScope `id`, or official registry `name`).
    server_id: String,
    /// Official-registry version to install (omitted → latest). Ignored by
    /// ModelScope (its detail endpoint returns a single config).
    #[serde(default)]
    version: String,
    /// Optional marketplace token (ModelScope `ms-xxxx`, bearer).
    #[serde(default)]
    token: String,
    /// Optional gear name; defaults to the server id sanitized to a valid name.
    #[serde(default)]
    name: String,
    /// Human-friendly title from the marketplace entry, so the installed gear
    /// shows the same name the user saw in the market.
    #[serde(default)]
    display_name: Option<String>,
    /// User-supplied secret env values that override the placeholders declared
    /// by the server (e.g. `GITHUB_PERSONAL_ACCESS_TOKEN`). Without these the
    /// stdio process would receive literal placeholders like `<YOUR_TOKEN>`.
    #[serde(default)]
    env: HashMap<String, String>,
}

fn default_mcp_source() -> String {
    "modelscope".into()
}

#[derive(Debug, Deserialize)]
struct McpConfigQuery {
    #[serde(default = "default_mcp_source")]
    source: String,
    server_id: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    token: String,
    /// Skip the in-memory cache and re-fetch the upstream marketplace. Used by
    /// the UI's "re-validate config" action so a user can force a fresh
    /// compliance check before installing.
    #[serde(default)]
    refresh: bool,
}

/// GET /gears/mcp/config — preview an MCP server's connection config (kind,
/// command/args/url, required env secrets, license, publisher, source url)
/// **without** persisting anything. The UI renders the compliance/confirmation
/// dialog from this payload before calling [`import_mcp`].
async fn mcp_config(
    State(_state): State<AppState>,
    Query(q): Query<McpConfigQuery>,
) -> Result<Json<agent_executor::intel_gear::market::McpServerConfig>> {
    let source = q.source.trim();
    let server_id = q.server_id.trim();
    if server_id.is_empty() {
        return Err(UnifiedError::BadRequest("server_id is required".into()));
    }
    let token = if q.token.trim().is_empty() {
        None
    } else {
        Some(q.token.trim())
    };
    let cache_key = mcp_config_cache_key(source, server_id, q.version.trim(), token.unwrap_or(""));
    // Poisoning recovery: a panicking request must not leave the cache
    // permanently unreadable for every subsequent gear request.
    if !q.refresh {
        let cache = duo_utils::sync::lock(mcp_config_cache());
        if let Some(entry) = cache.get(&cache_key)
            && entry.at.elapsed() < MCP_CONFIG_TTL
        {
            return Ok(Json(entry.cfg.clone()));
        }
    }
    let cfg = fetch_mcp_config(source, server_id, q.version.trim(), token).await?;
    let cfg = cfg.ok_or_else(|| {
        UnifiedError::NotFound(format!("mcp server '{server_id}' not found in '{source}'"))
    })?;
    mcp_config_cache()
        .lock_recover()
        .insert(cache_key, McpConfigCacheEntry { at: Instant::now(), cfg: cfg.clone() });
    Ok(Json(cfg))
}

/// Resolve an [`McpServerConfig`] from the requested marketplace.
async fn fetch_mcp_config(
    source: &str,
    server_id: &str,
    version: &str,
    token: Option<&str>,
) -> Result<Option<agent_executor::intel_gear::market::McpServerConfig>> {
    match source.eq_ignore_ascii_case("mcp-registry") {
        true => agent_executor::intel_gear::market::fetch_official_server_config(
            server_id,
            if version.is_empty() { None } else { Some(version) },
            token,
        )
        .await
        .map_err(|e| UnifiedError::Internal(format!("fetch official registry server: {e}"))),
        false => agent_executor::intel_gear::market::fetch_modelscope_server_config(
            server_id,
            token,
        )
        .await
        .map_err(|e| UnifiedError::Internal(format!("fetch modelscope server: {e}"))),
    }
}

/// POST /gears/mcp/import — import an MCP server from a marketplace as a gear.
///
/// Fetches the server's connection config from the marketplace, translates it
/// into our gear layout via [`write_mcp_gear`], and lets the next agent run
/// connect it. This is the "install from marketplace" path that complements
/// the `source=modelscope` / `source=mcp-registry` market searches.
async fn import_mcp(
    State(_state): State<AppState>,
    Json(req): Json<ImportMcpReq>,
) -> Result<Json<GearInfo>> {
    let source = req.source.trim();
    let server_id = req.server_id.trim();
    if server_id.is_empty() {
        return Err(UnifiedError::BadRequest("server_id is required".into()));
    }

    let cfg = fetch_mcp_config(
        source,
        server_id,
        req.version.trim(),
        if req.token.trim().is_empty() {
            None
        } else {
            Some(req.token.trim())
        },
    )
    .await?
    .ok_or_else(|| {
        UnifiedError::NotFound(format!("mcp server '{server_id}' not found in '{source}'"))
    })?;

    // Derive a valid gear name when the caller didn't supply one.
    let name = if req.name.trim().is_empty() {
        server_id
            .trim_start_matches('@')
            .replace(['/', ' ', '.'], "-")
    } else {
        req.name.trim().to_string()
    };

    if cfg.kind == "stdio" {
        if cfg.command.as_deref().unwrap_or("").is_empty() {
            return Err(UnifiedError::BadRequest(
                "mcp server has no command (stdio)".into(),
            ));
        }
    } else if cfg.kind == "sse" {
        if cfg.url.as_deref().unwrap_or("").is_empty() {
            return Err(UnifiedError::BadRequest("mcp server has no url (sse)".into()));
        }
    } else {
        return Err(UnifiedError::BadRequest(format!(
            "unknown mcp transport: {}",
            cfg.kind
        )));
    }

    // Merge env: server-declared placeholders overridden by user-supplied secrets.
    let mut env = cfg.env.clone();
    for (k, v) in &req.env {
        env.insert(k.clone(), v.clone());
    }

    let info = write_mcp_gear(McpGearSpec {
        name: &name,
        kind: &cfg.kind,
        command: cfg.command.as_deref().unwrap_or(""),
        args: &cfg.args,
        url: cfg.url.as_deref().unwrap_or(""),
        env: &env,
        description: cfg.description.as_deref().unwrap_or(""),
        author: source,
        display_name: req.display_name.clone(),
        spec: Some(format!("{source}:{server_id}")),
    })?;

    // Mirror `add_mcp`: connect the freshly imported MCP server in the background
    // so its tools are available on the next agent run without blocking this
    // request. Without this, a marketplace import would only connect after a
    // full restart — inconsistent with manual `add_mcp` and breaking the
    // "import == installed" expectation in the frontend market.
    agent_executor::mcp::ensure_gear_mcp();

    Ok(Json(info))
}
