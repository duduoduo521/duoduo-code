//! E2E test for the three gear kinds, exercised through the real loaders:
//!   - Skill  型：纯指令，`/<name>` 激活后注入 system prompt
//!   - Plugin 型：本地 `.mjs` 经 `ipc-host.mjs` 子进程暴露工具
//!   - MCP    型：本地 `mcp-server.mjs` 子进程经 stdio JSON-RPC 暴露工具
//!
//! ## Why the fixtures are generated instead of read from `duoduocode-gears`
//!
//! This test used to point `DUODUO_GEARS_DIR` at an external `duoduocode-gears`
//! checkout resolved as `CARGO_MANIFEST_DIR/../../../..` (a path that dates back
//! to a `d:/duoduo-ide-zed` layout). That repository is not part of this one, so
//! the loader found zero gears and the very first assertion failed. A test that
//! can only pass on a machine holding an unavailable sibling checkout verifies
//! nothing on every other machine.
//!
//! The gear packs are now written into a temp dir by the test itself. This keeps
//! the *whole* real pipeline under test — manifest parse/validate, kind-specific
//! `GearSpec` construction, `install_spec`, the live `node` child process for
//! both the plugin IPC host and the MCP stdio server, the JSON-RPC handshake,
//! tool discovery and an actual tool invocation. Nothing is mocked; only the
//! fixture *source* moved from an external checkout into the test.
//!
//! The MCP connection and the TS backend are process-global singletons that
//! spawn long-lived child processes. If we don't tear them down, a background
//! reader task never terminates and the test binary hangs forever. So we clean
//! up at the end via `shutdown_gear_mcp` / `LegacyTsBackend::shutdown`.

use std::path::Path;

use agent_executor::intel_gear::host::GearHost;
use agent_executor::intel_gear::manifest::GearKind;
use agent_executor::intel_gear::ts_backend::global_ts_backend;
use agent_executor::mcp::{
    call_mcp_tool, ensure_gear_mcp_from_dir, mcp_tool_definitions, shutdown_gear_mcp,
};
use serde_json::json;

/// A minimal MCP stdio server: newline-delimited JSON-RPC on stdin/stdout,
/// implementing just `initialize`, `tools/list` and `tools/call` — enough for
/// the real client in `mcp.rs` to handshake and invoke a tool.
const MCP_SERVER_MJS: &str = r#"
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let req;
  try { req = JSON.parse(text); } catch { return; }
  const { id, method, params } = req;
  // Notifications carry no id and expect no reply.
  if (id === undefined || id === null) return;

  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "example-mcp", version: "0.1.0" },
    }});
    return;
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: [{
      name: "mcp_reverse",
      description: "Reverse the provided text.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "text to reverse" } },
        required: ["text"],
      },
    }]}});
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    if (name !== "mcp_reverse") {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool ${name}` } });
      return;
    }
    const input = params?.arguments?.text ?? "";
    const reversed = [...input].reverse().join("");
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: reversed }] } });
    return;
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
});
"#;

/// A plugin following the canonical `server()` SDK contract (same shape as
/// `packages/duoduo/src/plugin/samples/echo.mjs`).
const PLUGIN_MJS: &str = r#"
export default {
  server() {
    return {
      listTools: async () => ({
        tools: [{
          name: "example_upper",
          description: "Uppercase the provided text.",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string", description: "text to uppercase" } },
            required: ["text"],
          },
        }],
      }),
      callTool: async ({ name, arguments: args }) => {
        if (name !== "example_upper") throw new Error(`unknown tool ${name}`);
        return { content: [{ type: "text", text: String(args?.text ?? "").toUpperCase() }] };
      },
    };
  },
};
"#;

/// Write the three example gear packs into `root`.
fn write_example_gears(root: &Path) {
    // ── example-skill: instruction-only, command-activated ──────────────
    let skill = root.join("example-skill");
    std::fs::create_dir_all(&skill).expect("mkdir example-skill");
    std::fs::write(
        skill.join("manifest.toml"),
        r#"[meta]
name = "example-skill"
version = "0.1.0"
description = "示例 Skill 智械"
author = "test"
kind = "skill"
activation = "command"

[capabilities]
instructions = true
"#,
    )
    .expect("write skill manifest");
    std::fs::write(
        skill.join("instructions.md"),
        "# 示例 Skill 智械\n\n这是一个用于端到端测试的示例 Skill 指令。\n",
    )
    .expect("write skill instructions");

    // ── example-plugin: local .mjs loaded through the TS IPC host ───────
    let plugin = root.join("example-plugin");
    std::fs::create_dir_all(&plugin).expect("mkdir example-plugin");
    std::fs::write(
        plugin.join("manifest.toml"),
        r#"[meta]
name = "example-plugin"
version = "0.1.0"
description = "示例 Plugin 智械"
author = "test"
kind = "plugin"

[connection]
plugin_source = "file"
plugin_path = "plugin.mjs"
"#,
    )
    .expect("write plugin manifest");
    std::fs::write(plugin.join("plugin.mjs"), PLUGIN_MJS).expect("write plugin.mjs");

    // ── example-mcp: stdio MCP server declared via tools/mcp.json ───────
    let mcp = root.join("example-mcp");
    std::fs::create_dir_all(mcp.join("tools")).expect("mkdir example-mcp/tools");
    std::fs::write(
        mcp.join("manifest.toml"),
        r#"[meta]
name = "example-mcp"
version = "0.1.0"
description = "示例 MCP 智械"
author = "test"
kind = "mcp"

[connection]
mcp_server_key = "example-mcp"
"#,
    )
    .expect("write mcp manifest");
    std::fs::write(mcp.join("mcp-server.mjs"), MCP_SERVER_MJS).expect("write mcp-server.mjs");
    // `scan_specs` reads `<gear>/tools/mcp.json`; the server is spawned with the
    // gear dir as cwd, so a relative script path resolves correctly.
    std::fs::write(
        mcp.join("tools").join("mcp.json"),
        r#"{ "kind": "stdio", "command": "node", "args": ["mcp-server.mjs"] }"#,
    )
    .expect("write mcp.json");
}

#[tokio::test]
async fn e2e_example_gears_full_lifecycle() {
    // Minimal logging so test output stays readable.
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_test_writer()
        .try_init();

    let tmp = tempfile::tempdir().expect("create temp gears dir");
    write_example_gears(tmp.path());

    // Point the loader at the example gears (read by `GearHost::new`).
    unsafe {
        std::env::set_var("DUODUO_GEARS_DIR", tmp.path());
    }

    let host = GearHost::new();
    host.load_all().await;

    // 1) All three gears are discovered with the correct kinds.
    let detailed = host.list_detailed();
    let by_name = |n: &str| detailed.iter().find(|g| g.name == n);

    let skill = by_name("example-skill").expect("example-skill should be loaded");
    let plugin = by_name("example-plugin").expect("example-plugin should be loaded");
    let mcp = by_name("example-mcp").expect("example-mcp should be loaded");

    assert_eq!(skill.kind, GearKind::Skill);
    assert_eq!(plugin.kind, GearKind::Plugin);
    assert_eq!(mcp.kind, GearKind::Mcp);

    // 2) Skill gear: command-activated instruction injection.
    let injected_before: Vec<_> = host
        .injector
        .snapshot_instructions()
        .into_iter()
        .filter(|i| i.name.as_deref() == Some("example-skill"))
        .collect();
    assert!(
        injected_before.is_empty(),
        "skill must not be injected before activation"
    );

    host.activate_command_by_name("example-skill")
        .expect("activate example-skill");

    let injected: Vec<_> = host
        .injector
        .snapshot_instructions()
        .into_iter()
        .filter(|i| i.name.as_deref() == Some("example-skill"))
        .collect();
    assert_eq!(injected.len(), 1, "skill should be injected exactly once");
    assert!(
        injected[0].content.contains("示例 Skill 智械"),
        "injected content should contain the skill instructions"
    );

    // 3) Plugin gear: the tool is registered into the unified gear registry.
    assert!(
        agent_executor::intel_gear::registry::global()
            .definitions()
            .iter()
            .any(|d| d.function.name == "example_upper"),
        "plugin tool example_upper should be registered"
    );

    // 4) MCP gear: connect live, discover the tool, and actually call it.
    ensure_gear_mcp_from_dir(tmp.path()).await;

    let defs = mcp_tool_definitions();
    let mcp_tool = defs
        .iter()
        .find(|d| d.function.name == "mcp__example-mcp__mcp_reverse")
        .expect("mcp tool should be discovered");
    assert!(
        !mcp_tool.function.description.is_empty(),
        "mcp tool should have a description"
    );

    let result = call_mcp_tool("mcp__example-mcp__mcp_reverse", &json!({"text": "abc"}))
        .await
        .expect("mcp tool call should succeed");
    assert!(
        result.contains("cba"),
        "mcp_reverse(\"abc\") should contain \"cba\", got: {result}"
    );

    // 5) Cleanup: kill the persistent child processes so the test binary can
    //    exit (otherwise the background MCP reader task blocks shutdown).
    shutdown_gear_mcp().await;
    global_ts_backend().shutdown().await;
}
