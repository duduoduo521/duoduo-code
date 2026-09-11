#!/usr/bin/env bash
# script/e2e-test-smart-layer.sh
# Smart Layer 端到端验证脚本
#
# 验证 duo-smart-layer sidecar 独立运行及核心 API 端点可用性。
#
# 用法:
#   ./script/e2e-test-smart-layer.sh              # 构建并测试
#   ./script/e2e-test-smart-layer.sh --skip-build # 跳过构建，直接测试
#
# 退出码:
#   0 - 全部通过
#   1 - 构建失败或关键端点失败

set -euo pipefail

# ─── 颜色输出 ───
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

PASS=0
FAIL=0
SKIP=0

pass() { PASS=$((PASS + 1)); echo -e "  ${GREEN}✓ PASS${NC} $1"; }
fail() { FAIL=$((FAIL + 1)); echo -e "  ${RED}✗ FAIL${NC} $1"; }
skip() { SKIP=$((SKIP + 1)); echo -e "  ${YELLOW}⊘ SKIP${NC} $1"; }
info() { echo -e "${CYAN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

# ─── 路径配置 ───
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BINARY="$WORKSPACE_ROOT/target/release/duo-smart-layer"

# ─── 清理函数 ───
cleanup() {
    if [[ -n "${PID:-}" ]] && kill -0 "$PID" 2>/dev/null; then
        info "Stopping duo-smart-layer (PID=$PID)..."
        kill "$PID" 2>/dev/null || true
        wait "$PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

# ─── Step 0: 构建 ───
if [[ "${1:-}" != "--skip-build" ]]; then
    info "Building duo-smart-layer (release)..."
    (
        cd "$WORKSPACE_ROOT"
        cargo build --release -p duo-smart-layer 2>&1
    )
    if [[ ! -f "$BINARY" ]]; then
        error "Build succeeded but binary not found at $BINARY"
        exit 1
    fi
    info "Build complete: $BINARY"
else
    info "Skipping build (--skip-build)"
    if [[ ! -f "$BINARY" ]]; then
        error "Binary not found at $BINARY. Run without --skip-build first."
        exit 1
    fi
fi

# ─── Step 1: 启动 duo-smart-layer ───
info "Starting duo-smart-layer..."
PORT=""
PID=""

# 启动进程，捕获 stdout 读取端口
# 注意：当前代码中没有 Basic Auth 中间件，DUO_SMART_LAYER_PASSWORD 环境变量
# 未被读取。保留该环境变量以备未来添加认证机制。
OUTPUT_FILE=$(mktemp)
DUO_SMART_LAYER_PASSWORD=test123 "$BINARY" > "$OUTPUT_FILE" 2>&1 &
PID=$!

# 等待 READY 信号（最多 15 秒）
READY=false
for i in $(seq 1 30); do
    if grep -q "DUO_SMART_LAYER_READY" "$OUTPUT_FILE" 2>/dev/null; then
        READY=true
        break
    fi
    if ! kill -0 "$PID" 2>/dev/null; then
        error "duo-smart-layer exited prematurely. Output:"
        cat "$OUTPUT_FILE"
        rm -f "$OUTPUT_FILE"
        exit 1
    fi
    sleep 0.5
done

if [[ "$READY" == "false" ]]; then
    error "Timed out waiting for DUO_SMART_LAYER_READY. Output so far:"
    cat "$OUTPUT_FILE"
    rm -f "$OUTPUT_FILE"
    exit 1
fi

# 解析端口：stdout 输出格式为 "DUO_SMART_LAYER_READY|port=XXXXX"
PORT=$(grep "DUO_SMART_LAYER_READY" "$OUTPUT_FILE" | sed -n 's/.*port=\([0-9]*\).*/\1/p' | head -1)
rm -f "$OUTPUT_FILE"

if [[ -z "$PORT" ]]; then
    error "Failed to parse port from DUO_SMART_LAYER_READY output"
    kill "$PID" 2>/dev/null || true
    exit 1
fi

info "duo-smart-layer running on 127.0.0.1:$PORT (PID=$PID)"

BASE_URL="http://127.0.0.1:$PORT"

# ─── 辅助函数 ───
# 当前代码无认证中间件，不需要 -u 参数
# 如未来添加 Basic Auth，取消下行注释即可
# AUTH="-u smart-layer:test123"
AUTH=""

http_get()    { curl -s $AUTH "$BASE_URL$1" 2>&1; }
http_post()   { curl -s $AUTH -X POST "$BASE_URL$1" -H "Content-Type: application/json" -d "$2" 2>&1; }
http_delete() { curl -s $AUTH -X DELETE "$BASE_URL$1" 2>&1; }

# ─── Step 2: 验证健康检查 ───
echo ""
info "=== Step 2: Health Check ==="

# GET /health
# 返回: {"status":"ok","version":"x.y.z","uptimeSeconds":0}
RESP=$(http_get "/health")
if echo "$RESP" | grep -q '"status":"ok"'; then
    pass "/health -> status=ok"
    echo "       response: $RESP"
else
    fail "/health -> unexpected response: $RESP"
fi

# ─── Step 3: 验证 Memory API ───
echo ""
info "=== Step 3: Memory API ==="

# 3a: 存储记忆
# POST /memory/store
# MemoryStoreRequest (camelCase): content, layer (u8 整数), tags, metadata
# layer 值: 0=core, 1=short_term, 2=long_term 等（存储为 SQLite INTEGER）
# 返回: {"id":"uuid","stored":true}
RESP=$(http_post "/memory/store" '{"content":"test memory entry","layer":1,"tags":["test"]}')
if echo "$RESP" | grep -q '"stored":true'; then
    MEMORY_ID=$(echo "$RESP" | grep -o '"id":"[^"]*"' | head -1 | sed 's/"id":"//;s/"//')
    pass "/memory/store -> stored=true, id=$MEMORY_ID"
    echo "       response: $RESP"
else
    MEMORY_ID=""
    fail "/memory/store -> unexpected response: $RESP"
fi

# 3b: 搜索记忆
# POST /memory/search
# MemorySearchRequest (camelCase): query, limit, layers, tags
# 返回: [MemoryEntry, ...]
RESP=$(http_post "/memory/search" '{"query":"test","limit":5}')
if echo "$RESP" | grep -q '"content"'; then
    pass "/memory/search -> found results"
    echo "       response: $RESP"
else
    fail "/memory/search -> unexpected response: $RESP"
fi

# 3c: 获取统计
# GET /memory/stats
# 返回: {"totalEntries":1,"byLayer":{"L1":1},"storageSizeBytes":...}
RESP=$(http_get "/memory/stats")
if echo "$RESP" | grep -q '"totalEntries"'; then
    pass "/memory/stats -> returned stats"
    echo "       response: $RESP"
else
    fail "/memory/stats -> unexpected response: $RESP"
fi

# 3d: 删除单条记忆
# DELETE /memory/:id
# 返回: {"deleted":1,"vacuumed":false}
if [[ -n "$MEMORY_ID" ]]; then
    RESP=$(http_delete "/memory/$MEMORY_ID")
    if echo "$RESP" | grep -q '"deleted"'; then
        pass "/memory/$MEMORY_ID (DELETE) -> deleted"
        echo "       response: $RESP"
    else
        fail "/memory/$MEMORY_ID (DELETE) -> unexpected response: $RESP"
    fi
else
    skip "/memory/:id (DELETE) — no memory ID from store step"
fi

# 3e: 再存一条用于后续按层删除测试
RESP=$(http_post "/memory/store" '{"content":"layer test entry","layer":1,"tags":["test"]}')
echo "       extra store for layer delete: $RESP"

# 3f: 删除按层
# DELETE /memory/layer/:layer  (layer 路径参数为字符串，SQLite 做 LIKE 匹配)
# 返回: {"deleted":N,"vacuumed":false}
RESP=$(http_delete "/memory/layer/1")
if echo "$RESP" | grep -q '"deleted"'; then
    pass "/memory/layer/1 (DELETE) -> deleted=$(echo "$RESP" | grep -o '"deleted":[0-9]*' | head -1)"
    echo "       response: $RESP"
else
    fail "/memory/layer/1 (DELETE) -> unexpected response: $RESP"
fi

# 3g: 清空全部
# DELETE /memory/clear
# 返回: {"deleted":0,"vacuumed":true}
RESP=$(http_delete "/memory/clear")
if echo "$RESP" | grep -q '"deleted"'; then
    pass "/memory/clear (DELETE) -> vacuumed=true"
    echo "       response: $RESP"
else
    fail "/memory/clear (DELETE) -> unexpected response: $RESP"
fi

# ─── Step 4: 结束 ───
echo ""
info "=== Cleanup ==="
info "Stopping duo-smart-layer (PID=$PID)..."
kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true
info "Process stopped."

# ─── 汇总 ───
echo ""
echo "═══════════════════════════════════════"
echo -e "  Smart Layer E2E Test Results"
echo "═══════════════════════════════════════"
echo -e "  ${GREEN}PASS${NC}: $PASS"
echo -e "  ${RED}FAIL${NC}: $FAIL"
echo -e "  ${YELLOW}SKIP${NC}: $SKIP"
echo "═══════════════════════════════════════"

if [[ $FAIL -gt 0 ]]; then
    exit 1
else
    exit 0
fi
