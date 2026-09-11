# IntelGear 插件 SDK（规范）

本文档定义 **IntelGear 插件的标准协议**。所有插件必须遵循此协议，`ipc-host.mjs` 在 `load` 阶段会强制校验，违反协议将被拒绝并收到指向本文件的错误。

> 设计取舍：早期 `ipc-host.mjs` 仅强制 canonical 单一形态。为兼容存量插件，现已在加载阶段回退支持多种 `server()` 历史形态（`server.tools` 数组、内部 `_tools`、`getRegisteredTools` 等），统一**归一化**为下方 **MCP 兼容契约**；运行时只认归一化后的 canonical 形态。详见 `ipc-host.mjs` 的 `extractServer`。

---

## 1. 模块形态

插件是一个 **ES module**，其 `default` 导出必须是一个对象，且包含 `server()` 方法（不支持 `tui()`，那是主 duoduo 插件体系的形态）。

```js
export default {
  server() {
    return { listTools, callTool }
  },
}
```

`server()` 必须返回一个对象，且**同时**提供：

| 方法 | 签名 | 职责 |
|------|------|------|
| `listTools` | `async () => ({ tools: ToolDef[] })` | 返回工具清单 |
| `callTool`   | `async ({ name, arguments: args }) => ({ content: ContentBlock[] })` | 调用指定工具。`arguments` 为保留字，在 ES module 严格模式下必须重命名为 `args` |

缺少任一方法 → `load` 失败，错误示例：
`Plugin "x" server() must expose listTools() (canonical IntelGear plugin protocol — see SDK.md)`。

---

## 2. `ToolDef`（工具定义）

```ts
type ToolDef = {
  name: string                                   // 必填，工具唯一名
  description?: string                            // 可选，给模型的说明
  inputSchema?: JSONSchema                        // 可选，默认 { type: "object", properties: {} }
}
```

`inputSchema` 遵循 JSON Schema（draft-07 子集）。`ipc-host.mjs` 在 `listTools` 未提供 `inputSchema` 时会回退到 `{ type: "object", properties: {} }`。

---

## 3. `callTool` 入参 / 返回

**入参**：`{ name: string, arguments: Record<string, unknown> }`，`arguments` 即模型产出的工具调用参数（可能缺失，宿主侧会以 `{}` 兜底）。

**返回**（MCP 风格）：
```ts
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "json"; data: unknown }

type CallToolResult = { content: ContentBlock[] }
```

`ipc-host.mjs` 会将 `content` 数组规范化为纯文本：
- `text` 块 → 原样文本
- `json` 块 → `JSON.stringify(data)`
- 多块以换行拼接

若 `callTool` 直接返回字符串或对象，也会被尽力序列化。

---

## 4. 完整示例

```js
export default {
  server() {
    return {
      listTools: async () => ({
        tools: [
          {
            name: "echo",
            description: "Echo back the provided message.",
            inputSchema: {
              type: "object",
              properties: { msg: { type: "string" } },
              required: ["msg"],
            },
          },
        ],
      }),
      callTool: async ({ name, arguments: args }) => {
        if (name !== "echo") throw new Error(`unknown tool ${name}`)
        return { content: [{ type: "text", text: `ECHO:${args?.msg ?? ""}` }] }
      },
    }
  },
}
```

可参考 `samples/echo.mjs` 与 `samples/greet.mjs`。

---

## 5. 插件来源（spec）

`load` 的 `spec` 支持三种来源：

| 形式 | 示例 | 解析方式 |
|------|------|----------|
| `file://` URL | `file:///abs/plugin.mjs` | 直接载入 |
| 相对/绝对路径 | `./my-plugin` `/abs/plugin.mjs` | `path.resolve` |
| npm 包名 | `my-gear-plugin` | 先尝试 `require.resolve`，失败则**自动安装**到隔离缓存目录（见下） |

### 自动安装（硬化）
- 隔离缓存目录：环境变量 `IG_NPM_CACHE_DIR`，未设置则使用 `os.tmpdir()` 下的临时目录，**绝不污染宿主工作目录**。
- 安装命令：`npm install --no-save --no-package-lock --prefix <cacheDir> <spec>`，使用 `execFile`（无 shell 注入）。
- 超时：环境变量 `IG_NPM_INSTALL_TIMEOUT_MS`，默认 `120000`（ms）。
- 安装失败时返回清晰错误（含 `npm` stderr）。

---

## 6. 生命周期（JSON-RPC）

宿主（`ipc-host.mjs`）以「行分隔 JSON-RPC 2.0」在 stdin/stdout 上与 Rust `GearHost` 通信：

```
→ {"jsonrpc":"2.0","id":1,"method":"load","params":{"spec":"./p","kind":"server"}}
← {"jsonrpc":"2.0","id":1,"result":{"instance":"ts-plugin-1","tools":[...]}}

→ {"jsonrpc":"2.0","id":2,"method":"call","params":{"instance":"ts-plugin-1","tool":"echo","args":{"msg":"hi"}}}
← {"jsonrpc":"2.0","id":2,"result":"ECHO:hi"}

→ {"jsonrpc":"2.0","id":3,"method":"unload","params":{"instance":"ts-plugin-1"}}
← {"jsonrpc":"2.0","id":3,"result":null}
```

`ipc-host.mjs` 不暴露任何 HTTP 接口或管理路由。

---

## 7. WASM 组件插件（替代 TS 后端）

除了上面的 TS/IPC 插件，IntelGear 还支持 **WASM 组件插件**：用任意语言编译出的
`gear-plugin` WebAssembly 组件，由宿主的 `WasmBackend`（wasmtime 组件模型）加载与执行。

- 契约定义：`crates/agent-executor/intel_gear/wit/gear-plugin.wit`（`duoduo:gear-plugin@0.1.0` world）。
- 构建/加载指引：`crates/agent-executor/intel_gear/wit/README.md`。
- 宿主路由：spec 路径后缀为 `.wasm` / `.component` / `.wasm.component` 时，
  `GearSpec::into_plugin_spec` 将其标为 `PluginSource::Wasm`，`GearHost::install`
  据此路由到 `global_wasm_backend()`；`try_execute_with_ctx` 按 `instance_id`
  命名空间（`wasm-plugin-N`）后端无关地回路由。

> 与 TS 插件的关系：二者共享同一套 `PluginRef` / `ToolExecutor::Plugin` 抽象，
> 模型侧无需感知后端差异；区别仅在 `install` 时的加载器与执行时的实例归属。
