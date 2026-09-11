//! Prompt cache: request-hash-level LLM response cache.
//!
//! Inserts a caching layer before LLM API calls. Same request (model + prompt hash)
//! returns the cached response directly, skipping the API call entirely.
//!
//! Architecture:
//! - **LRU in-memory** for hot-path hits (sub-microsecond)
//! - **SQLite persistence** for cold-start warmup and cross-restart durability
//!
//! Hash computation: `SHA-256(model || role_1 || content_1 || role_2 || content_2 || ...)`
//! guarantees that identical model + identical messages produce the same key.

mod customizer;
mod store;

use std::num::NonZeroUsize;
use std::sync::Mutex;

use anyhow::Result;
use lru::LruCache;
use sha2::{Digest, Sha256};
use tracing::{debug, info, instrument};

use duo_types::LlmResponse;

use crate::store::CacheStore;

// ── Cache key ──────────────────────────────────────────────────────

/// Cache key: model identifier + SHA-256 hash of all messages.
#[derive(Debug, Clone, Hash, PartialEq, Eq)]
pub struct CacheKey {
    /// LLM model identifier (e.g. "gpt-4", "deepseek-chat").
    pub model: String,
    /// SHA-256 digest of the concatenated (role + content) of all messages.
    pub prompt_hash: [u8; 32],
}

impl CacheKey {
    /// Compute a cache key from a model name and a slice of message-like pairs.
    ///
    /// Each message contributes `role.as_bytes() || content.as_bytes()` to the hash.
    /// The model name is prepended so that the same prompt to different models
    /// produces different keys (model capabilities differ).
    pub fn from_messages(model: &str, messages: &[(impl AsRef<str>, impl AsRef<str>)]) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(model.as_bytes());
        for (role, content) in messages {
            hasher.update(role.as_ref().as_bytes());
            hasher.update(content.as_ref().as_bytes());
        }
        Self {
            model: model.to_string(),
            prompt_hash: hasher.finalize().into(),
        }
    }

    /// Compute a cache key from a model name and a single user prompt string.
    ///
    /// Convenience wrapper for the common case where only a user prompt is available.
    pub fn from_prompt(model: &str, prompt: &str) -> Self {
        Self::from_messages(model, &[("user", prompt)])
    }
}

// ── Cache entry ────────────────────────────────────────────────────

/// A cached LLM response with metadata.
#[derive(Debug, Clone)]
struct CacheEntry {
    response: LlmResponse,
    #[allow(dead_code)]
    created_at: i64,
    hit_count: u64,
}

// ── Prompt cache ───────────────────────────────────────────────────

/// Request-hash-level LLM response cache.
///
/// Uses a two-tier architecture:
/// 1. **In-memory LRU** — fast path, sub-microsecond lookups.
/// 2. **SQLite store** — durability across restarts, cold-start warmup.
///
/// # Thread safety
///
/// The LRU is wrapped in a `Mutex` (not `async` lock) because LRU operations
/// are O(1) and never block on I/O. The SQLite store uses `r2d2` connection
/// pools (read/write split) for thread-safe concurrent access. This makes
/// `PromptCache` itself `Send + Sync`.
pub struct PromptCache {
    /// In-memory LRU cache (hot path).
    lru: Mutex<LruCache<CacheKey, CacheEntry>>,
    /// SQLite persistence layer (cold path).
    store: Option<CacheStore>,
    /// Maximum number of entries in the in-memory LRU.
    max_entries: usize,
}

impl PromptCache {
    /// Create a new `PromptCache` with the given LRU capacity and optional SQLite store.
    ///
    /// When `db_path` is `Some`, the cache persists to and restores from SQLite.
    /// When `None`, the cache is in-memory only (no durability).
    pub fn new(max_entries: usize, db_path: Option<String>) -> Result<Self> {
        let store = match db_path {
            Some(path) => Some(CacheStore::new(&path)?),
            None => None,
        };

        let capacity =
            NonZeroUsize::new(max_entries.max(1)).expect("invariant: max(1) guarantees non-zero");
        let cache = Self {
            lru: Mutex::new(LruCache::new(capacity)),
            store,
            max_entries,
        };

        // Warmup from SQLite on creation
        if let Err(e) = cache.warmup() {
            tracing::warn!(error = %e, "Failed to warmup prompt cache from SQLite");
        }

        Ok(cache)
    }

    /// Create an in-memory-only cache (for tests).
    pub fn new_in_memory(max_entries: usize) -> Result<Self> {
        Self::new(max_entries, None)
    }

    /// Query the cache for a given key.
    ///
    /// Checks the in-memory LRU first, then falls back to SQLite.
    /// On a SQLite hit, the entry is promoted to the LRU for future fast access.
    #[instrument(skip(self))]
    pub fn get(&self, key: &CacheKey) -> Option<LlmResponse> {
        // Fast path: check in-memory LRU
        {
            let mut lru = self.lru.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(entry) = lru.get_mut(key) {
                entry.hit_count += 1;
                debug!(
                    model = %key.model,
                    hit_count = entry.hit_count,
                    "Prompt cache hit (LRU)"
                );
                return Some(entry.response.clone());
            }
        }

        // Slow path: check SQLite
        if let Some(ref store) = self.store
            && let Some(response) = store.get(key) {
                // Promote to LRU
                let mut lru = self.lru.lock().unwrap_or_else(|e| e.into_inner());
                let entry = CacheEntry {
                    response: response.clone(),
                    created_at: chrono::Utc::now().timestamp(),
                    hit_count: 1,
                };
                lru.put(key.clone(), entry);
                debug!(model = %key.model, "Prompt cache hit (SQLite → promoted to LRU)");
                return Some(response);
            }

        debug!(model = %key.model, "Prompt cache miss");
        None
    }

    /// Insert a response into the cache.
    ///
    /// Writes to both the in-memory LRU and SQLite (if configured).
    #[instrument(skip(self, response))]
    pub fn put(&self, key: CacheKey, response: LlmResponse) {
        let entry = CacheEntry {
            response: response.clone(),
            created_at: chrono::Utc::now().timestamp(),
            hit_count: 0,
        };

        // Write to LRU
        {
            let mut lru = self.lru.lock().unwrap_or_else(|e| e.into_inner());
            lru.put(key.clone(), entry);
        }

        // Write to SQLite (async, non-blocking)
        if let Some(ref store) = self.store
            && let Err(e) = store.put(&key, &response) {
                tracing::warn!(error = %e, "Failed to persist cache entry to SQLite");
            }
    }

    /// Warm up the in-memory LRU from SQLite.
    ///
    /// Loads the most recently used entries from SQLite into the LRU.
    /// Called automatically on construction; can be called manually after
    /// bulk cache invalidation to repopulate.
    #[instrument(skip(self))]
    pub fn warmup(&self) -> Result<usize> {
        let Some(ref store) = self.store else {
            return Ok(0);
        };

        let entries = store.recent_entries(self.max_entries)?;
        let count = entries.len();

        let mut lru = self.lru.lock().unwrap_or_else(|e| e.into_inner());
        for (key, response, created_at) in entries {
            let entry = CacheEntry {
                response,
                created_at,
                hit_count: 0,
            };
            lru.put(key, entry);
        }

        if count > 0 {
            info!(count, "Warmed up prompt cache from SQLite");
        }

        Ok(count)
    }

    /// Invalidate all cache entries (both LRU and SQLite).
    pub fn invalidate_all(&self) -> Result<()> {
        {
            let mut lru = self.lru.lock().unwrap_or_else(|e| e.into_inner());
            lru.clear();
        }

        if let Some(ref store) = self.store {
            store.clear()?;
        }

        Ok(())
    }

    /// Return the current number of entries in the in-memory LRU.
    pub fn len(&self) -> usize {
        self.lru.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    /// Return whether the in-memory LRU is empty.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Default for PromptCache {
    fn default() -> Self {
        Self::new_in_memory(1024).expect("Failed to create default PromptCache")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use duo_types::TokenUsage;

    fn make_response(content: &str) -> LlmResponse {
        LlmResponse {
            content: content.to_string(),
            reasoning_content: None,
            model_id: Some("test-model".to_string()),
            token_usage: TokenUsage {
                prompt_tokens: 10,
                completion_tokens: 20,
                total_tokens: 30,
                ..Default::default()
            },
            finish_reason: Some("stop".to_string()),
            tool_calls: None,
        }
    }

    #[test]
    fn cache_hit_and_miss() {
        let cache = PromptCache::new_in_memory(100).unwrap();
        let key = CacheKey::from_prompt("gpt-4", "hello world");

        // Miss
        assert!(cache.get(&key).is_none());

        // Put
        cache.put(key.clone(), make_response("hi there"));

        // Hit
        let resp = cache.get(&key).unwrap();
        assert_eq!(resp.content, "hi there");
    }

    #[test]
    fn different_prompts_dont_collide() {
        let cache = PromptCache::new_in_memory(100).unwrap();
        let key1 = CacheKey::from_prompt("gpt-4", "hello");
        let key2 = CacheKey::from_prompt("gpt-4", "world");

        cache.put(key1.clone(), make_response("resp1"));
        cache.put(key2.clone(), make_response("resp2"));

        assert_eq!(cache.get(&key1).unwrap().content, "resp1");
        assert_eq!(cache.get(&key2).unwrap().content, "resp2");
    }

    #[test]
    fn different_models_dont_collide() {
        let cache = PromptCache::new_in_memory(100).unwrap();
        let key1 = CacheKey::from_prompt("gpt-4", "hello");
        let key2 = CacheKey::from_prompt("deepseek-chat", "hello");

        cache.put(key1.clone(), make_response("gpt4-resp"));
        cache.put(key2.clone(), make_response("deepseek-resp"));

        assert_eq!(cache.get(&key1).unwrap().content, "gpt4-resp");
        assert_eq!(cache.get(&key2).unwrap().content, "deepseek-resp");
    }

    #[test]
    fn lru_eviction() {
        let cache = PromptCache::new_in_memory(2).unwrap();
        let key1 = CacheKey::from_prompt("m", "a");
        let key2 = CacheKey::from_prompt("m", "b");
        let key3 = CacheKey::from_prompt("m", "c");

        cache.put(key1.clone(), make_response("1"));
        cache.put(key2.clone(), make_response("2"));
        // key1 should still be in LRU (capacity=2)
        assert!(cache.get(&key1).is_some());

        // Inserting key3 evicts the least-recently-used entry
        cache.put(key3.clone(), make_response("3"));
        // key2 was evicted (accessed least recently)
        assert!(cache.get(&key2).is_none());
        assert!(cache.get(&key1).is_some()); // recently accessed
        assert!(cache.get(&key3).is_some());
    }

    #[test]
    fn from_messages_hash_consistency() {
        let key1 = CacheKey::from_messages("m", &[("user", "hello"), ("assistant", "hi")]);
        let key2 = CacheKey::from_messages("m", &[("user", "hello"), ("assistant", "hi")]);
        assert_eq!(key1, key2);

        let key3 = CacheKey::from_messages("m", &[("user", "hello"), ("assistant", "hey")]);
        assert_ne!(key1, key3);
    }

    #[tokio::test]
    async fn sqlite_persistence_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("cache.db");
        let db_path_str = db_path.to_str().unwrap().to_string();

        let key = CacheKey::from_prompt("gpt-4", "persistent test");

        // Write
        {
            let cache = PromptCache::new(100, Some(db_path_str.clone())).unwrap();
            cache.put(key.clone(), make_response("cached-response"));
            assert_eq!(cache.get(&key).unwrap().content, "cached-response");
        }

        // Re-open — should warmup from SQLite
        {
            let cache = PromptCache::new(100, Some(db_path_str)).unwrap();
            let resp = cache.get(&key).unwrap();
            assert_eq!(resp.content, "cached-response");
        }
    }

    #[test]
    fn invalidate_all_clears_everything() {
        let cache = PromptCache::new_in_memory(100).unwrap();
        let key = CacheKey::from_prompt("m", "hello");
        cache.put(key.clone(), make_response("resp"));
        assert!(cache.get(&key).is_some());

        cache.invalidate_all().unwrap();
        assert!(cache.get(&key).is_none());
        assert!(cache.is_empty());
    }
}
