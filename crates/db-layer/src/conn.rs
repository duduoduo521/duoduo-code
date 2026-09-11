//! Borrowed-connection abstraction shared by every SQLite-backed crate.
//!
//! A connection is obtained either from an r2d2 pool or from a process-local
//! `Mutex` (in-memory databases). Both are exposed behind the same
//! `Deref<Target = Connection>` so call sites can call `conn.execute(...)`
//! without knowing which variant they hold.
//!
//! This replaces eight byte-identical copies of the same two enums that used
//! to live in `blackboard-store`, `knowledge-graph-store`, `memory-system`,
//! `prompt-cache` and `session-manager`.

use rusqlite::Connection;

/// A pooled connection, boxed because `r2d2::PooledConnection` stores a whole
/// `rusqlite::Connection` inline (~240 bytes). Boxing keeps the enums below
/// pointer-sized, which matters because they are built on every query.
pub type BoxedPooledConnection = Box<r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager>>;

/// Abstraction over a borrowed connection — either from the pool or from a Mutex.
/// Implements `Deref<Target = Connection>` so all `conn.execute()` etc. work transparently.
pub enum ConnectionRef<'a> {
    Pooled(BoxedPooledConnection),
    InMemory(std::sync::MutexGuard<'a, Connection>),
}

impl std::ops::Deref for ConnectionRef<'_> {
    type Target = Connection;
    fn deref(&self) -> &Self::Target {
        match self {
            ConnectionRef::Pooled(pc) => pc,
            ConnectionRef::InMemory(guard) => guard,
        }
    }
}

/// Abstraction over a mutably-borrowed connection — needed for `transaction_with_behavior`.
pub enum ConnectionRefMut<'a> {
    Pooled(BoxedPooledConnection),
    InMemory(std::sync::MutexGuard<'a, Connection>),
}

impl std::ops::Deref for ConnectionRefMut<'_> {
    type Target = Connection;
    fn deref(&self) -> &Self::Target {
        match self {
            ConnectionRefMut::Pooled(pc) => pc,
            ConnectionRefMut::InMemory(guard) => guard,
        }
    }
}

impl std::ops::DerefMut for ConnectionRefMut<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        match self {
            ConnectionRefMut::Pooled(pc) => pc,
            ConnectionRefMut::InMemory(guard) => guard,
        }
    }
}
