//! Lazily-initialized, fallible, thread-safe, clone-shared subsystem holder.
//! On build failure, the cell stays empty and the next access retries
//! (mirrors the original eager semantics: a transient error does not poison).

use anyhow::Result;
use std::sync::Arc;
use std::sync::OnceLock;

/// Lazily-initialized, fallible, thread-safe, clone-shared subsystem holder.
/// On build failure, the cell stays empty and the next access retries
/// (mirrors the original eager semantics: a transient error does not poison).
pub struct LazyInit<T> {
    cell: OnceLock<Arc<T>>,
    builder: Box<dyn Fn() -> Result<Arc<T>> + Send + Sync>,
}

impl<T> LazyInit<T> {
    pub fn new(builder: impl Fn() -> Result<Arc<T>> + Send + Sync + 'static) -> Self {
        Self {
            cell: OnceLock::new(),
            builder: Box::new(builder),
        }
    }
    pub fn get(&self) -> Result<Arc<T>> {
        // NOTE: Concurrent calls may each invoke `builder()`, but only one result
        // is retained by `OnceLock::set`. This is acceptable — `OnceLock::get_or_try_init`
        // (which would guarantee single invocation) is currently unstable (rust-lang#109737).
        // Once it stabilizes, replace this with `self.cell.get_or_try_init(|| (self.builder)())`.
        if let Some(v) = self.cell.get() {
            return Ok(v.clone());
        }
        let built = (self.builder)()?;
        let _ = self.cell.set(built);
        Ok(self
            .cell
            .get()
            .expect("invariant: value was set on the line above or by a peer thread, so the OnceLock is non-empty")
            .clone())
    }
}
