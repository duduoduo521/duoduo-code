//! MarketAggregator: unified marketplace over two upstream sources —
//! ModelScope MCP plaza (mcp) and ModelScope Skills Central (skill).
//! Results are merged into a single list with a
//! per-entry `kind` tag, cached in-memory per page with a TTL (see
//! [`search_market_page`] / [`search_source_page`]).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::model::CapabilitySource;

/// Shared HTTP client with bounded timeouts. Upstream sources (ModelScope,
/// npm, the official MCP registry) can be slow or unreachable; without a
/// timeout `http_client()` blocks the `/gears/market` (and
/// `/gears/mcp/config`) handlers indefinitely, which the UI surfaces as a
/// permanently stuck loading/skeleton state.
///
/// The timeout is deliberately **8s — under the frontend's 10s `AbortSignal`
/// window** so the backend fails *first* and can return a clear
/// `degraded`/error payload (instead of the client aborting at 10s with a
/// generic timeout that the UI can't explain). A 4s connect timeout fails
/// fast when the host is unreachable (e.g. behind a firewall/proxy the
/// sidecar can't use).
///
/// Proxy: reqwest's default features include `macos-system-configuration`
/// (macOS) and env-proxy (`HTTPS_PROXY`/`HTTP_PROXY`), so this client honors
/// the OS / shell proxy automatically — no explicit config needed.
fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(8))
        .build()
        .expect("failed to build HTTP client")
}

/// A unified market entry (01 §7.2).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketEntry {
    pub display_name: String,
    pub source_type: CapabilitySource,
    pub spec: String,
    pub version: String,
    pub description: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub publisher: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub installed: bool,
    /// SPDX license id (for redistribution checks).
    #[serde(default)]
    pub license: Option<String>,
    /// Default activation policy: `command` | `auto` | `global`.
    #[serde(default)]
    pub activation: Option<String>,
    /// Relative file paths (from the gear dir) needed to install this gear,
    /// taken verbatim from the registry's `index.json`. Used by the
    /// on-demand file download (see `routes/gear.rs` install).
    #[serde(default)]
    pub files: Vec<String>,
    /// Direct download URL used by the marketplace install pipeline:
    /// the skill's source repo URL (ModelScope). `None` ⇒ this entry cannot be auto-installed.
    #[serde(default)]
    pub download_url: Option<String>,
}

/// Market source trait (one per upstream registry).
#[allow(async_fn_in_trait)]
pub trait MarketSource: Send + Sync {
    fn source_type(&self) -> CapabilitySource;
    /// Fetch ONE page (`page`, 1-based; `page_size` entries) of results for
    /// `query`. Paginating upstreams (ModelScope MCP / Skills) must request
    /// only that page — never the whole catalog — so a single market request
    /// stays bounded (~1 upstream call) regardless of catalog size. This is
    /// what keeps `/gears/market` responsive instead of hanging on a large
    /// catalog. Non-paginating sources (local git index, npm, the official MCP
    /// registry) ignore the page args and return their full set in one call.
    fn search(
        &self,
        query: &str,
        page: u32,
        page_size: u32,
    ) -> impl std::future::Future<Output = Result<Vec<MarketEntry>>> + Send;
}

/// Aggregates multiple market sources into one view.
pub struct MarketAggregator {
    sources: Vec<Box<dyn MarketSourceDyn>>,
}

/// Object-safe wrapper.
pub trait MarketSourceDyn: Send + Sync {
    fn source_type(&self) -> CapabilitySource;
    fn search<'a>(
        &'a self,
        query: &'a str,
        page: u32,
        page_size: u32,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<MarketEntry>>> + Send + 'a>>;
}

impl<T: MarketSource> MarketSourceDyn for T {
    fn source_type(&self) -> CapabilitySource { MarketSource::source_type(self) }
    fn search<'a>(
        &'a self,
        query: &'a str,
        page: u32,
        page_size: u32,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<MarketEntry>>> + Send + 'a>> {
        Box::pin(MarketSource::search(self, query, page, page_size))
    }
}

/// Token-based fuzzy matcher used by sources that can only filter locally
/// (no upstream search support). The query is split on whitespace and every
/// token must appear (case-insensitive substring) in at least one haystack.
/// This is deliberately looser than matching the whole query string at once,
/// so "alipay payment" matches an entry named "Alipay MCP" described as
/// "payment integration".
fn fuzzy_match(query: &str, haystacks: &[&str]) -> bool {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return true;
    }
    let lowered: Vec<String> = haystacks.iter().map(|h| h.to_lowercase()).collect();
    q.split_whitespace()
        .all(|token| lowered.iter().any(|h| h.contains(token)))
}

impl MarketAggregator {
    pub fn new() -> Self {
        Self { sources: Vec::new() }
    }

    /// Build an aggregator from an explicit list of sources — used to scope the
    /// search by kind (e.g. only the MCP source when the UI filters on MCP).
    pub fn with_sources(sources: Vec<Box<dyn MarketSourceDyn>>) -> Self {
        Self { sources }
    }

    pub fn add_source(&mut self, source: Box<dyn MarketSourceDyn>) {
        self.sources.push(source);
    }

    /// Fetch every source's first page and merge (used by legacy single-source
    /// install lookups). Each source is queried once; paginating sources return
    /// only their first `page_size` entries. Source errors are ignored here
    /// (the install-by-name path only needs a matching entry, not diagnostics).
    pub async fn search(&self, query: &str) -> Vec<MarketEntry> {
        self.search_paged(query, 1, 200).await.0
    }

    /// Fetch the requested `page` from every source concurrently, merge, dedup
    /// and sort. Returns the combined entries, a `has_more` flag (true when any
    /// source returned a full page, so the UI can keep paging), and a list of
    /// per-source error messages. Errors are *surfaced* (not swallowed) so the
    /// route can tell the UI **why** a page came back empty — e.g. an
    /// unreachable upstream that would otherwise look like "no results".
    pub async fn search_paged(
        &self,
        query: &str,
        page: u32,
        page_size: u32,
    ) -> (Vec<MarketEntry>, bool, Vec<String>) {
        let results = futures::future::join_all(
            self.sources.iter().map(|source| source.search(query, page, page_size)),
        )
        .await;
        let mut all = Vec::new();
        let mut any_full = false;
        let mut errors = Vec::new();
        for (source, result) in self.sources.iter().zip(results) {
            match result {
                Ok(entries) => {
                    if entries.len() >= page_size as usize {
                        any_full = true;
                    }
                    all.extend(entries);
                }
                Err(e) => {
                    let msg = format!("{:?}: {}", source.source_type(), e);
                    tracing::warn!(source = ?source.source_type(), error = %e, "market source search failed");
                    errors.push(msg);
                }
            }
        }
        // Dedup by (source_type, spec without version)
        let mut seen = std::collections::HashSet::new();
        all.retain(|e| {
            let key = format!("{:?}:{}", e.source_type, e.spec.split('@').next().unwrap_or(&e.spec));
            seen.insert(key)
        });
        // Sort: installed sink, then name
        all.sort_by(|a, b| a.installed.cmp(&b.installed).then(a.display_name.cmp(&b.display_name)));
        (all, any_full, errors)
    }

    /// Build the default aggregator: ModelScope MCP plaza (mcp) and ModelScope
    /// Skills Central (skill). The official MCP registry
    /// source ([`McpRegistrySource`]) is intentionally NOT included — MCP
    /// entries come from ModelScope only (product decision); the struct is
    /// kept for the import/config path of already-installed gears.
    pub fn default_aggregator() -> Self {
        let mut agg = Self::new();
        agg.add_source(Box::new(ModelScopeSource));
        agg.add_source(Box::new(ModelScopeSkillSource));
        agg
    }
}

// ── Per-page market cache ──

/// How long a fetched market page stays fresh. Within the TTL the UI can scroll
/// and reopen the marketplace without re-hitting the upstream APIs; a manual
/// refresh (`refresh=true` on the route) bypasses it. A long TTL is safe because
/// the UI exposes a manual refresh button.
const MARKET_CACHE_TTL: Duration = Duration::from_secs(60 * 60); // 1 hour

/// One cached market page.
struct MarketCacheEntry {
    at: Instant,
    entries: Vec<MarketEntry>,
    has_more: bool,
    total_est: usize,
}

fn market_cache() -> &'static Mutex<HashMap<String, MarketCacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, MarketCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Fetch one page of the unified marketplace (ModelScope MCP + ModelScope
/// Skills) with an in-memory TTL cache keyed by `(query, kind, page, page_size)`.
/// Only the requested page is fetched from upstream — never the whole catalog —
/// so the request stays bounded even when the catalog is large. Returns the
/// entries, a `has_more` flag for infinite scroll, an estimated `total`, and a
/// list of per-source error messages (empty when every source succeeded).
pub async fn search_market_page(
    query: &str,
    page: u32,
    page_size: u32,
    kind_filter: Option<&str>,
    force_refresh: bool,
) -> (Vec<MarketEntry>, bool, usize, Vec<String>) {
    let kind = kind_filter.map(|k| k.trim().to_lowercase());
    let want_mcp = !matches!(kind.as_deref(), Some("skill"));
    let want_skill = !matches!(kind.as_deref(), Some("mcp"));

    let mut sources: Vec<Box<dyn MarketSourceDyn>> = Vec::new();
    if want_mcp {
        sources.push(Box::new(ModelScopeSource));
    }
    if want_skill {
        sources.push(Box::new(ModelScopeSkillSource));
    }
    let agg = MarketAggregator::with_sources(sources);

    let key = format!("{}|{:?}|{}|{}", query.trim().to_lowercase(), kind, page, page_size);
    if !force_refresh
        && let Ok(cache) = market_cache().lock()
            && let Some(entry) = cache.get(&key)
                && entry.at.elapsed() < MARKET_CACHE_TTL {
                    // Cache hit ⇒ the page was fully loaded before; NEVER replay
                    // stale per-source errors here (a previously cached error
                    // banner would otherwise haunt every reopen for the whole
                    // TTL even though the data is complete and fresh enough).
                    return (
                        entry.entries.clone(),
                        entry.has_more,
                        entry.total_est,
                        Vec::new(),
                    );
                }
    let (entries, has_more, errors) = agg.search_paged(query, page, page_size).await;
    let total_est = (page - 1) as usize * page_size as usize
        + entries.len()
        + if has_more { page_size as usize } else { 0 };
    if !errors.is_empty() {
        // Partial or full upstream failure for this page: do NOT cache it (so
        // the next open retries instead of freezing an incomplete page for the
        // whole TTL). If a previously cached (fully successful) page exists for
        // the same key, serve it silently — the user already has complete data,
        // there is nothing actionable to report.
        if let Ok(cache) = market_cache().lock()
            && let Some(entry) = cache.get(&key) {
                return (
                    entry.entries.clone(),
                    entry.has_more,
                    entry.total_est,
                    Vec::new(),
                );
            }
        return (entries, has_more, total_est, errors);
    }
    // Only fully-successful pages enter the cache.
    if let Ok(mut cache) = market_cache().lock() {
        cache.insert(
            key,
            MarketCacheEntry {
                at: Instant::now(),
                entries: entries.clone(),
                has_more,
                total_est,
            },
        );
    }
    (entries, has_more, total_est, errors)
}

impl Default for MarketAggregator {
    fn default() -> Self {
        Self::new()
    }
}

// ── Registry Sources (pluggable upstream git repos) ──

/// A pluggable upstream registry: the git repo *is* the marketplace
/// (Zed-style). `index_url` points at the repo's `index.json`; `files_base`
/// is the raw/branch root used to fetch a gear's individual files.
///
/// Adding a new marketplace (e.g. a future internal mirror) is just another
/// entry in [`builtin_registry_sources`]; the UI lists them dynamically.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistrySource {
    pub id: String,
    pub label: String,
    pub index_url: String,
    pub files_base: String,
}

/// Built-in git-index marketplace sources. GitHub/Gitee have been removed in
/// favour of the API-based ModelScope and official MCP registries. A custom
/// git-index URL can still be supplied via `DUODUO_GEAR_REGISTRY_URL` /
/// `GEAR_INDEX_URL` (with `DUODUO_GEAR_FILES_BASE` for the raw-file root).
pub fn builtin_registry_sources() -> Vec<RegistrySource> {
    let mut sources: Vec<RegistrySource> = Vec::new();
    let index_url = std::env::var("DUODUO_GEAR_REGISTRY_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| std::env::var("GEAR_INDEX_URL").ok().filter(|v| !v.trim().is_empty()));
    if let Some(url) = index_url {
        let files_base = std::env::var("DUODUO_GEAR_FILES_BASE")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| {
                url.rfind('/').map(|i| url[..i].to_string()).unwrap_or_else(|| url.clone())
            });
        sources.push(RegistrySource {
            id: "custom".into(),
            label: "Custom".into(),
            index_url: url,
            files_base,
        });
    }
    sources
}

/// Resolve a `source` selector into a concrete [`RegistrySource`] (git-index).
/// - A known builtin id (case-insensitive) → that source.
/// - A string containing `://` → treated as a custom index URL; `files_base`
///   is derived by stripping the last path segment.
/// - `None` / unknown → first builtin (if any), otherwise a dummy that will
///   yield no results.
pub fn resolve_source(id: Option<&str>) -> Option<RegistrySource> {
    let id = id.unwrap_or("").trim();
    if !id.is_empty() {
        if let Some(s) = builtin_registry_sources()
            .into_iter()
            .find(|s| s.id.eq_ignore_ascii_case(id))
        {
            return Some(s);
        }
        if id.contains("://") {
            let files_base = match id.rfind('/') {
                Some(i) => id[..i].to_string(),
                None => id.to_string(),
            };
            return Some(RegistrySource {
                id: id.to_string(),
                label: id.to_string(),
                index_url: id.to_string(),
                files_base,
            });
        }
    }
    builtin_registry_sources().into_iter().next()
}

// ── Gear Index Source ──

/// Gear index.json source (native/skill/instruction/plugin/mcp).
pub struct GearIndexSource {
    urls: Vec<String>,
    #[allow(dead_code)]
    files_base: String,
    #[allow(dead_code)]
    source_id: String,
}

impl GearIndexSource {
    /// Build a source pointed at a specific registry (custom URL).
    pub fn with_source(src: RegistrySource) -> Self {
        Self {
            urls: vec![src.index_url],
            files_base: src.files_base,
            source_id: src.id,
        }
    }
}

/// Search a single chosen registry source. Used by the market route so the UI
/// can switch between ModelScope / official MCP registry / a custom URL at
/// runtime. Defaults to ModelScope when no source is specified.
pub async fn search_source(source_id: Option<&str>, query: &str) -> Vec<MarketEntry> {
    let sid = source_id.unwrap_or("").trim();
    // Default to ModelScope when no source is specified. Each source is queried
    // once (first page); `page_size` is large so git-index / registry sources
    // return their full set in a single call.
    if sid.is_empty() || sid.eq_ignore_ascii_case("modelscope") {
        return MarketSource::search(&ModelScopeSource, query, 1, 200)
            .await
            .unwrap_or_else(|e| {
                tracing::warn!(error = %e, "modelscope source search failed");
                Vec::new()
            });
    }
    if sid.eq_ignore_ascii_case("mcp-registry") {
        return MarketSource::search(&McpRegistrySource, query, 1, 200)
            .await
            .unwrap_or_else(|e| {
                tracing::warn!(error = %e, "mcp-registry source search failed");
                Vec::new()
            });
    }
    // Custom git-index URL (env-var configured or explicit URL).
    if let Some(src) = resolve_source(Some(sid)) {
        return MarketSource::search(&GearIndexSource::with_source(src), query, 1, 200)
            .await
            .unwrap_or_else(|e| {
                tracing::warn!(error = %e, "gear-index source search failed");
                Vec::new()
            });
    }
    // Unknown source id → fall back to ModelScope.
    MarketSource::search(&ModelScopeSource, query, 1, 200)
        .await
        .unwrap_or_else(|e| {
            tracing::warn!(error = %e, "modelscope fallback search failed");
            Vec::new()
        })
}

/// Single-page variant of [`search_source`] for the `/gears/market` route's
/// legacy single-source mode. Returns the entries, a `has_more` flag, an
/// estimated `total`, and per-source errors — same contract as
/// [`search_market_page`].
pub async fn search_source_page(
    source_id: &str,
    query: &str,
    page: u32,
    page_size: u32,
) -> (Vec<MarketEntry>, bool, usize, Vec<String>) {
    let sid = source_id.trim();
    let source: Box<dyn MarketSourceDyn> = if sid.eq_ignore_ascii_case("mcp-registry") {
        Box::new(McpRegistrySource)
    } else if sid.eq_ignore_ascii_case("modelscope") || sid.is_empty() {
        Box::new(ModelScopeSource)
    } else if let Some(src) = resolve_source(Some(sid)) {
        Box::new(GearIndexSource::with_source(src))
    } else {
        // Unknown source id → fall back to ModelScope.
        Box::new(ModelScopeSource)
    };
    let agg = MarketAggregator::with_sources(vec![source]);
    let (entries, has_more, errors) = agg.search_paged(query, page, page_size).await;
    let total_est = (page - 1) as usize * page_size as usize
        + entries.len()
        + if has_more { page_size as usize } else { 0 };
    (entries, has_more, total_est, errors)
}

#[derive(Debug, Deserialize)]
struct GearIndexJson {
    #[serde(default)]
    entries: Vec<GearIndexEntry>,
}

#[derive(Debug, Deserialize)]
struct GearIndexEntry {
    name: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    spec: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    homepage: Option<String>,
    /// SPDX license id (for redistribution checks).
    #[serde(default)]
    license: Option<String>,
    /// Default activation policy: `command` | `auto` | `global`.
    #[serde(default)]
    activation: Option<String>,
    /// Relative file paths (from the gear dir) used to install this gear.
    #[serde(default)]
    files: Vec<String>,
}

impl MarketSource for GearIndexSource {
    fn source_type(&self) -> CapabilitySource { CapabilitySource::Native }

    async fn search(&self, query: &str, _page: u32, _page_size: u32) -> Result<Vec<MarketEntry>> {
        let client = http_client();
        let mut results = Vec::new();
        for url in &self.urls {
            let resp = client.get(url).send().await;
            let Ok(resp) = resp else { continue };
            if !resp.status().is_success() { continue; }
            let Ok(index) = resp.json::<GearIndexJson>().await else { continue };
            for entry in index.entries {
                let tag_join = entry.tags.join(" ");
                if fuzzy_match(query, &[&entry.name, &entry.description, &tag_join]) {
                    let source_type = match entry.kind.as_str() {
                        "skill" => CapabilitySource::Skill,
                        "plugin" => CapabilitySource::Plugin,
                        "mcp" => CapabilitySource::Mcp,
                        _ => CapabilitySource::Native,
                    };
                    results.push(MarketEntry {
                        display_name: entry.name.clone(),
                        source_type,
                        spec: if entry.spec.is_empty() { entry.name.clone() } else { entry.spec },
                        version: entry.version,
                        description: entry.description,
                        author: entry.author,
                        publisher: None,
                        tags: entry.tags,
                        homepage: entry.homepage,
                        installed: false,
                        license: entry.license.clone(),
                        activation: entry.activation.clone(),
                        files: entry.files.clone(),
                        download_url: None,
                    });
                }
            }
        }
        if results.is_empty() && self.urls.is_empty() {
            anyhow::bail!("NO_DEFAULT_GEAR_SOURCE");
        }
        Ok(results)
    }
}

// ── npm Source (plugin) ──

pub struct NpmSource;

#[derive(Debug, Deserialize)]
struct NpmSearchResult {
    #[serde(default)]
    objects: Vec<NpmObject>,
}

#[derive(Debug, Deserialize)]
struct NpmObject {
    package: NpmPackage,
}

#[derive(Debug, Deserialize)]
struct NpmPackage {
    name: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    publisher: Option<NpmPublisher>,
    #[serde(default)]
    links: Option<NpmLinks>,
}

#[derive(Debug, Deserialize)]
struct NpmPublisher {
    #[serde(default)]
    username: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NpmLinks {
    #[serde(default)]
    homepage: Option<String>,
}

impl MarketSource for NpmSource {
    fn source_type(&self) -> CapabilitySource { CapabilitySource::Plugin }

    async fn search(&self, query: &str, _page: u32, _page_size: u32) -> Result<Vec<MarketEntry>> {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }
        let url = format!(
            "https://registry.npmjs.org/-/v1/search?text={}&size=20",
            urlencoding(query)
        );
        let resp = http_client().get(&url).send().await?;
        if !resp.status().is_success() {
            return Ok(Vec::new());
        }
        let result = resp.json::<NpmSearchResult>().await?;
        Ok(result.objects.into_iter().map(|obj| {
            MarketEntry {
                display_name: obj.package.name.clone(),
                source_type: CapabilitySource::Plugin,
                spec: format!("plugin:{}@{}", obj.package.name, obj.package.version),
                version: obj.package.version,
                description: obj.package.description.unwrap_or_default(),
                author: None,
                publisher: obj.package.publisher.and_then(|p| p.username),
                tags: Vec::new(),
                homepage: obj.package.links.and_then(|l| l.homepage),
                installed: false,
                license: None,
                activation: None,
                files: vec![],
                download_url: None,
            }
        }).collect())
    }
}

fn urlencoding(s: &str) -> String {
    s.chars().map(|c| match c {
        ' ' => "+".to_string(),
        c if c.is_alphanumeric() || "-_.~".contains(c) => c.to_string(),
        c => format!("%{:02X}", c as u32),
    }).collect()
}

// ── Official MCP Registry Source (registry.modelcontextprotocol.io) ──

/// Base URL of the official MCP registry servers API. Overridable via the
/// `MCP_REGISTRY_URL` env var (e.g. a self-hosted mirror).
const MCP_REGISTRY_BASE: &str = "https://registry.modelcontextprotocol.io/v0/servers";

#[derive(Debug, Deserialize)]
struct OfficialListResp {
    #[serde(default)]
    servers: Vec<OfficialServerEntry>,
}

#[derive(Debug, Deserialize)]
struct OfficialServerEntry {
    server: OfficialServer,
}

#[derive(Debug, Deserialize)]
struct OfficialServer {
    #[serde(default)]
    name: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    repository: Option<String>,
    #[serde(default)]
    website_url: Option<String>,
}

/// Market source backed by the official MCP registry. Returns MCP entries with
/// `spec = "mcp-registry:<server-name>"`; the actual connection config (command
/// / args / env / url) comes from [`fetch_official_server_config`].
pub struct McpRegistrySource;

impl MarketSource for McpRegistrySource {
    fn source_type(&self) -> CapabilitySource {
        CapabilitySource::Mcp
    }

    async fn search(&self, query: &str, _page: u32, _page_size: u32) -> Result<Vec<MarketEntry>> {
        let base = std::env::var("MCP_REGISTRY_URL")
            .ok()
            .filter(|u| !u.trim().is_empty())
            .unwrap_or_else(|| MCP_REGISTRY_BASE.to_string());
        let url = format!("{}/?limit=200", base.trim_end_matches('/'));
        let resp = http_client().get(&url).send().await?;
        if !resp.status().is_success() {
            return Ok(Vec::new());
        }
        let parsed = match resp.json::<OfficialListResp>().await {
            Ok(p) => p,
            Err(_) => return Ok(Vec::new()),
        };
        // Dedup by server name, keeping the highest version (the registry lists
        // every version as a separate entry).
        let mut best: HashMap<String, OfficialServer> = HashMap::new();
        for e in parsed.servers {
            let s = e.server;
            if s.name.is_empty() {
                continue;
            }
            match best.get(&s.name) {
                Some(prev) if !version_gt(&s.version, &prev.version) => {}
                _ => {
                    best.insert(s.name.clone(), s);
                }
            }
        }
        Ok(best
            .into_values()
            .filter(|s| fuzzy_match(query, &[&s.name, &s.description, &s.title]))
            .map(|s| MarketEntry {
                display_name: if !s.title.is_empty() {
                    s.title.clone()
                } else {
                    s.name.clone()
                },
                source_type: CapabilitySource::Mcp,
                spec: format!("mcp-registry:{}", s.name),
                version: s.version,
                description: s.description,
                author: None,
                publisher: None,
                tags: Vec::new(),
                homepage: s.website_url.or(s.repository),
                installed: false,
                license: None,
                activation: None,
                files: vec![],
                download_url: None,
            })
            .collect())
    }
}

/// Lexicographic-numeric compare: returns true if `a > b` as a dotted version.
fn version_gt(a: &str, b: &str) -> bool {
    let pa = a.split('.').map(|x| x.parse::<u32>().unwrap_or(0));
    let pb = b.split('.').map(|x| x.parse::<u32>().unwrap_or(0));
    pa.gt(pb)
}

// ── ModelScope MCP marketplace source ──

/// Base URL of the ModelScope MCP OpenAPI (public, used for discovery).
const MODELSCOPE_MCP_API: &str = "https://www.modelscope.cn/openapi/v1/mcp/servers";

/// A single environment variable a server requires the caller to supply.
/// Surfaced to the UI so the install dialog can render labeled secret inputs
/// and a compliance warning (never hard-coded).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvVarSpec {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub required: bool,
}

/// Unified connection config for an MCP server pulled from any API marketplace
/// (ModelScope or the official `registry.modelcontextprotocol.io`). Translated
/// into a gear layout by `duo-smart-layer::routes::gear::write_mcp_gear`.
#[derive(Debug, Clone, Serialize)]
pub struct McpServerConfig {
    /// "stdio" (command launched locally) or "sse" (remote URL).
    pub kind: String,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub url: Option<String>,
    /// Raw env map from the source. For ModelScope these are placeholders like
    /// `<YOUR_TOKEN>`; for the official registry they are empty (the required
    /// shapes live in [`required_env`]). Always overridden by user-supplied
    /// secrets at import time.
    pub env: HashMap<String, String>,
    /// Explicit, human-readable env specs the UI must collect from the user
    /// (name + why + whether mandatory) before launching a stdio process.
    #[serde(default)]
    pub required_env: Vec<EnvVarSpec>,
    pub description: Option<String>,
    pub source_url: Option<String>,
    /// Long-form markdown introduction. ModelScope exposes a `readme` field;
    /// when both `description` and `readme` are empty we fall back to the npm
    /// package README (which carries the real product intro / usage scenarios).
    #[serde(default)]
    pub readme: Option<String>,
    /// Cover/logo image URL shown in the detail-view header.
    #[serde(default)]
    pub logo_url: Option<String>,
    /// Marketplace category ids (e.g. "finance").
    #[serde(default)]
    pub categories: Vec<String>,
    /// SPDX license id if the source exposes one (most MCP marketplaces don't).
    /// `None` ⇒ the UI must show "see upstream" and rely on the compliance
    /// confirmation rather than a license grant.
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub publisher: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ModelScopeListResp {
    #[serde(default)]
    data: ModelScopeListData,
}

#[derive(Debug, Default, Deserialize)]
struct ModelScopeListData {
    #[serde(default)]
    mcp_server_list: Vec<ModelScopeListEntry>,
}

#[derive(Debug, Deserialize)]
struct ModelScopeListEntry {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    chinese_name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    publisher: Option<String>,
    #[serde(default)]
    categories: Vec<String>,
}

/// Market source that queries the ModelScope MCP marketplace list OpenAPI.
///
/// The list endpoint (`PUT /openapi/v1/mcp/servers`) is public and needs no
/// token; it returns server metadata only. The actual connection config
/// (command/args/url/env) comes from [`fetch_modelscope_server_config`].
pub struct ModelScopeSource;

impl MarketSource for ModelScopeSource {
    fn source_type(&self) -> CapabilitySource {
        CapabilitySource::Mcp
    }

    async fn search(&self, query: &str, page: u32, page_size: u32) -> Result<Vec<MarketEntry>> {
        // Fetch ONLY the requested page. The `/gears/market` handler drives
        // paging, so we must not pull the whole catalog here — doing so made
        // the marketplace hang (and the UI stick on its skeleton) once the
        // catalog grew past a few hundred entries.
        let body = serde_json::json!({
            "page_number": page,
            "page_size": page_size,
            "search": query,
        });
        let resp = http_client()
            .put(MODELSCOPE_MCP_API)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            tracing::warn!(status, "modelscope mcp list returned non-success");
            // Surface as an error (not an empty list) so the UI can tell the
            // user the upstream was unreachable, instead of "no results".
            return Err(anyhow::anyhow!("ModelScope MCP 列表接口返回 HTTP {status}"));
        }
        let parsed = match resp.json::<ModelScopeListResp>().await {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(error = %e, "modelscope mcp list parse failed");
                return Err(anyhow::anyhow!("ModelScope MCP 列表解析失败: {e}"));
            }
        };
        // The query was already sent upstream via the `search` field, and the
        // upstream matcher is fuzzier than a literal substring check (it also
        // matches fields we don't mirror, e.g. `chinese_name`). Re-filtering
        // locally with a strict full-string `contains` silently dropped valid
        // fuzzy hits and made the marketplace search feel "exact-only", so we
        // trust the upstream result set as-is.
        Ok(parsed.data.mcp_server_list
            .into_iter()
            .map(|e| {
                let display_name = if !e.name.is_empty() {
                    e.name.clone()
                } else if !e.chinese_name.is_empty() {
                    e.chinese_name.clone()
                } else {
                    e.id.clone()
                };
                MarketEntry {
                display_name,
                source_type: CapabilitySource::Mcp,
                spec: format!("modelscope:{}", e.id),
                version: String::new(),
                description: e.description,
                author: e.publisher,
                publisher: None,
                tags: e.categories,
                homepage: None,
                installed: false,
                license: None,
                activation: None,
                files: vec![],
                download_url: None,
                }
            })
            .collect())
    }
}

/// Market source that queries the ModelScope Skills Central public OpenAPI
/// (`GET /openapi/v1/skills?search=...`). No token required. Each skill becomes
/// a `kind = skill` entry; installation is handled separately (the skill files
/// are fetched from `source_url`).
pub struct ModelScopeSkillSource;

/// Base URL of the ModelScope Skills Central public list API. Verified live:
/// supports `?search=<kw>&page_number=&page_size=`, no token required.
const MODELSCOPE_SKILLS_API: &str = "https://www.modelscope.cn/openapi/v1/skills";

#[derive(Debug, Deserialize)]
struct SkillListResp {
    #[serde(default)]
    data: SkillListData,
}

#[derive(Debug, Default, Deserialize)]
struct SkillListData {
    #[serde(default)]
    skills: Vec<SkillEntry>,
}

#[derive(Debug, Deserialize)]
struct SkillEntry {
    #[serde(default)]
    id: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    owner: Option<String>,
    #[serde(default)]
    developer: Option<String>,
    #[serde(default)]
    license: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    source_url: Option<String>,
}

impl MarketSource for ModelScopeSkillSource {
    fn source_type(&self) -> CapabilitySource {
        CapabilitySource::Skill
    }

    async fn search(&self, query: &str, page: u32, page_size: u32) -> Result<Vec<MarketEntry>> {
        // Fetch ONLY the requested page. Paging is driven by the `/gears/market`
        // handler, so we must not pull the whole catalog here (that made the
        // marketplace hang and the UI stick on its skeleton).
        let url = format!(
            "{}?page_number={}&page_size={}&search={}",
            MODELSCOPE_SKILLS_API,
            page,
            page_size,
            urlencoding(query)
        );
        let resp = http_client().get(&url).send().await?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            tracing::warn!(status, "modelscope skills list returned non-success");
            return Err(anyhow::anyhow!("ModelScope Skills 列表接口返回 HTTP {status}"));
        }
        let parsed = match resp.json::<SkillListResp>().await {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(error = %e, "modelscope skills list parse failed");
                return Err(anyhow::anyhow!("ModelScope Skills 列表解析失败: {e}"));
            }
        };
        // The query was already sent upstream via `?search=`; upstream matching
        // is fuzzy, so do NOT re-filter locally with a strict substring check
        // (it dropped valid fuzzy hits and made search feel exact-only).
        Ok(parsed.data.skills
            .into_iter()
            .map(|e| {
                let display_name = if !e.display_name.is_empty() {
                    e.display_name.clone()
                } else {
                    e.id.clone()
                };
                // Strip the noisy "category:" / "developer:" prefixes ModelScope
                // attaches to tags so the UI shows clean labels.
                let tags: Vec<String> = e
                    .tags
                    .iter()
                    .map(|t| t.split_once(':').map(|(_, v)| v.to_string()).unwrap_or_else(|| t.clone()))
                    .filter(|t| !t.is_empty())
                    .collect();
                MarketEntry {
                    display_name,
                    source_type: CapabilitySource::Skill,
                    spec: format!("modelscope-skill:{}", e.id),
                    version: String::new(),
                    description: e.description,
                    author: e.owner.or(e.developer),
                    publisher: None,
                    tags,
                    homepage: e.source_url.clone(),
                    installed: false,
                    license: e.license,
                    activation: Some("progressive".to_string()),
                    files: vec![],
                    download_url: e
                        .source_url
                        .clone()
                        .filter(|s| !s.trim().is_empty())
                        .or_else(|| Some(format!("https://www.modelscope.cn/{}", e.id))),
                }
            })
            .collect())
    }
}


/// Fetch a single ModelScope MCP server's connection config via the detail
/// OpenAPI (`GET /openapi/v1/mcp/servers/{id}`).
///
/// `token` is the optional ModelScope `ms-xxxx` token sent as
/// `Authorization: Bearer`; the detail endpoint frequently works without it,
/// but some servers require it. Returns `None` when the server is not found or
/// has no usable `server_config`.
pub async fn fetch_modelscope_server_config(
    server_id: &str,
    token: Option<&str>,
) -> Result<Option<McpServerConfig>> {
    let url = format!("{}/{}", MODELSCOPE_MCP_API, server_id);
    let mut reqb = http_client()
        .get(&url)
        .header("content-type", "application/json");
    if let Some(t) = token.filter(|t| !t.is_empty()) {
        reqb = reqb.header("authorization", format!("Bearer {}", t));
    }
    let resp = reqb.send().await?;
    if !resp.status().is_success() {
        anyhow::bail!("modelscope detail returned status {}", resp.status());
    }
    let val: Value = resp.json().await?;
    let Some(data) = val.get("data") else {
        return Ok(None);
    };

    // server_config: [ { mcpServers: { <name>: {command,args,env} | {url,...} } } ]
    //
    // Verified against the live ModelScope API (GET /openapi/v1/mcp/servers/{id},
    // e.g. `@amap/amap-maps`): stdio servers return a populated `server_config`;
    // `operational_urls` is consistently empty on the live endpoint (hosted
    // servers' sse url only appears in the `readme` text, not as structured
    // data). So `server_config` is the only field we can rely on, and a server
    // with neither a `server_config` nor a structured hosted url legitimately
    // cannot be auto-resolved here.
    let spec = data
        .get("server_config")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|c| c.get("mcpServers"))
        .and_then(|m| m.as_object())
        .and_then(|m| m.values().next());
    let Some(spec) = spec else {
        return Ok(None);
    };

    let (kind, command, args, url, env) = if let Some(u) = spec.get("url").and_then(|v| v.as_str()) {
        (
            "sse".to_string(),
            None,
            Vec::new(),
            Some(u.to_string()),
            HashMap::new(),
        )
    } else {
        let command = spec
            .get("command")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let args = spec
            .get("args")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let env = spec
            .get("env")
            .and_then(|v| v.as_object())
            .map(|o| {
                o.iter()
                    .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string()))
                    .collect::<HashMap<String, String>>()
            })
            .unwrap_or_default();
        ("stdio".to_string(), command, args, None, env)
    };

    // ModelScope env entries are placeholders like `<YOUR_TOKEN>`; surface them
    // as required secret specs so the UI can collect real values.
    let required_env = env
        .iter()
        .map(|(k, v)| EnvVarSpec {
            name: k.clone(),
            description: v.clone(),
            required: true,
        })
        .collect::<Vec<_>>();

    let description = data
        .get("description")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty());
    let source_url = data
        .get("source_url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let mut readme = data
        .get("readme")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty());
    // ModelScope leaves both empty for many servers; fall back to the npm
    // package README (which carries the real product intro / usage scenarios).
    if readme.is_none() && description.is_none()
        && let Some(pkg) = source_url.as_deref().and_then(npm_package_from_url)
            && let Ok(Some(r)) = fetch_npm_readme(&pkg).await {
                readme = Some(r);
            }
    let logo_url = data
        .get("logo_url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let categories = data
        .get("categories")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(Some(McpServerConfig {
        kind,
        command,
        args,
        url,
        env,
        required_env,
        description,
        source_url,
        readme,
        logo_url,
        categories,
        license: None,
        publisher: None,
    }))
}

/// Extract an npm package name from an npmjs.com package URL, e.g.
/// `https://www.npmjs.com/package/@alipay/open-mcp-server` → `@alipay/open-mcp-server`.
fn npm_package_from_url(url: &str) -> Option<String> {
    let marker = "npmjs.com/package/";
    let idx = url.find(marker)?;
    let pkg = &url[idx + marker.len()..];
    let pkg = pkg.split(['?', '#']).next().unwrap_or(pkg);
    if pkg.is_empty() {
        None
    } else {
        Some(pkg.to_string())
    }
}

/// Fetch a package README from the public npm registry. Returns `None` on any
/// failure or when the package has no README — callers treat this as "no
/// fallback available" rather than an error.
async fn fetch_npm_readme(package: &str) -> Result<Option<String>> {
    let url = format!("https://registry.npmjs.org/{}", package);
    let resp = match http_client().get(&url).send().await {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };
    if !resp.status().is_success() {
        return Ok(None);
    }
    let val: Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    Ok(val
        .get("readme")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty()))
}

/// Resolve a ModelScope MCP server's human title by id, hitting the detail
/// endpoint `GET /openapi/v1/mcp/servers/{id}` directly. Unlike the list/search
/// endpoint (whose `search` field matches name/description but not ids that
/// contain `/`), this lookup is precise and reliable for installed gears whose
/// manifest stored a `spec` like `modelscope:Alipay/alipay-subscription` but no
/// `display_name`. Returns `None` on any failure (network/offline/not-found).
pub async fn fetch_modelscope_server_title(server_id: &str) -> Option<String> {
    let url = format!("{}/{}", MODELSCOPE_MCP_API, server_id);
    let resp = match http_client()
        .get(&url)
        .header("content-type", "application/json")
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return None,
    };
    if !resp.status().is_success() {
        return None;
    }
    let val: serde_json::Value = resp.json().await.ok()?;
    let data = val.get("data")?;
    let name = data.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let chinese = data.get("chinese_name").and_then(|v| v.as_str()).unwrap_or("");
    let title = if !name.trim().is_empty() {
        name.to_string()
    } else if !chinese.trim().is_empty() {
        chinese.to_string()
    } else {
        return None;
    };
    if title.trim().is_empty() {
        None
    } else {
        Some(title)
    }
}

/// Fetch a single official-registry MCP server's connection config.
///
/// The official registry exposes the full picture at the *version* endpoint
/// (`GET /v0/servers/{name}/versions/{version}`): `remotes[]` for HTTP/streamable
/// servers and `packages[]` (npm) for stdio servers, where `environmentVariables`
/// declares the secrets the caller must supply. `version` selects which release
/// to install (omit → latest). Returns `None` when not found.
pub async fn fetch_official_server_config(
    server_id: &str,
    version: Option<&str>,
    _token: Option<&str>,
) -> Result<Option<McpServerConfig>> {
    let base = std::env::var("MCP_REGISTRY_URL")
        .ok()
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| MCP_REGISTRY_BASE.to_string());
    let encoded = server_id.replace('/', "%2F");
    let path = match version.filter(|v| !v.is_empty()) {
        Some(v) => format!("{}/{}/versions/{}", base.trim_end_matches('/'), encoded, v),
        None => {
            // Resolve the latest version via the versions list. The endpoint
            // returns the same `{ servers: [{ server: {...} }] }` shape as the
            // main list, one entry per version; pick the highest version.
            let list_url = format!("{}/{}/versions", base.trim_end_matches('/'), encoded);
            let lresp = http_client().get(&list_url).send().await?;
            if !lresp.status().is_success() {
                anyhow::bail!("official registry versions returned status {}", lresp.status());
            }
            #[derive(Deserialize)]
            struct VersionsResp {
                #[serde(default)]
                servers: Vec<VersionsServerEntry>,
            }
            #[derive(Deserialize)]
            struct VersionsServerEntry {
                server: VersionsServer,
            }
            #[derive(Deserialize)]
            struct VersionsServer {
                #[serde(default)]
                version: String,
            }
            let lval: VersionsResp =
                lresp.json().await.unwrap_or(VersionsResp { servers: vec![] });
            let latest = lval
                .servers
                .iter()
                .map(|e| e.server.version.clone())
                .filter(|v| !v.is_empty())
                .max_by(|a, b| version_gt(a, b).cmp(&version_gt(b, a)))
                .ok_or_else(|| anyhow::anyhow!("official registry has no versions for '{server_id}'"))?;
            format!("{}/{}/versions/{}", base.trim_end_matches('/'), encoded, latest)
        }
    };

    let resp = http_client().get(&path).send().await?;
    if !resp.status().is_success() {
        anyhow::bail!("official registry detail returned status {}", resp.status());
    }
    let val: Value = resp.json().await?;
    let Some(server) = val.get("server") else {
        return Ok(None);
    };

    let repository = server.get("repository").and_then(|v| v.as_str()).map(|s| s.to_string());
    let website = server.get("websiteUrl").and_then(|v| v.as_str()).map(|s| s.to_string());
    let description = server
        .get("description")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // Remote (HTTP / streamable-http) server → sse gear pointing at the URL.
    if let Some(remotes) = server.get("remotes").and_then(|v| v.as_array())
        && let Some(first) = remotes.first()
            && let Some(u) = first.get("url").and_then(|v| v.as_str()) {
                return Ok(Some(McpServerConfig {
                    kind: "sse".to_string(),
                    command: None,
                    args: vec![],
                    url: Some(u.to_string()),
                    env: HashMap::new(),
                    required_env: vec![],
                    description,
                    source_url: website.or(repository),
                    readme: None,
                    logo_url: None,
                    categories: vec![],
                    license: None,
                    publisher: None,
                }));
            }

    // Package (npm) server → stdio gear launched via npx.
    if let Some(packages) = server.get("packages").and_then(|v| v.as_array())
        && let Some(pkg) = packages.first() {
            let identifier = pkg
                .get("identifier")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let mut args = vec!["-y".to_string(), identifier.clone()];
            if let Some(ra) = pkg.get("runtimeArguments").and_then(|v| v.as_array()) {
                for x in ra {
                    if let Some(s) = x.as_str() {
                        args.push(s.to_string());
                    }
                }
            }
            if let Some(pa) = pkg.get("packageArguments").and_then(|v| v.as_array()) {
                for x in pa {
                    if let Some(s) = x.as_str() {
                        args.push(s.to_string());
                    }
                }
            }

            let mut required_env = Vec::new();
            if let Some(evs) = pkg.get("environmentVariables").and_then(|v| v.as_array()) {
                for ev in evs {
                    let name = ev.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    if name.is_empty() {
                        continue;
                    }
                    let description = ev
                        .get("description")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let required = ev
                        .get("isRequired")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(true);
                    required_env.push(EnvVarSpec {
                        name,
                        description,
                        required,
                    });
                }
            }

            return Ok(Some(McpServerConfig {
                kind: "stdio".to_string(),
                command: Some("npx".to_string()),
                args,
                url: None,
                env: HashMap::new(),
                required_env,
                description,
                source_url: website.or(repository),
                readme: None,
                logo_url: None,
                categories: vec![],
                license: None,
                publisher: None,
            }));
        }

    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Offline contract ──────────────────────────────────────────────────
    // The gear market is used against the live ModelScope API. When ModelScope
    // is unreachable the list must NOT load and installation must NOT succeed —
    // these failure behaviors are the contract, not an accident.

    /// Offline (no ModelScope endpoints reachable): the market page must come
    /// back empty with a surfaced upstream error, never a silently empty list.
    #[tokio::test]
    #[ignore = "negative contract: only meaningful in an OFFLINE environment; \
                run with `--ignored` in CI without ModelScope access"]
    async fn offline_market_loads_nothing_and_reports_error() {
        // force_refresh = true so we bypass the 1-hour in-memory TTL cache and
        // actually re-hit the (unreachable) upstream — proving the live path
        // itself fails offline, not just a stale cache.
        let (entries, _has_more, _total_est, errors) =
            search_market_page("", 1, 20, None, true).await;
        assert!(
            entries.is_empty(),
            "offline market must return no entries"
        );
        assert!(
            !errors.is_empty(),
            "offline market must report upstream errors, not silently empty"
        );
    }

    // ── Live integration ──────────────────────────────────────────────────
    // Run against the real ModelScope API with `cargo test -- --ignored`.
    // Ignored by default so an offline/CI environment does not fail.

    /// Live market: the real ModelScope sources must return items with a
    /// consistent kind when online.
    #[tokio::test]
    #[ignore = "requires network access to ModelScope API"]
    async fn live_modelscope_market_returns_items() {
        let (entries, _has_more, _total_est, errors) =
            search_market_page("", 1, 20, None, true).await;
        assert!(
            errors.is_empty(),
            "live ModelScope query should not error: {:?}",
            errors
        );
        assert!(
            !entries.is_empty(),
            "live ModelScope market should return at least one entry"
        );
        for e in &entries {
            assert!(e.source_type == CapabilitySource::Mcp || e.source_type == CapabilitySource::Skill);
        }
    }
}
