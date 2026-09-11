//! WASM backend for IntelGear plugins.
//!
//! When the `wasm-backend` feature is enabled, plugins are loaded as
//! WebAssembly components (wasmtime component model) and sandboxed. The host
//! provides a minimal `log` import; component exports `load`, `list-tools` and
//! `call-tool` (JSON in / JSON out) form the gear-plugin contract.
//!
//! Without the feature, `WasmBackend` exists but every call returns an error so
//! the legacy TS backend remains the active path.

#[cfg(not(feature = "wasm-backend"))]
mod inner {
    use anyhow::Result;
    use serde_json::Value;

    use crate::intel_gear::backend::{GearToolDefinition, PluginLoadResult, PluginRef, PluginSpec};

    #[derive(Default)]
    pub struct WasmBackend {}

    impl WasmBackend {
        pub fn new() -> Self {
            Self::default()
        }

        pub async fn get_instance(&self, _id: &str) -> Option<PluginRef> {
            None
        }

        pub async fn load(&self, _spec: &PluginSpec) -> Result<PluginLoadResult> {
            anyhow::bail!(
                "WASM backend not yet implemented (enable the `wasm-backend` feature with wasmtime)"
            );
        }
        pub async fn call(&self, _plugin_ref: &PluginRef, _name: &str, _args: &Value) -> Result<String> {
            anyhow::bail!(
                "WASM backend not yet implemented (enable the `wasm-backend` feature with wasmtime)"
            );
        }
        pub async fn list(&self, _plugin_ref: &PluginRef) -> Result<Vec<GearToolDefinition>> {
            anyhow::bail!(
                "WASM backend not yet implemented (enable the `wasm-backend` feature with wasmtime)"
            );
        }
        pub async fn unload(&self, _plugin_ref: &PluginRef) -> Result<()> {
            anyhow::bail!(
                "WASM backend not yet implemented (enable the `wasm-backend` feature with wasmtime)"
            );
        }
    }
}

#[cfg(feature = "wasm-backend")]
mod inner {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex as StdMutex};

    use anyhow::{anyhow, Result};
    use duo_utils::sync::lock;
    use serde_json::Value;
    use wasmtime::component::{Component, Linker, Val};

    use crate::intel_gear::backend::{
        GearToolDefinition, PluginBackend, PluginLoadResult, PluginRef, PluginSpec,
    };

    /// Host state shared with a component instance (currently just its id).
    struct HostState {
        instance_id: String,
    }

    /// One loaded component instance, kept alive for the lifetime of the store.
    struct Instance {
        _engine: wasmtime::Engine,
        store: wasmtime::Store<HostState>,
        instance: wasmtime::component::Instance,
        _component: Component,
    }

    #[derive(Default)]
    struct WasmBackendInner {
        instances: StdMutex<HashMap<String, Instance>>,
        counter: StdMutex<u64>,
    }

    #[derive(Clone)]
    pub struct WasmBackend {
        inner: Arc<WasmBackendInner>,
    }

    impl WasmBackend {
        pub fn new() -> Self {
            Self {
                inner: Arc::new(WasmBackendInner::default()),
            }
        }

        /// Reconstruct a `PluginRef` (backend-agnostic handle) for a loaded
        /// instance id, so the unified execute path can route to this backend.
        pub async fn get_instance(&self, id: &str) -> Option<PluginRef> {
            if lock(&self.inner.instances).contains_key(id) {
                Some(PluginRef {
                    spec: PluginSpec {
                        raw: String::new(),
                        source: crate::intel_gear::backend::PluginSource::Wasm,
                        name: String::new(),
                        version: None,
                        path: None,
                    },
                    backend: "wasm".into(),
                    instance_id: id.to_string(),
                })
            } else {
                None
            }
        }

        async fn next_id(&self) -> String {
            let mut c = lock(&self.inner.counter);
            *c += 1;
            format!("wasm-plugin-{c}")
        }

        /// Build a linker that exposes the host imports the gear component expects.
        ///
        /// The contract (to be finalized with the gear-plugin WIT SDK) currently
        /// provides a `log(level, message)` import. Add host functions here as the
        /// WIT interface grows (e.g. read-file / http-fetch capabilities).
        fn build_linker(engine: &wasmtime::Engine, instance_id: String) -> Result<Linker<HostState>> {
            let mut linker = Linker::new(engine);
            linker.root().func_wrap(
                "log",
                move |_store, (level, msg): (String, String)| {
                    tracing::info!(target: "wasm-plugin", instance = %instance_id, level = %level, "{msg}");
                    Ok(())
                },
            )?;
            Ok(linker)
        }

        pub async fn load_inner(&self, spec: &PluginSpec) -> Result<PluginLoadResult> {
            let path = spec
                .path
                .as_ref()
                .ok_or_else(|| anyhow!("wasm plugin requires a `path`"))?;
            let bytes = tokio::fs::read(path)
                .await
                .map_err(|e| anyhow!("read wasm plugin: {e}"))?;

            let engine = wasmtime::Engine::default();
            let component =
                Component::new(&engine, &bytes).map_err(|e| anyhow!("compile component: {e}"))?;

            let instance_id = self.next_id().await;
            let linker = Self::build_linker(&engine, instance_id.clone())?;
            let mut store =
                wasmtime::Store::new(&engine, HostState { instance_id: instance_id.clone() });
            let instance = linker
                .instantiate(&mut store, &component)
                .map_err(|e| anyhow!("instantiate component: {e}"))?;

            // Call the exported `load` to obtain the tool list (JSON array of
            // GearToolDefinition). This is the gear-plugin load contract.
            let func = instance
                .get_func(&mut store, "load")
                .ok_or_else(|| anyhow!("component exports no `load`"))?;
            let mut results = [Val::String(String::new())];
            func.call(&mut store, &[], &mut results)
                .map_err(|e| anyhow!("call `load`: {e}"))?;
            let tools_json = match &results[0] {
                Val::String(s) => s.clone(),
                _ => return Err(anyhow!("`load` returned a non-string tool list")),
            };
            let tools: Vec<GearToolDefinition> = serde_json::from_str(&tools_json)
                .map_err(|e| anyhow!("parse tool list: {e}"))?;

            lock(&self.inner.instances).insert(
                instance_id.clone(),
                Instance {
                    _engine: engine,
                    store,
                    instance,
                    _component: component,
                },
            );

            Ok(PluginLoadResult {
                plugin: PluginRef {
                    spec: spec.clone(),
                    backend: "wasm".into(),
                    instance_id,
                },
                tools,
            })
        }

        pub async fn call_inner(&self, plugin_ref: &PluginRef, name: &str, args: &Value) -> Result<String> {
            let mut guard = lock(&self.inner.instances);
            let inst = guard.get_mut(&plugin_ref.instance_id).ok_or_else(|| {
                anyhow!("wasm instance `{}` not loaded", plugin_ref.instance_id)
            })?;
            let func = inst
                .instance
                .get_func(&mut inst.store, "call-tool")
                .ok_or_else(|| anyhow!("component exports no `call-tool`"))?;
            let mut results = [Val::String(String::new())];
            func.call(
                &mut inst.store,
                &[Val::String(name.to_string()), Val::String(args.to_string())],
                &mut results,
            )
            .map_err(|e| anyhow!("call `call-tool`: {e}"))?;
            match &results[0] {
                Val::String(s) => Ok(s.clone()),
                _ => Err(anyhow!("`call-tool` returned a non-string result")),
            }
        }

        #[allow(dead_code)]
        pub async fn list_inner(&self, plugin_ref: &PluginRef) -> Result<Vec<GearToolDefinition>> {
            let mut guard = lock(&self.inner.instances);
            let inst = guard.get_mut(&plugin_ref.instance_id).ok_or_else(|| {
                anyhow!("wasm instance `{}` not loaded", plugin_ref.instance_id)
            })?;
            let func = inst
                .instance
                .get_func(&mut inst.store, "list-tools")
                .ok_or_else(|| anyhow!("component exports no `list-tools`"))?;
            let mut results = [Val::String(String::new())];
            func.call(&mut inst.store, &[], &mut results)
                .map_err(|e| anyhow!("call `list-tools`: {e}"))?;
            let json = match &results[0] {
                Val::String(s) => s.clone(),
                _ => return Err(anyhow!("`list-tools` returned a non-string result")),
            };
            let tools: Vec<GearToolDefinition> =
                serde_json::from_str(&json).map_err(|e| anyhow!("parse tools: {e}"))?;
            Ok(tools)
        }

        pub async fn unload_inner(&self, plugin_ref: &PluginRef) -> Result<()> {
            lock(&self.inner.instances).remove(&plugin_ref.instance_id);
            Ok(())
        }
    }

    impl PluginBackend for WasmBackend {
        fn load(
            &self,
            spec: &PluginSpec,
        ) -> impl std::future::Future<Output = Result<PluginLoadResult>> + Send {
            self.load_inner(spec)
        }
        fn call(
            &self,
            plugin: &PluginRef,
            tool: &str,
            args: &Value,
        ) -> impl std::future::Future<Output = Result<String>> + Send {
            self.call_inner(plugin, tool, args)
        }
        fn unload(
            &self,
            plugin: &PluginRef,
        ) -> impl std::future::Future<Output = Result<()>> + Send {
            self.unload_inner(plugin)
        }
    }
}

pub use inner::WasmBackend;

use std::sync::Arc;

static GLOBAL_WASM: std::sync::OnceLock<Arc<WasmBackend>> = std::sync::OnceLock::new();

/// Process-global WASM plugin backend. With the `wasm-backend` feature off this
/// returns the stub backend whose calls bail with a clear "not implemented" error;
/// with it on, it hosts compiled gear-plugin components via wasmtime.
pub fn global_wasm_backend() -> Arc<WasmBackend> {
    GLOBAL_WASM
        .get_or_init(|| Arc::new(WasmBackend::new()))
        .clone()
}
