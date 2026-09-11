use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{EnvFilter, Layer, fmt, layer::SubscriberExt, util::SubscriberInitExt};

const MAX_LOG_AGE_DAYS: u64 = 7;
#[allow(dead_code)]
const TAIL_LINES: usize = 1000;
/// Size-based rotation threshold per stream (bytes). Matches the TS-side and
/// `duo-smart-layer` rotation.
const MAX_BYTES: u64 = 3 * 1024 * 1024;
/// Number of rotated generations kept (`desktop.log.1` .. `desktop.log.MAX_GEN`).
const MAX_GEN: usize = 5;

static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// A `std::io::Write` wrapper that rotates once a stream exceeds `MAX_BYTES`.
struct SizeRollingWriter {
    base: PathBuf,
    file: Option<File>,
    bytes: u64,
}

impl SizeRollingWriter {
    fn open(base: &Path) -> std::io::Result<Self> {
        let file = OpenOptions::new().create(true).append(true).open(base)?;
        let bytes = file.metadata()?.len();
        Ok(Self { base: base.to_path_buf(), file: Some(file), bytes })
    }

    fn gen_path(&self, generation: usize) -> PathBuf {
        self.base.with_extension(format!("log.{}", generation))
    }

    fn rotate(&mut self) -> std::io::Result<()> {
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

impl Write for SizeRollingWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.bytes + buf.len() as u64 > MAX_BYTES {
            self.rotate()?;
        }
        let n = self
            .file
            .as_mut()
            .ok_or_else(|| std::io::Error::other("log writer closed"))?
            .write(buf)?;
        self.bytes += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        if let Some(f) = self.file.as_mut() {
            f.flush()
        } else {
            Ok(())
        }
    }
}

/// Keeps the non-blocking worker guards alive for the app lifetime so buffered
/// logs are flushed on shutdown. The guards are intentionally held but never
/// read (RAII): dropping them would flush and close the sinks early.
#[allow(dead_code)]
pub struct LogGuard(WorkerGuard, WorkerGuard);

/// Initialize logging into `log_dir`, which is expected to be a per-day
/// directory (e.g. `<log_root>/<YYYY-MM-DD>`). Writes `desktop.log` (INFO+)
/// and `desktop.error.log` (ERROR) with size-based rotation, while keeping a
/// stderr mirror for local development. Old day directories under the parent
/// are pruned according to `MAX_LOG_AGE_DAYS`.
pub fn init(log_dir: &Path) -> LogGuard {
    std::fs::create_dir_all(log_dir).expect("failed to create log directory");

    if let Some(parent) = log_dir.parent() {
        cleanup(parent);
    }

    LOG_DIR
        .set(log_dir.to_path_buf())
        .expect("logging already initialized");

    let (nb, ng) = tracing_appender::non_blocking(
        SizeRollingWriter::open(&log_dir.join("desktop.log")).expect("failed to create desktop log"),
    );
    let (eb, eg) = tracing_appender::non_blocking(
        SizeRollingWriter::open(&log_dir.join("desktop.error.log")).expect("failed to create desktop error log"),
    );

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        if cfg!(debug_assertions) {
            EnvFilter::new("duoduo_lib=debug,duoduo_desktop=debug,sidecar=debug")
        } else {
            EnvFilter::new("duoduo_lib=info,duoduo_desktop=info,sidecar=info")
        }
    });

    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_writer(std::io::stderr).with_ansi(false))
        .with(
            fmt::layer()
                .with_writer(nb)
                .with_ansi(false)
                .with_filter(tracing_subscriber::filter::LevelFilter::INFO),
        )
        .with(
            fmt::layer()
                .with_writer(eb)
                .with_ansi(false)
                .with_filter(tracing_subscriber::filter::LevelFilter::ERROR),
        )
        .init();

    LogGuard(ng, eg)
}

#[allow(dead_code)]
pub fn log_dir() -> Option<PathBuf> {
    LOG_DIR.get().cloned()
}

#[allow(dead_code)]
pub fn tail() -> String {
    let Some(dir) = LOG_DIR.get() else {
        return String::new();
    };
    let path = dir.join("desktop.log");
    let Ok(file) = File::open(path) else {
        return String::new();
    };

    let lines: Vec<String> = BufReader::new(file).lines().map_while(Result::ok).collect();
    let start = lines.len().saturating_sub(TAIL_LINES);
    lines[start..].join("\n")
}

fn is_day_dir(name: &str) -> bool {
    let parts: Vec<&str> = name.split('-').collect();
    parts.len() == 3
        && parts[0].len() == 4
        && parts[1].len() == 2
        && parts[2].len() == 2
        && name.chars().all(|c| c.is_ascii_digit() || c == '-')
}

/// Remove day directories under `log_root` older than the retention window.
fn cleanup(log_root: &Path) {
    let cutoff =
        std::time::SystemTime::now() - std::time::Duration::from_secs(MAX_LOG_AGE_DAYS * 24 * 60 * 60);

    let Ok(entries) = std::fs::read_dir(log_root) else {
        return;
    };

    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_dir() {
            continue;
        }
        if !is_day_dir(&entry.file_name().to_string_lossy()) {
            continue;
        }
        let Ok(modified) = meta.modified() else {
            continue;
        };
        if modified < cutoff {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}
