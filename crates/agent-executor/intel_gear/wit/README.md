# gear-plugin 组件 SDK（WASM 后端）

本目录定义 **IntelGear WASM 后端**的插件契约，并说明如何产出一个可被宿主加载的
`gear-plugin` WebAssembly 组件。

> 状态（2026-07-23）：宿主侧路由与运行骨架**已完成并通过编译**（见
> `../../src/intel_gear/wasm_backend.rs`、`../../src/intel_gear/host.rs`、
> `../../src/intel_gear/registry.rs`：`PluginSource::Wasm` → `global_wasm_backend()` →
> `try_execute_with_ctx` 后端无关路由）。**真实 `.wasm` 组件的产出需要 wasm 工具链**，
> 因此本仓库不附带预编译组件，仅提供契约与构建指引。

---

## 1. 契约（`gear-plugin.wit`）

组件必须实现 `duoduo:gear-plugin@0.1.0` world：

```wit
world gear-plugin {
  import log: func(level: string, message: string);          // 宿主导入：诊断日志
  export load:       func() -> string;                       // -> JSON: {id, version}
  export list-tools: func() -> string;                       // -> JSON: {tools:[...]}
  export call-tool:  func(name: string, arguments: string) -> string; // -> 工具输出文本
}
```

- 所有载荷为 **JSON 字符串**，宿主 ABI 稳定、与宿主语言无关。
- `log` 是**顶层导入**（宿主以 `linker.root().func_wrap("log", …)` 链接），不要包进具名 interface。
- 提示：第一条真实组件组装时，请验证宿主侧 `linker.root().func_wrap("log", …)` 与组件导入命名一致；若有差异在此处对齐。

---

## 2. 如何产出组件（需要工具链）

> 以下步骤在**装有 wasm 工具链**的环境中执行。

### 方式 A：Rust guest（推荐）
```bash
# 一次性安装
cargo install cargo-component
rustup target add wasm32-wasip1

# 基于本 WIT 生成 guest 骨架
cd crates/agent-executor/intel_gear/wit
cargo component new --world gear-plugin echo-plugin
# 编辑 src/lib.rs 实现 load/list-tools/call-tool（TS 形态映射参考 packages/duoduo/src/plugin/SDK.md）
cd echo-plugin
cargo component build --release
# 产物：target/wasm32-wasip1/release/*.wasm
```

### 方式 B：从 WAT 组装
将组件以 WebAssembly 文本格式书写后，用 `wasm-tools` 转为二进制：
```bash
cargo install wasm-tools
wasm-tools component new echo.wat -o echo.wasm
```

---

## 3. 如何加载

把组件当普通插件 spec 传入即可——宿主按路径后缀（`.wasm` / `.wasm.component` / `.component`）
自动识别为 `PluginSource::Wasm` 并路由到 WASM 后端：

```jsonc
// gear manifest capabilities.tools 中引用，或直接用 spec：
//   plugin:./echo.wasm
```

或在代码中：
```rust
let spec = GearSpec::parse("plugin:./echo.wasm");
assert_eq!(spec.into_plugin_spec().unwrap().source, PluginSource::Wasm);
```

宿主 `install` 会调用 `global_wasm_backend().load(...)`，由 wasmtime 实例化组件，
`try_execute_with_ctx` 按 `instance_id` 命名空间（`wasm-plugin-N`）路由回该后端。

---

## 4. 落地检查清单（产出首个真实组件时）

- [ ] 安装 `cargo-component` + `wasm32-wasip1` 目标（或 `wasm-tools`）。
- [ ] 用 `gear-plugin.wit` 生成 guest，`load/list-tools/call-tool` 返回 JSON 字符串。
- [ ] 组件顶层导入 `log`（与宿主 linker 命名一致）。
- [ ] `cargo component build --release` 产出 `.wasm`。
- [ ] 在 `agent-executor` 中加一个加载该 `.wasm` 的 e2e 测试（参照 `ts_backend` 的 e2e 写法）。
- [ ] 运行 `cargo test -p agent-executor --features wasm-backend` 全绿。
