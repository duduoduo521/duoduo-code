# cli-install.ps1 — DuoDuoCode CLI installer / upgrader (Windows)
#
# Served at:   https://www.dd322.cn/update/code/cli/cli.ps1
# Embedded in: the desktop app (invoked with -Binary to install the bundled sidecar)
#
# Modes:
#   * Default (no -Binary): download the matching binary from the server.
#   * -Binary <path>:       install a local sidecar binary (desktop-app flow).
#
# Parameters:
#   -Binary <path>     Install from a local binary instead of downloading.
#   -Version <ver>     Pin a version (download mode only).
#   -NoModifyPath      Skip adding the install dir to the user PATH.

[CmdletBinding()]
param(
  [string]$Binary,
  [string]$Version,
  [switch]$NoModifyPath
)

$ErrorActionPreference = "Stop"
$BASE_URL = "https://www.dd322.cn/update/code/cli"

# ─── Detect arch ───
$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
if ($arch -eq [System.Runtime.InteropServices.Architecture]::Arm64) {
    $Target = "aarch64-pc-windows-msvc"
} else {
    $Target = "x86_64-pc-windows-msvc"
}

# ─── Resolve version (param > env VERSION > latest) ───
$VERSION = if ($Version) { $Version } elseif ($env:VERSION) { $env:VERSION } else { "latest" }

$InstallDir = if ($env:DUODUO_BIN_DIR) { $env:DUODUO_BIN_DIR } else { Join-Path $HOME ".duoduo\bin" }
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}
$Dest = Join-Path $InstallDir "duoduocode-cli.exe"

if ($Binary) {
    # ─── Local install (desktop-app bundled sidecar) ───
    Write-Host "Installing local CLI binary: $Binary"
    Copy-Item -Path $Binary -Destination $Dest -Force
    Write-Host "Installed: $Dest"
} else {
    # ─── Download mode ───
    if ($VERSION -eq "latest") {
        Write-Host "Resolving latest DuoDuoCode CLI version..."
        try {
            $VERSION = (Invoke-RestMethod -Uri "$BASE_URL/latest" -UseBasicParsing).Trim()
        } catch {
            Write-Error "Failed to resolve latest version from $BASE_URL/latest"
        }
    }
    $Url = "$BASE_URL/v$VERSION/$Target/duoduocode-cli-$Target.exe"
    Write-Host "Downloading DuoDuoCode CLI $VERSION ($Target) from: $Url"
    $Tmp = Join-Path $env:TEMP ("duoduo-cli-" + [System.Guid]::NewGuid().ToString() + ".exe")
    try {
        Invoke-WebRequest -Uri $Url -OutFile $Tmp -UseBasicParsing
        Move-Item $Tmp $Dest -Force
    } finally {
        if (Test-Path $Tmp) { Remove-Item $Tmp -Force -ErrorAction SilentlyContinue }
    }
    Write-Host "Installed: $Dest"
}

# ─── Add to PATH ───
if (-not $NoModifyPath) {
    $currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($currentPath -notlike "*$InstallDir*") {
        [Environment]::SetEnvironmentVariable("Path", "$currentPath;$InstallDir", "User")
        $env:Path = "$env:Path;$InstallDir"
        Write-Host "Added $InstallDir to user PATH"
    } else {
        Write-Host "$InstallDir is already in PATH"
    }
}
