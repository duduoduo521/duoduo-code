#!/usr/bin/env bash
#
# DuoDuoCode CLI installer / upgrader
#
# Served at:   https://www.dd322.cn/update/code/cli/cli
# Embedded in: the desktop app (invoked with --binary to install the bundled sidecar)
#
# Two modes:
#   * Default (no --binary): download the matching binary from the server.
#   * --binary <path>:       install a local sidecar binary (desktop-app flow).
#
# Flags:
#   --binary <path>        Install from a local binary instead of downloading.
#   --no-modify-path       Skip the PATH hint / modification.
#   -v, --version <ver>    Pin a version (download mode only).

set -euo pipefail

BASE_URL="https://www.dd322.cn/update/code/cli"

LOCAL_BINARY=""
NO_MODIFY_PATH=0
PINNED_VERSION=""

while [ $# -gt 0 ]; do
  case "$1" in
    --binary)          LOCAL_BINARY="$2"; shift 2 ;;
    --no-modify-path)  NO_MODIFY_PATH=1; shift ;;
    -v|--version)      PINNED_VERSION="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# ── Resolve target triple from the running OS/arch ────────────────────────────
detect_target() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin)
      case "$arch" in
        arm64|aarch64) echo "aarch64-apple-darwin" ;;
        x86_64)        echo "x86_64-apple-darwin" ;;
        *) echo "unsupported: darwin/$arch" >&2; exit 1 ;;
      esac ;;
    Linux)
      case "$arch" in
        x86_64|amd64) echo "x86_64-unknown-linux-gnu" ;;
        *) echo "unsupported: linux/$arch" >&2; exit 1 ;;
      esac ;;
    MINGW*|MSYS*|CYGWIN*)
      case "$arch" in
        x86_64|amd64) echo "x86_64-pc-windows-msvc" ;;
        *) echo "unsupported: windows/$arch" >&2; exit 1 ;;
      esac ;;
    *) echo "unsupported OS: $os" >&2; exit 1 ;;
  esac
}

TARGET="$(detect_target)"

INSTALL_DIR="${DUODUO_BIN_DIR:-$HOME/.duoduo/bin}"
BIN_NAME="duoduocode-cli"
EXT=""
case "$TARGET" in
  *windows*) BIN_NAME="duoduocode-cli.exe"; EXT=".exe" ;;
esac

mkdir -p "$INSTALL_DIR"
DEST="$INSTALL_DIR/$BIN_NAME"

if [ -n "$LOCAL_BINARY" ]; then
  # ── Local install (desktop-app bundled sidecar) ──
  echo "Installing local CLI binary: $LOCAL_BINARY"
  cp "$LOCAL_BINARY" "$DEST"
  chmod +x "$DEST" 2>/dev/null || true
  echo "Installed: $DEST"
else
  # ── Download mode ──
  VERSION="${PINNED_VERSION:-${VERSION:-}}"
  if [ -z "$VERSION" ] || [ "$VERSION" = "latest" ]; then
    echo "Resolving latest DuoDuoCode CLI version..."
    if command -v curl >/dev/null 2>&1; then
      VERSION="$(curl -fsSL "$BASE_URL/latest")"
    elif command -v wget >/dev/null 2>&1; then
      VERSION="$(wget -qO- "$BASE_URL/latest")"
    else
      echo "error: neither curl nor wget is available" >&2
      exit 1
    fi
    if [ -z "$VERSION" ]; then
      echo "error: failed to resolve latest version from $BASE_URL/latest" >&2
      exit 1
    fi
  fi

  URL="$BASE_URL/v$VERSION/$TARGET/duoduocode-cli-$TARGET$EXT"
  TMP_FILE="$(mktemp)"
  trap 'rm -f "$TMP_FILE"' EXIT
  echo "Downloading DuoDuoCode CLI $VERSION ($TARGET) from: $URL"
  if command -v curl >/dev/null 2>&1; then
    curl -fL "$URL" -o "$TMP_FILE"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$TMP_FILE" "$URL"
  else
    echo "error: neither curl nor wget is available" >&2
    exit 1
  fi
  if [ "$(uname -s)" = "Darwin" ]; then
    xattr -c "$TMP_FILE" 2>/dev/null || true
  fi
  chmod +x "$TMP_FILE"
  mv "$TMP_FILE" "$DEST"
  trap - EXIT
  echo "Installed: $DEST"
fi

# ── Report / PATH hint ──
if [ "$NO_MODIFY_PATH" -eq 0 ]; then
  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *)
      echo
      echo "NOTE: $INSTALL_DIR is not on your PATH."
      echo "Add it to your shell profile, e.g.:"
      echo "  export PATH=\"\$HOME/.duoduo/bin:\$PATH\""
      ;;
  esac
fi
