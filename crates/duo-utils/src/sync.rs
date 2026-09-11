//! Shared synchronization helpers.

use std::sync::{Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};

/// Lock a [`Mutex`], recovering the guard if the mutex is poisoned.
///
/// `std::sync::Mutex::lock()` returns a `Result` because a thread that unwinds
/// *while holding the lock* marks the mutex as poisoned. The usual advice is to
/// propagate that with `unwrap()`, but in a long-running server that converts a
/// single bad request into a permanent outage: every later caller of the same
/// mutex panics too, so the process stops serving healthy requests as well.
///
/// The mutexes in this workspace guard plain data — phase enums, counters,
/// instance maps. Rust guarantees memory safety even when a panic unwinds out
/// of a critical section, and these types have no torn/partial state, so the
/// data behind a poisoned mutex is still structurally valid. We therefore log
/// once and keep serving instead of cascading the failure.
///
/// Use this in place of `mutex.lock().unwrap()`.
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| {
        tracing::warn!(
            mutex = std::any::type_name::<T>(),
            "Mutex was poisoned by a panicking thread; recovering the guard so the \
             process keeps serving (the guarded value may be mid-update)"
        );
        poisoned.into_inner()
    })
}

/// Read-lock an [`RwLock`], recovering the guard if it is poisoned.
///
/// Same rationale as [`lock`]: a poisoned `RwLock` must not turn one bad
/// request into a permanent outage for every later reader.
pub fn read<T>(lock: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(|poisoned| {
        tracing::warn!(
            lock = std::any::type_name::<T>(),
            "RwLock was poisoned by a panicking thread; recovering the read guard \
             (the guarded value may be mid-update)"
        );
        poisoned.into_inner()
    })
}

/// Write-lock an [`RwLock`], recovering the guard if it is poisoned.
pub fn write<T>(lock: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    lock.write().unwrap_or_else(|poisoned| {
        tracing::warn!(
            lock = std::any::type_name::<T>(),
            "RwLock was poisoned by a panicking thread; recovering the write guard \
             (the guarded value may be mid-update)"
        );
        poisoned.into_inner()
    })
}

/// Poison-recovering `Mutex::lock()` as a method.
///
/// Delegates to [`lock`]; use this at call sites that already chain, so that
/// `foo.lock().expect("...")` becomes `foo.lock_recover()` without
/// restructuring the surrounding expression.
pub trait MutexPoisonRecover<T> {
    /// Lock, recovering the guard if the mutex is poisoned.
    fn lock_recover(&self) -> MutexGuard<'_, T>;
}

impl<T> MutexPoisonRecover<T> for Mutex<T> {
    fn lock_recover(&self) -> MutexGuard<'_, T> {
        lock(self)
    }
}

/// Poison-recovering `RwLock` accessors as methods.
///
/// Delegates to [`read`] / [`write`]; see [`MutexPoisonRecover`] for why.
pub trait RwLockPoisonRecover<T> {
    /// Read-lock, recovering the guard if the lock is poisoned.
    fn read_recover(&self) -> RwLockReadGuard<'_, T>;
    /// Write-lock, recovering the guard if the lock is poisoned.
    fn write_recover(&self) -> RwLockWriteGuard<'_, T>;
}

impl<T> RwLockPoisonRecover<T> for RwLock<T> {
    fn read_recover(&self) -> RwLockReadGuard<'_, T> {
        read(self)
    }

    fn write_recover(&self) -> RwLockWriteGuard<'_, T> {
        write(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn returns_guard_for_healthy_mutex() {
        let mutex = Mutex::new(41);
        *lock(&mutex) += 1;
        assert_eq!(*lock(&mutex), 42);
    }

    /// A panic inside the critical section must poison the mutex, and `lock`
    /// must still hand out a usable guard afterwards instead of propagating
    /// the panic to every subsequent caller.
    #[test]
    fn recovers_guard_after_panic_poisons_mutex() {
        let mutex = Arc::new(Mutex::new(0));

        let poisoner = Arc::clone(&mutex);
        let panicked = std::thread::spawn(move || {
            let mut guard = poisoner.lock().unwrap();
            *guard = 7;
            panic!("poison the mutex on purpose");
        });
        assert!(panicked.join().is_err());

        assert!(mutex.is_poisoned());
        // `std::sync::Mutex::lock()` would return `Err` here; `lock` recovers.
        let mut guard = lock(&mutex);
        assert_eq!(*guard, 7, "value written before the panic is still intact");
        *guard = 8;
        drop(guard);
        assert_eq!(*lock(&mutex), 8);
    }

    /// A panic while holding the write guard poisons the RwLock; both `read`
    /// and `write` must still hand out usable guards afterwards.
    #[test]
    fn rwlock_recovers_after_panic_poisons_it() {
        let lock = Arc::new(RwLock::new(1));

        let poisoner = Arc::clone(&lock);
        let panicked = std::thread::spawn(move || {
            let mut guard = poisoner.write().unwrap();
            *guard = 5;
            panic!("poison the RwLock on purpose");
        });
        assert!(panicked.join().is_err());
        assert!(lock.is_poisoned());

        assert_eq!(*read(&lock), 5, "value written before the panic is intact");
        *write(&lock) = 6;
        assert_eq!(*read(&lock), 6);
    }

    /// Concurrent lockers must still be serialized — recovering from poisoning
    /// must never hand out two guards at once.
    #[test]
    fn still_excludes_concurrent_lockers() {
        let mutex = Arc::new(Mutex::new(0u64));
        let mut handles = Vec::new();

        for _ in 0..8 {
            let shared = Arc::clone(&mutex);
            handles.push(std::thread::spawn(move || {
                for _ in 0..1000 {
                    *lock(&shared) += 1;
                }
            }));
        }
        for handle in handles {
            handle.join().unwrap();
        }

        assert_eq!(*lock(&mutex), 8 * 1000);
    }
}
