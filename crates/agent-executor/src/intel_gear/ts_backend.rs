//! LegacyTsBackend — controlled TS plugin subprocess lifecycle.
//!
//! Spawns a Node.js child process running `plugin-ipc-host.mjs` and
//! communicates via newline-delimited JSON-RPC over stdin/stdout — the
//! same transport pattern as `mcp.rs` stdio MCP servers.
//!
//! ## Lifecycle
//!
//! ```text
//! TsBackend::new()
//!   └─ (lazy) first load() spawns child process
//!        └─ child runs ipc-host.mjs, sends "ready" signal
//!   └─ load(spec)  → JSON-RPC "load"  → child imports plugin, returns tools
//!   └─ call(...)   → JSON-RPC "call"  → child invokes tool, returns result
//!   └─ unload(id)  → JSON-RPC "unload" → child cleans up; exits if empty
//! ```
//!
//! The child process is spawned with `node <path>/ipc-host.mjs` with a
//! **whitelisted environment** (see `ENV_WHITELIST`): host credentials such
//! as API keys are NOT inherited. It is killed when TsBackend is dropped or
//! when all plugins are unloaded.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

use super::backend::{
    GearToolDefinition, PluginBackend, PluginLoadResult, PluginRef, PluginSpec,
};

/// Controlled TS plugin backend — spawns `ipc-host.mjs` as a child process.
///
/// The child process runs the existing duoduo plugin system (PluginLoader)
/// and exposes tools via JSON-RPC over stdio.
pub struct LegacyTsBackend {
    /// Path to the ipc-host.mjs script.
    host_script: PathBuf,
    /// The child process handle (lazy — spawned on first load).
    child: Mutex<Option<Child>>,
    /// Stdin handle for writing JSON-RPC requests.
    stdin: Mutex<Option<ChildStdin>>,
    /// Stdout reader for reading JSON-RPC responses.
    stdout: Mutex<Option<BufReader<ChildStdout>>>,
    /// Loaded plugin instances: instance_id → PluginRef.
    instances: Mutex<HashMap<String, PluginRef>>,
    /// JSON-RPC request id counter.
    next_id: AtomicU64,
}

impl LegacyTsBackend {
    /// Create a new TS backend with the path to the ipc-host.mjs script.
    pub fn new(host_script: PathBuf) -> Self {
        Self {
            host_script,
            child: Mutex::new(None),
            stdin: Mutex::new(None),
            stdout: Mutex::new(None),
            instances: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }

    /// Create a TS backend with the default host script path.
    ///
    /// Resolves `packages/duoduo/src/plugin/ipc-host.mjs` relative to
    /// the current working directory or the workspace root.
    pub fn with_default_host() -> Self {
        let candidates = [
            PathBuf::from("packages/duoduo/src/plugin/ipc-host.mjs"),
            PathBuf::from("../packages/duoduo/src/plugin/ipc-host.mjs"),
            PathBuf::from("../../packages/duoduo/src/plugin/ipc-host.mjs"),
        ];

        for candidate in &candidates {
            if candidate.exists() {
                return Self::new(candidate.clone());
            }
        }

        // Fallback: use the relative path (will fail at spawn time if not found)
        Self::new(candidates[0].clone())
    }

    /// Ensure the child process is running. Spawns it if not already started.
    async fn ensure_child(&self) -> Result<(), String> {
        let mut child_guard = self.child.lock().await;
        if child_guard.is_some() {
            return Ok(());
        }

        let node_bin = if cfg!(windows) { "node.exe" } else { "node" };

        let mut cmd = Command::new(node_bin);
        cmd.arg(&self.host_script);
        // Fail-closed environment: start empty, re-add whitelisted vars only.
        // The whitelist lives in duo-utils so the shell tool and this plugin
        // host cannot drift apart (see `duo_utils::env`).
        cmd.env_clear();
        for (key, value) in duo_utils::env::sanitized_env_vars() {
            cmd.env(key, value);
        }
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::null());
        cmd.kill_on_drop(true);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn ipc-host: {e}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to capture child stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to capture child stdout".to_string())?;

        *self.stdin.lock().await = Some(stdin);
        *self.stdout.lock().await = Some(BufReader::new(stdout));
        *child_guard = Some(child);

        // Wait for the "ready" signal from the child
        self.wait_for_ready().await?;

        Ok(())
    }

    /// Wait for the child process to send the "ready" signal.
    async fn wait_for_ready(&self) -> Result<(), String> {
        let mut stdout_guard = self.stdout.lock().await;
        let reader = stdout_guard
            .as_mut()
            .ok_or_else(|| "No stdout reader".to_string())?;

        let mut line = String::new();
        let timeout = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            reader.read_line(&mut line),
        )
        .await
        .map_err(|_| "Timeout waiting for ipc-host ready signal".to_string())?
        .map_err(|e| format!("Failed to read ready signal: {e}"))?;

        if timeout == 0 {
            return Err("ipc-host closed stdout before ready".to_string());
        }

        let msg: Value = serde_json::from_str(line.trim())
            .map_err(|e| format!("Invalid ready message: {e}"))?;
        if msg.get("method").and_then(|m| m.as_str()) != Some("ready") {
            return Err(format!("Expected ready signal, got: {}", line.trim()));
        }

        Ok(())
    }

    /// Send a JSON-RPC request and wait for the response.
    async fn send_request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.ensure_child().await?;

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });

        // Write request to child stdin
        {
            let mut stdin_guard = self.stdin.lock().await;
            let stdin = stdin_guard
                .as_mut()
                .ok_or_else(|| "No stdin writer".to_string())?;
            let mut data = serde_json::to_string(&request)
                .map_err(|e| format!("Failed to serialize request: {e}"))?;
            data.push('\n');
            stdin
                .write_all(data.as_bytes())
                .await
                .map_err(|e| format!("Failed to write to child stdin: {e}"))?;
            stdin
                .flush()
                .await
                .map_err(|e| format!("Failed to flush child stdin: {e}"))?;
        }

        // Read response from child stdout
        {
            let mut stdout_guard = self.stdout.lock().await;
            let reader = stdout_guard
                .as_mut()
                .ok_or_else(|| "No stdout reader".to_string())?;

            let mut line = String::new();
            let timeout = tokio::time::timeout(
                std::time::Duration::from_secs(30),
                reader.read_line(&mut line),
            )
            .await
            .map_err(|_| format!("Timeout waiting for {method} response"))?
            .map_err(|e| format!("Failed to read response: {e}"))?;

            if timeout == 0 {
                return Err(format!("Child closed stdout during {method}"));
            }

            let response: Value = serde_json::from_str(line.trim())
                .map_err(|e| format!("Invalid JSON-RPC response: {e}"))?;

            if let Some(error) = response.get("error") {
                let message = error
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("unknown error");
                return Err(format!("{method} error: {message}"));
            }

            Ok(response.get("result").cloned().unwrap_or(Value::Null))
        }
    }

    /// Kill the child process.
    async fn kill_child(&self) {
        let mut child_guard = self.child.lock().await;
        if let Some(mut child) = child_guard.take() {
            let _ = child.kill().await;
        }
        *self.stdin.lock().await = None;
        *self.stdout.lock().await = None;
    }
}

impl PluginBackend for LegacyTsBackend {
    async fn load(&self, spec: &PluginSpec) -> anyhow::Result<PluginLoadResult> {
        let target = spec
            .path
            .as_ref()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| spec.name.clone());

        let result = self
            .send_request(
                "load",
                serde_json::json!({
                    "spec": target,
                    "kind": "server",
                }),
            )
            .await
            .map_err(|e| anyhow::anyhow!(e))?;

        let instance_id = result
            .get("instance")
            .and_then(|i| i.as_str())
            .ok_or_else(|| anyhow::anyhow!("load response missing 'instance'"))?
            .to_string();

        let tools: Vec<GearToolDefinition> = result
            .get("tools")
            .and_then(|t| t.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|t| {
                        Some(GearToolDefinition {
                            name: t.get("name")?.as_str()?.to_string(),
                            description: t
                                .get("description")
                                .and_then(|d| d.as_str())
                                .unwrap_or("")
                                .to_string(),
                            input_schema: t
                                .get("input_schema")
                                .cloned()
                                .unwrap_or_else(|| {
                                    serde_json::json!({"type":"object","properties":{}})
                                }),
                            annotations: None,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        let plugin_ref = PluginRef {
            spec: spec.clone(),
            backend: "ts".to_string(),
            instance_id: instance_id.clone(),
        };

        self.instances
            .lock()
            .await
            .insert(instance_id, plugin_ref.clone());

        Ok(PluginLoadResult {
            plugin: plugin_ref,
            tools,
        })
    }

    async fn call(&self, plugin: &PluginRef, tool: &str, args: &Value) -> anyhow::Result<String> {
        let result = self
            .send_request(
                "call",
                serde_json::json!({
                    "instance": plugin.instance_id,
                    "tool": tool,
                    "args": args,
                }),
            )
            .await
            .map_err(|e| anyhow::anyhow!(e))?;

        Ok(match &result {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        })
    }

    async fn unload(&self, plugin: &PluginRef) -> anyhow::Result<()> {
        self.send_request(
            "unload",
            serde_json::json!({ "instance": plugin.instance_id }),
        )
        .await
        .map_err(|e| anyhow::anyhow!(e))?;

        self.instances.lock().await.remove(&plugin.instance_id);

        // If no more instances, kill the child process
        if self.instances.lock().await.is_empty() {
            self.kill_child().await;
        }

        Ok(())
    }
}

impl LegacyTsBackend {
    /// Get a loaded plugin instance by its instance_id.
    pub async fn get_instance(&self, instance_id: &str) -> Option<PluginRef> {
        self.instances.lock().await.get(instance_id).cloned()
    }

    /// Kill the child process and clear loaded instances. Intended for cleanup
    /// (e.g. at the end of integration tests): the global backend is a
    /// process-global singleton whose `ipc-host` child would otherwise outlive
    /// the test binary.
    pub async fn shutdown(&self) {
        self.kill_child().await;
        self.instances.lock().await.clear();
    }
}

impl Drop for LegacyTsBackend {
    fn drop(&mut self) {
        if let Ok(mut child_guard) = self.child.try_lock()
            && let Some(mut child) = child_guard.take() {
                let _ = child.start_kill();
            }
    }
}

/// Process-global TS backend singleton. Initialized once (lazily on first access
/// or explicitly by `GearHost::new`), shared across all runs. This lets
/// `GearToolRegistry::try_execute_with_ctx` route Plugin tool calls back to the
/// subprocess without threading a GearHost reference through `dispatch()`.
static GLOBAL_TS_BACKEND: std::sync::OnceLock<Arc<LegacyTsBackend>> = std::sync::OnceLock::new();

/// Get the global TS backend (created on first access).
pub fn global_ts_backend() -> Arc<LegacyTsBackend> {
    GLOBAL_TS_BACKEND
        .get_or_init(|| Arc::new(LegacyTsBackend::with_default_host()))
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ts_backend_new() {
        let backend = LegacyTsBackend::with_default_host();
        // Just verify construction doesn't panic
        let _ = backend;
    }

    #[tokio::test]
    async fn ts_backend_list_empty() {
        let backend = LegacyTsBackend::with_default_host();
        let list = backend.instances.lock().await;
        assert!(list.is_empty());
    }

    /// End-to-end integration test for the Plugin IPC path.
    ///
    /// Spawns `ipc-host.mjs`, loads a stub ES-module plugin that exposes an
    /// `echo` tool, calls it, and unloads. Verifies the full load/call/unload
    /// lifecycle through the real Node.js subprocess (no mocks).
    #[tokio::test]
    async fn ts_backend_e2e_load_call_unload() {
        use crate::intel_gear::backend::{PluginSource, PluginSpec};

        // Resolve ipc-host.mjs relative to the workspace (robust to CWD).
        let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
        let host_script = std::path::Path::new(&manifest)
            .join("../../packages/duoduo/src/plugin/ipc-host.mjs");
        assert!(
            host_script.exists(),
            "ipc-host.mjs not found at {}",
            host_script.display()
        );

        let backend = LegacyTsBackend::new(host_script);

        // Write a stub plugin to a temp file.
        let plugin_path = std::env::temp_dir().join("ig_e2e_plugin.mjs");
        std::fs::write(
            &plugin_path,
            r#"
export default {
  server() {
    return {
      listTools: async () => ({
        tools: [{ name: "echo", description: "echo a message",
          inputSchema: { type: "object", properties: { msg: { type: "string" } } } }],
      }),
      callTool: async ({ name, arguments: args }) => {
        if (name === "echo") {
          return { content: [{ type: "text", text: "ECHO:" + (args?.msg ?? "") }] };
        }
        throw new Error("unknown tool " + name);
      },
    };
  }
};
"#,
        )
        .expect("write stub plugin");

        let spec = PluginSpec {
            raw: plugin_path.to_string_lossy().to_string(),
            source: PluginSource::File,
            name: "ig-e2e".to_string(),
            version: None,
            path: Some(plugin_path.clone()),
        };

        let loaded = backend.load(&spec).await.expect("load plugin");
        assert!(
            loaded.plugin.instance_id.starts_with("ts-plugin-"),
            "instance id should be ts-plugin-N"
        );
        assert!(
            loaded.tools.iter().any(|t| t.name == "echo"),
            "echo tool should be discovered"
        );

        let out = backend
            .call(&loaded.plugin, "echo", &serde_json::json!({"msg": "hi"}))
            .await
            .expect("call echo");
        assert_eq!(out, "ECHO:hi", "plugin call result");

        backend.unload(&loaded.plugin).await.expect("unload");
    }

    /// Load the real sample plugins shipped in `packages/duoduo/src/plugin/samples/`
    /// and exercise their canonical `server()` tools end-to-end. Validates the
    /// published SDK contract (echo.mjs + greet.mjs) against the actual host.
    #[tokio::test]
    async fn ts_backend_e2e_sample_plugins() {
        use crate::intel_gear::backend::{PluginSource, PluginSpec};

        let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
        let host_script = std::path::Path::new(&manifest)
            .join("../../packages/duoduo/src/plugin/ipc-host.mjs");
        assert!(host_script.exists(), "ipc-host.mjs not found");

        let samples_dir = std::path::Path::new(&manifest)
            .join("../../packages/duoduo/src/plugin/samples");
        assert!(samples_dir.exists(), "samples dir not found");

        let backend = LegacyTsBackend::new(host_script);

        // echo.mjs
        let echo_path = samples_dir.join("echo.mjs");
        let echo_spec = PluginSpec {
            raw: echo_path.to_string_lossy().to_string(),
            source: PluginSource::File,
            name: "sample-echo".to_string(),
            version: None,
            path: Some(echo_path.clone()),
        };
        let echo = backend.load(&echo_spec).await.expect("load echo sample");
        assert!(
            echo.tools.iter().any(|t| t.name == "echo"),
            "echo tool should be discovered"
        );
        let out = backend
            .call(&echo.plugin, "echo", &serde_json::json!({"msg": "hi"}))
            .await
            .expect("call echo");
        assert_eq!(out, "ECHO:hi");
        backend.unload(&echo.plugin).await.expect("unload echo");

        // greet.mjs (multi-tool plugin)
        let greet_path = samples_dir.join("greet.mjs");
        let greet_spec = PluginSpec {
            raw: greet_path.to_string_lossy().to_string(),
            source: PluginSource::File,
            name: "sample-greet".to_string(),
            version: None,
            path: Some(greet_path.clone()),
        };
        let greet = backend.load(&greet_spec).await.expect("load greet sample");
        assert!(greet.tools.iter().any(|t| t.name == "greet"));
        assert!(greet.tools.iter().any(|t| t.name == "farewell"));

        let g = backend
            .call(
                &greet.plugin,
                "greet",
                &serde_json::json!({"name": "Ada", "loud": true}),
            )
            .await
            .expect("call greet");
        assert_eq!(g, "HELLO, ADA!");

        let f = backend
            .call(&greet.plugin, "farewell", &serde_json::json!({"name": "Ada"}))
            .await
            .expect("call farewell");
        assert_eq!(f, "Goodbye, Ada.");

        backend.unload(&greet.plugin).await.expect("unload greet");
    }
}