#!/bin/bash
# crates/duo-smart-layer/build-sidecar.sh
# 构建 duo-smart-layer 并复制到 Tauri sidecar 目录
#
# 用法:
#   ./build-sidecar.sh                    # 构建当前平台
#   ./build-sidecar.sh aarch64-apple-darwin  # 构建指定 target
#   ./build-sidecar.sh --all              # 构建所有支持的平台（需要交叉编译工具链）
#
# 产物存放于: packages/desktop/src-tauri/sidecars/duo-smart-layer-<target-triple>[.exe]
# Tauri 要求 sidecar 文件名必须包含 target triple 后缀
#
# 注意：Rust workspace root 就是本 monorepo 根目录，
# 所有 crate 源码位于 crates/。

set -euo pipefail

# ─── 路径配置 ───
# Cargo workspace root is the monorepo root, target/ is at <repo root>/target/

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DESKTOP_SIDEARS_DIR="$WORKSPACE_ROOT/packages/desktop/src-tauri/sidecars"

# ─── 颜色输出 ───

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ─── 支持的目标平台 ───

SUPPORTED_TARGETS=(
    "aarch64-apple-darwin"
    "x86_64-apple-darwin"
    "x86_64-pc-windows-msvc"
    "aarch64-pc-windows-msvc"
    "x86_64-unknown-linux-gnu"
    "aarch64-unknown-linux-gnu"
)

# ─── 构建函数 ───

build_target() {
    local target="$1"
    local ext=""

    # Windows 目标需要 .exe 后缀
    if [[ "$target" == *"windows"* ]]; then
        ext=".exe"
    fi

    info "Building duo-smart-layer for $target..."

    # 检查是否已安装 target
    if ! rustup target list --installed | grep -q "$target"; then
        warn "Target $target not installed. Installing..."
        rustup target add "$target" || error "Failed to install target $target"
    fi

    # 执行构建（从 Cargo workspace root = 仓库根）
    (
        cd "$WORKSPACE_ROOT"
        cargo build --release -p duo-smart-layer --target "$target" 2>&1 || error "Build failed for $target"
    )

    # 确定源文件路径（Cargo workspace root = 仓库根, target/ under that）
    local src="$WORKSPACE_ROOT/target/$target/release/duo-smart-layer$ext"
    if [[ ! -f "$src" ]]; then
        error "Built binary not found at $src"
    fi

    # 确保 sidecars 目录存在
    mkdir -p "$DESKTOP_SIDEARS_DIR"

    # 复制到 sidecars 目录（带 target triple 后缀）
    local dst="$DESKTOP_SIDEARS_DIR/duo-smart-layer-$target$ext"
    cp "$src" "$dst"
    chmod +x "$dst"

    local size
    size=$(du -h "$dst" | cut -f1)
    info "Copied to $dst ($size)"
}

# ─── 构建当前平台（无 --target 参数，使用默认 native target） ───

build_native() {
    local ext=""
    if [[ "$(uname -s)" == MINGW* ]] || [[ "$(uname -s)" == CYGWIN* ]] || [[ "$(uname -s)" == MSYS* ]]; then
        ext=".exe"
    fi

    info "Building duo-smart-layer for native platform..."

    (
        cd "$WORKSPACE_ROOT"
        cargo build --release -p duo-smart-layer 2>&1 || error "Native build failed"
    )

    # Native build output is in target/release/ (no target triple subdirectory)
    local src="$WORKSPACE_ROOT/target/release/duo-smart-layer$ext"
    if [[ ! -f "$src" ]]; then
        error "Built binary not found at $src"
    fi

    # Determine the native target triple for the sidecar filename
    local native_target
    native_target=$(detect_current_target)

    # 确保 sidecars 目录存在
    mkdir -p "$DESKTOP_SIDEARS_DIR"

    # 复制到 sidecars 目录（带 target triple 后缀）
    local dst="$DESKTOP_SIDEARS_DIR/duo-smart-layer-$native_target$ext"
    cp "$src" "$dst"
    chmod +x "$dst"

    local size
    size=$(du -h "$dst" | cut -f1)
    info "Copied to $dst ($size)"
}

# ─── 检测当前平台默认 target ───

detect_current_target() {
    local os="$(uname -s)"
    local arch="$(uname -m)"

    case "$os" in
        Darwin)
            if [[ "$arch" == "arm64" ]]; then
                echo "aarch64-apple-darwin"
            else
                echo "x86_64-apple-darwin"
            fi
            ;;
        Linux)
            if [[ "$arch" == "aarch64" ]]; then
                echo "aarch64-unknown-linux-gnu"
            else
                echo "x86_64-unknown-linux-gnu"
            fi
            ;;
        MINGW*|CYGWIN*|MSYS*)
            if [[ "$arch" == "arm64" ]]; then
                echo "aarch64-pc-windows-msvc"
            else
                echo "x86_64-pc-windows-msvc"
            fi
            ;;
        *)
            error "Unsupported platform: $os ($arch)"
            ;;
    esac
}

# ─── 主逻辑 ───

main() {
    info "duo-smart-layer build script"
    info "Workspace root: $WORKSPACE_ROOT"
    info "Sidecars dir: $DESKTOP_SIDEARS_DIR"
    echo ""

    # 检查 Rust 工具链
    if ! command -v cargo &>/dev/null; then
        error "cargo not found. Please install Rust toolchain."
    fi

    local cargo_version
    cargo_version=$(cargo --version 2>/dev/null || echo "unknown")
    info "Cargo version: $cargo_version"
    echo ""

    if [[ "${1:-}" == "--all" ]]; then
        # 构建所有支持的平台
        info "Building all supported targets..."
        for target in "${SUPPORTED_TARGETS[@]}"; do
            build_target "$target" || warn "Failed to build $target, skipping..."
            echo ""
        done
    elif [[ "${1:-}" == "--native" ]]; then
        # 构建当前平台（不指定 --target，使用 cargo 默认 native 编译）
        build_native
    elif [[ "${1:-}" != "" ]]; then
        # 构建指定 target
        local target="$1"
        # 验证 target
        local found=false
        for t in "${SUPPORTED_TARGETS[@]}"; do
            if [[ "$t" == "$target" ]]; then
                found=true
                break
            fi
        done
        if [[ "$found" == "false" ]]; then
            warn "Target $target is not in the officially supported list, attempting anyway..."
        fi
        build_target "$target"
    else
        # 默认：构建当前平台的 native target（最快，无需 rustup target add）
        build_native
    fi

    echo ""
    info "Build complete!"
    info "Sidecar binaries in: $DESKTOP_SIDEARS_DIR"
    ls -lh "$DESKTOP_SIDEARS_DIR"/duo-smart-layer-* 2>/dev/null || warn "No duo-smart-layer binaries found"
}

main "$@"
