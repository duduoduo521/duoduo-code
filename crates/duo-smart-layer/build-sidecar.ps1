# crates/duo-smart-layer/build-sidecar.ps1
# PowerShell equivalent of build-sidecar.sh for Windows native development.
#
# Usage:
#   .\build-sidecar.ps1                                    # Build current platform
#   .\build-sidecar.ps1 -Target x86_64-pc-windows-msvc     # Build specific target
#   .\build-sidecar.ps1 -All                               # Build all supported platforms
#
# Artifacts: packages/desktop/src-tauri/sidecars/duo-smart-layer-<target-triple>[.exe]
# Tauri requires sidecar filenames to include the target triple suffix.
#
# Note: The Rust workspace root is this monorepo root.
# All crate sources live under crates/.

param(
    [string]$Target = "",
    [switch]$All
)

$ErrorActionPreference = "Stop"

# ─── Path configuration ───
# Cargo workspace root is the monorepo root, target/ is at <repo root>/target/

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$WorkspaceRoot = Resolve-Path (Join-Path $ScriptDir "..\..")
$SidecarsDir = Join-Path $WorkspaceRoot "packages\desktop\src-tauri\sidecars"

# ─── Color output ───

function Write-Info($msg)  { Write-Host "[INFO] $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Err($msg)   { Write-Host "[ERROR] $msg" -ForegroundColor Red; exit 1 }

# ─── Supported targets ───

$SupportedTargets = @(
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc",
    "aarch64-pc-windows-msvc",
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu"
)

# ─── Detect current platform default target ───

function Get-NativeTarget {
    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture

    if ($IsMacOS) {
        if ($arch -eq "Arm64") { return "aarch64-apple-darwin" }
        else { return "x86_64-apple-darwin" }
    }
    elseif ($IsLinux) {
        if ($arch -eq "Arm64") { return "aarch64-unknown-linux-gnu" }
        else { return "x86_64-unknown-linux-gnu" }
    }
    elseif ($IsWindows -or $env:OS -eq "Windows_NT") {
        if ($arch -eq "Arm64") { return "aarch64-pc-windows-msvc" }
        else { return "x86_64-pc-windows-msvc" }
    }
    Write-Err "Unsupported platform"
}

# ─── Build for a specific target triple ───

function Build-Target($target) {
    $ext = ""
    # Windows targets need .exe suffix
    if ($target -match "windows") {
        $ext = ".exe"
    }

    Write-Info "Building duo-smart-layer for $target..."

    # Check if target is installed
    $installed = rustup target list --installed 2>$null
    if ($installed -notcontains $target) {
        Write-Warn "Target $target not installed. Installing..."
        rustup target add $target
        if ($LASTEXITCODE -ne 0) { Write-Err "Failed to install target $target" }
    }

    # Build from the Cargo workspace root (repo root)
    Push-Location $WorkspaceRoot
    try {
        cargo build --release -p duo-smart-layer --target $target 2>&1
        if ($LASTEXITCODE -ne 0) { Write-Err "Build failed for $target" }
    }
    finally {
        Pop-Location
    }

    # Determine source binary path (Cargo workspace root = repo root, target/ under that)
    $src = Join-Path $WorkspaceRoot "target\$target\release\duo-smart-layer$ext"
    if (-not (Test-Path $src)) {
        Write-Err "Built binary not found at $src"
    }

    # Ensure sidecars directory exists
    if (-not (Test-Path $SidecarsDir)) {
        New-Item -ItemType Directory -Path $SidecarsDir -Force | Out-Null
    }

    # Copy to sidecars directory with target triple suffix
    $dst = Join-Path $SidecarsDir "duo-smart-layer-$target$ext"
    Copy-Item $src $dst -Force

    $size = (Get-Item $dst).Length
    Write-Info "Copied to $dst ($size bytes)"
}

# ─── Build for native platform (no --target flag, uses cargo default native compilation) ───

function Build-Native {
    $ext = ""
    if ($IsWindows -or $env:OS -eq "Windows_NT") { $ext = ".exe" }

    Write-Info "Building duo-smart-layer for native platform..."

    Push-Location $WorkspaceRoot
    try {
        cargo build --release -p duo-smart-layer 2>&1
        if ($LASTEXITCODE -ne 0) { Write-Err "Native build failed" }
    }
    finally {
        Pop-Location
    }

    # Native build output is in target/release/ (no target triple subdirectory)
    $src = Join-Path $WorkspaceRoot "target\release\duo-smart-layer$ext"
    if (-not (Test-Path $src)) {
        Write-Err "Built binary not found at $src"
    }

    # Determine the native target triple for the sidecar filename
    $nativeTarget = Get-NativeTarget

    # Ensure sidecars directory exists
    if (-not (Test-Path $SidecarsDir)) {
        New-Item -ItemType Directory -Path $SidecarsDir -Force | Out-Null
    }

    # Copy to sidecars directory with target triple suffix
    $dst = Join-Path $SidecarsDir "duo-smart-layer-$nativeTarget$ext"
    Copy-Item $src $dst -Force

    $size = (Get-Item $dst).Length
    Write-Info "Copied to $dst ($size bytes)"
}

# ─── Main logic ───

Write-Info "duo-smart-layer build script (PowerShell)"
Write-Info "Workspace root: $WorkspaceRoot"
Write-Info "Sidecars dir: $SidecarsDir"
Write-Host ""

# Check Rust toolchain
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Err "cargo not found. Please install Rust toolchain."
}

$cargoVersion = cargo --version 2>$null
Write-Info "Cargo version: $cargoVersion"
Write-Host ""

if ($All) {
    # Build all supported platforms
    Write-Info "Building all supported targets..."
    foreach ($t in $SupportedTargets) {
        try {
            Build-Target $t
        }
        catch {
            Write-Warn "Failed to build $t, skipping..."
        }
        Write-Host ""
    }
}
elseif ($Target -ne "") {
    # Build specified target
    if ($SupportedTargets -notcontains $Target) {
        Write-Warn "Target $Target is not in the officially supported list, attempting anyway..."
    }
    Build-Target $Target
}
else {
    # Default: build native platform (fastest, no rustup target add needed)
    Build-Native
}

Write-Host ""
Write-Info "Build complete!"
Write-Info "Sidecar binaries in: $SidecarsDir"
if (Test-Path $SidecarsDir) {
    Get-ChildItem (Join-Path $SidecarsDir "duo-smart-layer-*") | ForEach-Object {
        Write-Host "  $($_.Name) ($($_.Length) bytes)"
    }
}
