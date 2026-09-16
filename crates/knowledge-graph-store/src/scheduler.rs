//! Background code-indexing: OS scheduling priority + machine-aware resource budget.
//!
//! Product requirement (hard line): code indexing MUST NEVER block user
//! operations. Two complementary mechanisms enforce that:
//!
//! 1. **Lower the priority — not the parallelism — of indexing threads**, so the
//!    UI and the smart-layer HTTP runtime are always serviced first. When the
//!    machine is otherwise idle, indexing still uses 100% of the free capacity,
//!    so it stays fast; the moment the user interacts, the scheduler yields to
//!    the UI. Low-end machines simply take longer to finish — acceptable, since
//!    they are never frozen.
//! 2. **Scale parallelism to the *physical* core count**, not logical/SMT cores,
//!    so low-core / low-memory machines keep headroom for the UI and avoid the
//!    memory spike caused by hundreds of concurrent file reads.

use std::sync::{Arc, LazyLock};

use tokio::sync::Semaphore;

/// Indexing resource budget derived from the machine's *physical* core count.
#[derive(Debug, Clone, Copy)]
pub struct IndexBudget {
    /// Number of parallel AST-parse chunks.
    pub parse_chunks: usize,
    /// Max concurrent file reads per batch (caps memory + disk pressure).
    pub read_concurrency: usize,
}

/// Lazily-computed, process-wide indexing budget.
pub static INDEX_BUDGET: LazyLock<IndexBudget> = LazyLock::new(compute_budget);

/// Process-wide cap on concurrent AST-parse tasks across **all** projects, so
/// that N projects indexing in parallel share the same CPU budget a single
/// project would get (no N× oversubscription). Permits equal the single-project
/// `parse_chunks` budget, so a lone project is unaffected and only multi-project
/// concurrency is bounded.
pub static PARSE_SEMAPHORE: LazyLock<Arc<Semaphore>> =
    LazyLock::new(|| Arc::new(Semaphore::new(INDEX_BUDGET.parse_chunks.max(1))));

/// Compute the indexing budget from physical CPU cores.
///
/// `available_parallelism()` reports *logical* CPUs (includes hyper-threads /
/// SMT siblings). A logical sibling shares the execution unit, cache and memory
/// bandwidth with its physical-core partner, so treating it as an independent
/// core for a CPU-bound task like AST parsing over-commits and starves the UI
/// thread running on the same physical core. We therefore budget on physical
/// cores and always leave headroom for the UI.
fn compute_budget() -> IndexBudget {
    let phys = physical_cpus();
    let budget = if phys <= 2 {
        // Very low-end (old dual-core). Keep the single remaining core for UI,
        // and a tiny read batch so a 4 GB box never spikes into swap.
        IndexBudget { parse_chunks: 1, read_concurrency: 16 }
    } else if phys <= 4 {
        // Low-end (entry laptop / old quad-core). Leave >=1 core. Read batch
        // stays modest (~144 MB peak) to protect small-RAM machines.
        IndexBudget { parse_chunks: phys - 1, read_concurrency: 48 }
    } else if phys <= 8 {
        // Mid-range. Leave 2 cores for the system / UI. Reads scale up since
        // these machines usually have >=8 GB RAM.
        IndexBudget { parse_chunks: phys - 2, read_concurrency: 96 }
    } else {
        // High-end. Use ~3/4 of physical cores, leave headroom. Read concurrency
        // is generous (SSD-friendly) but still bounded to avoid a memory spike.
        IndexBudget {
            parse_chunks: (phys * 3 / 4).max(4),
            read_concurrency: 256,
        }
    };
    tracing::info!(
        physical_cores = phys,
        parse_chunks = budget.parse_chunks,
        read_concurrency = budget.read_concurrency,
        "Computed code-indexing resource budget"
    );
    budget
}

/// Number of logical CPUs (what `available_parallelism` reports).
fn logical_cpus() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
}

/// Number of *physical* cores. Falls back to `logical / 2` (typical 2-way SMT)
/// when platform detection is unavailable.
fn physical_cpus() -> usize {
    let phys = detect_physical_cpus();
    if phys >= 1 {
        phys
    } else {
        logical_cpus().div_ceil(2)
    }
}

#[cfg(target_os = "macos")]
fn detect_physical_cpus() -> usize {
    unsafe {
        let mut val: i32 = 0;
        let mut size: libc::size_t = std::mem::size_of::<i32>() as libc::size_t;
        let name = b"hw.physicalcpu\0";
        if libc::sysctlbyname(
            name.as_ptr() as *const libc::c_char,
            &mut val as *mut i32 as *mut libc::c_void,
            &mut size,
            std::ptr::null_mut(),
            0,
        ) == 0
        {
            val.max(0) as usize
        } else {
            0
        }
    }
}

#[cfg(target_os = "linux")]
fn detect_physical_cpus() -> usize {
    use std::collections::HashMap;
    // Count unique (physical id, core id) pairs in /proc/cpuinfo.
    if let Ok(s) = std::fs::read_to_string("/proc/cpuinfo") {
        let mut packages: HashMap<u32, std::collections::HashSet<u32>> = HashMap::new();
        let mut cur_pkg: u32 = 0;
        let mut cur_core: Option<u32> = None;
        let parse_num = |line: &str| -> Option<u32> {
            let idx = line.find(':')?;
            line[idx + 1..].trim().parse::<u32>().ok()
        };
        for line in s.lines() {
            if let Some(rest) = line.strip_prefix("physical id") {
                if let Some(n) = parse_num(rest) {
                    cur_pkg = n;
                }
            } else if let Some(rest) = line.strip_prefix("core id") {
                cur_core = parse_num(rest);
            } else if line.trim().is_empty()
                && let Some(core) = cur_core.take()
            {
                packages.entry(cur_pkg).or_default().insert(core);
            }
        }
        if let Some(core) = cur_core.take() {
            packages.entry(cur_pkg).or_default().insert(core);
        }
        let total: usize = packages.values().map(|s| s.len()).sum();
        return total;
    }
    0
}

#[cfg(target_os = "windows")]
fn detect_physical_cpus() -> usize {
    use windows_sys::Win32::System::SystemInformation::{
        GetLogicalProcessorInformation, RelationProcessorCore,
        SYSTEM_LOGICAL_PROCESSOR_INFORMATION,
    };
    // Static buffer covers up to 2048 logical processors — more than any
    // real desktop. If exceeded we simply report 0 and fall back to logical/2.
    const MAX_ENTRIES: usize = 2048;
    let mut buf: Vec<SYSTEM_LOGICAL_PROCESSOR_INFORMATION> =
        vec![unsafe { std::mem::zeroed() }; MAX_ENTRIES];
    let mut len =
        (MAX_ENTRIES * std::mem::size_of::<SYSTEM_LOGICAL_PROCESSOR_INFORMATION>()) as u32;
    unsafe {
        if GetLogicalProcessorInformation(buf.as_mut_ptr(), &mut len) != 0 {
            let n =
                (len as usize) / std::mem::size_of::<SYSTEM_LOGICAL_PROCESSOR_INFORMATION>();
            let mut cores = 0usize;
            for info in buf.iter().take(n.min(MAX_ENTRIES)) {
                if info.Relationship == RelationProcessorCore {
                    cores += 1;
                }
            }
            return cores;
        }
    }
    0
}

#[cfg(not(any(
    target_os = "macos",
    target_os = "linux",
    target_os = "windows"
)))]
fn detect_physical_cpus() -> usize {
    0
}

/// Lower the OS scheduling (& I/O) priority of the **current thread** so that
/// user-facing work (UI, HTTP handlers in this same process) is always
/// serviced first.
///
/// Per-thread (not process-wide) so the smart-layer HTTP server is unaffected.
/// Safe to call multiple times; failures are ignored (best-effort).
pub fn set_index_thread_low_priority() {
    #[cfg(target_os = "macos")]
    {
        // Per-thread QoS BACKGROUND routes the thread to efficiency cores on
        // Apple Silicon and throttles CPU + I/O, without touching other threads
        // in the process (unlike PRIO_DARWIN_BG which is process-wide).
        unsafe {
            libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_BACKGROUND, 0);
        }
    }
    #[cfg(target_os = "linux")]
    {
        // PRIO_PROCESS with who=0 targets the calling thread on NPTL, so the
        // HTTP runtime's threads keep their normal priority.
        unsafe {
            libc::setpriority(libc::PRIO_PROCESS, 0, 10);
        }
    }
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::System::Threading::{
            GetCurrentThread, SetThreadInformation, SetThreadPriority, THREAD_PRIORITY_LOWEST,
            THREAD_POWER_THROTTLING_EXECUTION_SPEED, THREAD_POWER_THROTTLING_STATE,
            ThreadPowerThrottling,
        };
        unsafe {
            let thread = GetCurrentThread();
            // Lowest CPU priority for this thread only.
            SetThreadPriority(thread, THREAD_PRIORITY_LOWEST);
            // Efficiency / background mode throttles CPU + I/O for this thread.
            let policy = THREAD_POWER_THROTTLING_STATE {
                Version: 1,
                ControlMask: THREAD_POWER_THROTTLING_EXECUTION_SPEED,
                StateMask: THREAD_POWER_THROTTLING_EXECUTION_SPEED,
            };
            SetThreadInformation(
                thread,
                ThreadPowerThrottling,
                &policy as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<THREAD_POWER_THROTTLING_STATE>() as u32,
            );
        }
    }
}
