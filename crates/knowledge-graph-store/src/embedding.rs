//! Semantic (embedding-based) similarity search over KG function nodes.
//!
//! This module gives `graph_query` a `similar` query type that finds code
//! blocks whose *meaning* matches a query — not just their name. It mirrors
//! the proven design in `memory-system` (in-memory HNSW + lazy rebuild +
//! brute-force fallback), kept self-contained so it does not widen
//! `memory-system`'s public API surface.
//!
//! Design invariants (must hold for 0-risk integration):
//! - No embedding config → `search_similar` returns an empty vec (caller
//!   degrades to name-based `search_nodes`). Never panics, never blocks a
//!   healthy write path.
//! - Embeddings are computed lazily and cached in an in-memory HNSW index.
//!   The index is NOT persisted (KG uses bincode snapshots); it is rebuilt on
//!   demand from `codeSnippet` properties. This avoids any schema migration.
//! - `HnswMap` does not support incremental insert, so after nodes change the
//!   index is invalidated and rebuilt on the next `search_similar`. Rebuild is
//!   bounded by the number of function nodes with a `codeSnippet`.
//! - Embedding HTTP calls use a blocking client with a 30s timeout, invoked
//!   ONLY from `search_similar` (never from the indexer upsert hot path), so
//!   indexing latency is unaffected.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;

use anyhow::{Context, Result};
use instant_distance::{Hnsw, HnswMap, Point, Search};
use serde::{Deserialize, Serialize};

/// Configuration for the embedding endpoint. Mirrors `memory-system`'s
/// `EmbeddingConfig` fields so the same runtime config can seed both.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EmbeddingConfig {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    /// Expected embedding dimension; mismatches are rejected by the API.
    pub dim: usize,
}

/// Cosine-distance point for `instant_distance`'s HnswMap.
#[derive(Clone)]
struct CosinePoint(Vec<f32>);

impl Point for CosinePoint {
    fn distance(&self, other: &Self) -> f32 {
        // Cosine distance = 1 - cosine_similarity, both vectors L2-normalized
        // at embed time so dot product == cosine similarity.
        let mut dot = 0.0f32;
        for i in 0..self.0.len().min(other.0.len()) {
            dot += self.0[i] * other.0[i];
        }
        // Clamp to [-1, 1] to avoid float noise pushing acos out of domain.
        let c = dot.clamp(-1.0, 1.0);
        1.0 - c
    }
}

/// Shared embedding index state for one `KnowledgeGraphStore`.
pub struct EmbeddingIndex {
    config: Arc<Mutex<Option<EmbeddingConfig>>>,
    /// Lazy HNSW index mapping a node id → its embedding point.
    hnsw: Arc<Mutex<Option<HnswMap<CosinePoint, String>>>>,
    /// When true, the in-memory index is stale and must be rebuilt before the
    /// next search. Set whenever function nodes are (re)indexed.
    dirty: Arc<AtomicBool>,
    /// Shared blocking HTTP client (P2-04).
    ///
    /// `reqwest::blocking::Client` is a cheap `Arc`-backed handle whose clone
    /// shares the connection pool, so one instance serves every embed call.
    /// A fresh client per snippet paid TLS + pool setup N times per rebuild.
    http: std::sync::OnceLock<reqwest::blocking::Client>,
}

impl Default for EmbeddingIndex {
    fn default() -> Self {
        Self {
            config: Arc::new(Mutex::new(None)),
            hnsw: Arc::new(Mutex::new(None)),
            dirty: Arc::new(AtomicBool::new(true)),
            http: std::sync::OnceLock::new(),
        }
    }
}

impl EmbeddingIndex {
    pub fn set_config(&self, config: EmbeddingConfig) {
        *duo_utils::sync::lock(&self.config) = Some(config);
    }

    pub fn has_config(&self) -> bool {
        duo_utils::sync::lock(&self.config).is_some()
    }

    /// Mark the index stale (call after any function node upsert).
    pub fn mark_dirty(&self) {
        self.dirty.store(true, Ordering::Relaxed);
    }

    /// The shared blocking HTTP client, built once on first use.
    fn http(&self) -> Option<&reqwest::blocking::Client> {
        if let Some(client) = self.http.get() {
            return Some(client);
        }
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .ok()?;
        let _ = self.http.set(client);
        self.http.get()
    }

    /// Compute an embedding for `text` via the configured endpoint.
    /// Returns `None` when no config is set or the call fails (caller degrades).
    pub fn embed(&self, text: &str) -> Option<Vec<f32>> {
        let config = self.config_snapshot()?;
        let client = self.http()?;
        generate_embedding_sync(text, &config, client).ok()
    }

    /// Clone the embedding config so no lock is held across blocking HTTP.
    fn config_snapshot(&self) -> Option<EmbeddingConfig> {
        duo_utils::sync::lock(&self.config).as_ref().cloned()
    }

    /// Build (or rebuild) the HNSW index from `(node_id, codeSnippet)` pairs.
    /// `code_snippets` should already be filtered to nodes that have text.
    pub fn build_index(&self, code_snippets: Vec<(String, String)>) {
        if !self.has_config() {
            return;
        }
        if code_snippets.is_empty() {
            // Nothing embeddable exists: an empty index IS the correct result.
            // Leaving `dirty` set made every single query rebuild it — an
            // empty result each time, forever.
            self.dirty.store(false, Ordering::Relaxed);
            return;
        }
        let Some(client) = self.http() else {
            return;
        };
        let Some(config) = self.config_snapshot() else {
            return;
        };
        let mut points: Vec<CosinePoint> = Vec::with_capacity(code_snippets.len());
        let mut values: Vec<String> = Vec::with_capacity(code_snippets.len());
        for (id, snippet) in code_snippets {
            if let Ok(vec) = generate_embedding_sync(&snippet, &config, client) {
                points.push(CosinePoint(normalize(vec)));
                values.push(id);
            }
        }
        if points.is_empty() {
            // Every call failed (network down, bad key, wrong dim): stay dirty
            // so the next query retries, and say so instead of failing silently.
            tracing::warn!(
                "KG embedding index build produced no points; staying dirty for retry"
            );
            return;
        }
        let num = points.len();
        let hnsw_map = Hnsw::<CosinePoint>::builder()
            .build(points, values);
        *duo_utils::sync::lock(&self.hnsw) = Some(hnsw_map);
        self.dirty.store(false, Ordering::Relaxed);
        tracing::info!("KG embedding index built with {} points", num);
    }

    /// Search the index for the top `limit` node ids similar to `query`.
    /// Lazily rebuilds the index if dirty (caller supplies the snippets).
    /// Returns an empty vec when embeddings are unavailable.
    pub fn search_similar(
        &self,
        query: &str,
        limit: usize,
        snippets: Vec<(String, String)>,
    ) -> Vec<String> {
        if !self.has_config() {
            return Vec::new();
        }
        // Lazily (re)build when stale or absent.
        {
            let dirty = self.dirty.load(Ordering::Relaxed);
            let has_index = duo_utils::sync::lock(&self.hnsw).is_some();
            if dirty || !has_index {
                self.build_index(snippets);
            }
        }
        let query_vec = match self.embed(query) {
            Some(v) => CosinePoint(normalize(v)),
            None => return Vec::new(),
        };
        let index = duo_utils::sync::lock(&self.hnsw);
        let Some(ref index) = *index else {
            return Vec::new();
        };
        let mut search = Search::default();
        index
            .search(&query_vec, &mut search)
            .take(limit)
            .map(|item| item.value.to_string())
            .collect()
    }
}

/// L2-normalize a vector so dot product equals cosine similarity.
fn normalize(mut v: Vec<f32>) -> Vec<f32> {
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in &mut v {
            *x /= norm;
        }
    }
    v
}

/// Synchronous embedding API call. Self-contained (does not depend on
/// `memory-system`'s private functions). Mirrors the proven request shape.
///
/// The client is supplied by the caller ([`EmbeddingIndex::http`]) so a batch
/// of snippets shares one connection pool instead of building a client each.
fn generate_embedding_sync(
    text: &str,
    config: &EmbeddingConfig,
    client: &reqwest::blocking::Client,
) -> Result<Vec<f32>> {
    let url = format!("{}/embeddings", config.base_url.trim_end_matches('/'));
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .json(&serde_json::json!({
            "model": config.model,
            "input": text,
        }))
        .send()
        .context("Failed to send embedding API request")?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        anyhow::bail!("Embedding API returned {}: {}", status, body);
    }
    let body: serde_json::Value = response
        .json()
        .context("Failed to parse embedding API response")?;
    let embedding_data = body
        .get("data")
        .and_then(|d| d.get(0))
        .and_then(|d| d.get("embedding"))
        .and_then(|e| e.as_array())
        .ok_or_else(|| anyhow::anyhow!("Embedding API response missing data[0].embedding"))?;
    let embedding: Vec<f32> = embedding_data
        .iter()
        .map(|v| v.as_f64().unwrap_or(0.0) as f32)
        .collect();
    if embedding.len() != config.dim {
        anyhow::bail!(
            "Embedding dimension mismatch: expected {}, got {}",
            config.dim,
            embedding.len()
        );
    }
    Ok(embedding)
}
