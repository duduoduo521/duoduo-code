use base64::Engine;
use im_bridge::bridge::ModelInfo;
use serde::Deserialize;

#[derive(Clone)]
pub struct DuoduoSessionClient {
    base_url: String,
    auth_header: String,
    http: reqwest::Client,
}

#[derive(Debug, Clone)]
pub struct IdeProject {
    pub path: String,
    pub name: String,
    pub updated: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GlobalSession {
    directory: String,
    title: String,
    time: SessionTime,
    project: Option<ProjectSummary>,
}

#[derive(Debug, Deserialize)]
struct SessionTime {
    updated: u64,
}

#[derive(Debug, Deserialize)]
struct ProjectSummary {
    name: Option<String>,
    worktree: String,
}

#[derive(Debug, Deserialize)]
struct SessionCreateResponse {
    id: String,
}

/// A model entry inside a provider's `models` map (`/provider` response).
#[derive(Debug, Deserialize)]
struct ProviderModelEntry {
    name: String,
    /// Model-level sampling temperature configured on the TS side. `None` means
    /// the model has no explicit value, so the caller falls back to its default.
    #[serde(default)]
    temperature: Option<f32>,
}

/// A provider entry inside the `/provider` `all` array. Only the fields we
/// need are declared; serde ignores the rest.
#[derive(Debug, Deserialize)]
struct ProviderEntry {
    id: String,
    models: std::collections::HashMap<String, ProviderModelEntry>,
}

/// Top-level `/provider` response shape (we only read `all`).
#[derive(Debug, Deserialize)]
struct ProviderListResponse {
    all: Vec<ProviderEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstanceCapabilities {
    fixed_directory: bool,
    directory: String,
}

impl DuoduoSessionClient {
    pub fn from_injected_credentials() -> anyhow::Result<Self> {
        let creds = crate::duoduo_sync::get_duoduo_credentials()
            .ok_or_else(|| anyhow::anyhow!("duoduo sidecar credentials are not available"))?;
        let auth_header = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD
                .encode(format!("{}:{}", creds.username, creds.password))
        );
        Ok(Self {
            base_url: creds.url.trim_end_matches('/').to_string(),
            auth_header,
            // Shared loopback client: connect+overall timeouts, no_proxy (the
            // sidecar is always 127.0.0.1 — never route it through a proxy).
            http: crate::duoduo_sync::http_client().clone(),
        })
    }

    async fn instance_capabilities(&self) -> anyhow::Result<InstanceCapabilities> {
        let capabilities = self
            .http
            .get(format!("{}/capabilities", self.base_url))
            .header("Authorization", &self.auth_header)
            .send()
            .await?
            .error_for_status()?
            .json::<InstanceCapabilities>()
            .await?;
        Ok(capabilities)
    }

    pub async fn list_projects_from_sessions(&self) -> anyhow::Result<Vec<IdeProject>> {
        if let Ok(capabilities) = self.instance_capabilities().await
            && capabilities.fixed_directory
        {
            let name = std::path::Path::new(&capabilities.directory)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("fixed-project")
                .to_string();
            return Ok(vec![IdeProject {
                path: capabilities.directory,
                name,
                updated: 0,
            }]);
        }

        let sessions = self
            .http
            .get(format!("{}/experimental/session", self.base_url))
            .query(&[("roots", "true"), ("limit", "100")])
            .header("Authorization", &self.auth_header)
            .send()
            .await?
            .error_for_status()?
            .json::<Vec<GlobalSession>>()
            .await?;

        let mut by_path = std::collections::HashMap::<String, IdeProject>::new();
        for session in sessions {
            let path = session
                .project
                .as_ref()
                .map(|p| p.worktree.clone())
                .filter(|p| !p.is_empty())
                .unwrap_or_else(|| session.directory.clone());
            if path.is_empty() {
                continue;
            }
            let name = session
                .project
                .as_ref()
                .and_then(|p| p.name.clone())
                .filter(|n| !n.is_empty())
                .or_else(|| {
                    std::path::Path::new(&path)
                        .file_name()
                        .and_then(|s| s.to_str())
                        .map(|s| s.to_string())
                })
                .unwrap_or_else(|| session.title.clone());
            let next = IdeProject {
                path: path.clone(),
                name,
                updated: session.time.updated,
            };
            match by_path.get(&path) {
                Some(existing) if existing.updated >= next.updated => {}
                _ => {
                    by_path.insert(path, next);
                }
            }
        }

        let mut projects: Vec<IdeProject> = by_path.into_values().collect();
        projects.sort_by_key(|b| std::cmp::Reverse(b.updated));
        projects.truncate(8);
        Ok(projects)
    }

    async fn ensure_project_allowed(&self, project_path: &str) -> anyhow::Result<()> {
        if let Ok(capabilities) = self.instance_capabilities().await
            && capabilities.fixed_directory
            && project_path != capabilities.directory
        {
            anyhow::bail!(
                "当前 IDE 服务固定到项目 {}，不能切换到 {}",
                capabilities.directory,
                project_path
            );
        }
        Ok(())
    }

    pub async fn create_session(&self, project_path: &str, title: &str) -> anyhow::Result<String> {
        self.ensure_project_allowed(project_path).await?;
        let resp = self
            .http
            .post(format!("{}/session", self.base_url))
            .header("Authorization", &self.auth_header)
            .header("x-duoduo-directory", project_path)
            .json(&serde_json::json!({ "title": title }))
            .send()
            .await?
            .error_for_status()?
            .json::<SessionCreateResponse>()
            .await?;
        Ok(resp.id)
    }

    /// Send a prompt asynchronously to a session.
    ///
    /// Returns `Ok(true)` when the prompt was accepted (204), `Ok(false)` when
    /// the project task lock could not be acquired (HTTP 409 — a previous task
    /// is still running on the same project). Errors for any other status.
    pub async fn send_prompt_async(
        &self,
        project_path: &str,
        session_id: &str,
        prompt: &str,
        prompt_id: &str,
        model: Option<(String, String)>,
    ) -> anyhow::Result<bool> {
        self.ensure_project_allowed(project_path).await?;
        let mut body = serde_json::json!({
            "promptID": prompt_id,
            "blackboardOwner": true,
            "origin": "feishu",
            "parts": [{ "type": "text", "text": prompt }]
        });
        // Provide the model explicitly so a fresh Feishu session (no message
        // history) never falls back to "No model selected". The field is only
        // set when a model is known; otherwise we omit it entirely (the
        // Node schema requires the field to be absent or a valid object — a
        // `null` value would fail validation).
        if let Some((provider, model_id)) = model {
            body["model"] = serde_json::json!({ "providerID": provider, "modelID": model_id });
        }
        let resp = self
            .http
            .post(format!(
                "{}/session/{}/prompt_async",
                self.base_url, session_id
            ))
            .header("Authorization", &self.auth_header)
            .header("x-duoduo-directory", project_path)
            .json(&body)
            .send()
            .await?;
        if resp.status().as_u16() == 409 {
            return Ok(false);
        }
        resp.error_for_status()?;
        Ok(true)
    }

    /// Fetch the latest assistant message text from a session.
    ///
    /// Used to stream the LLM reply back to Feishu: after a Feishu prompt's
    /// task completes, the most recent `assistant` message's text parts are
    /// concatenated and returned. Returns an empty string when no assistant
    /// text is available yet (task still running, or no reply produced).
    pub async fn fetch_assistant_reply(&self, session_id: &str) -> anyhow::Result<String> {
        let messages = self
            .http
            .get(format!("{}/session/{}/message", self.base_url, session_id))
            .header("Authorization", &self.auth_header)
            .send()
            .await?
            .error_for_status()?
            .json::<Vec<serde_json::Value>>()
            .await?;

        let mut reply = String::new();
        for msg in messages.iter().rev() {
            let role = msg
                .get("info")
                .and_then(|i| i.get("role"))
                .and_then(|r| r.as_str())
                .or_else(|| msg.get("role").and_then(|r| r.as_str()))
                .unwrap_or("");
            if role != "assistant" {
                continue;
            }
            let parts = msg
                .get("parts")
                .and_then(|p| p.as_array())
                .cloned()
                .unwrap_or_default();
            for part in parts {
                if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                    reply.push_str(text);
                    reply.push('\n');
                }
            }
            if !reply.trim().is_empty() {
                break;
            }
        }
        Ok(reply.trim().to_string())
    }

    /// Read the globally configured model (`provider/model` string) from the
    /// Node `/global/config` endpoint. Returns `None` when no model is set.
    pub async fn get_global_model(&self) -> anyhow::Result<Option<(String, String)>> {
        let resp = self
            .http
            .get(format!("{}/global/config", self.base_url))
            .header("Authorization", &self.auth_header)
            .send()
            .await?
            .error_for_status()?
            .json::<serde_json::Value>()
            .await?;
        let model = resp
            .get("model")
            .and_then(|m| m.as_str())
            .unwrap_or("")
            .trim();
        if model.is_empty() {
            return Ok(None);
        }
        let mut parts = model.splitn(2, '/');
        let provider = parts.next().unwrap_or("").to_string();
        let model_id = parts.next().unwrap_or("").to_string();
        if provider.is_empty() || model_id.is_empty() {
            return Ok(None);
        }
        Ok(Some((provider, model_id)))
    }

    /// Persist the selected model into the Node `/global/config` so the desktop
    /// and all Feishu chats share a single source of truth.
    pub async fn set_global_model(&self, provider: &str, model: &str) -> anyhow::Result<()> {
        self.http
            .patch(format!("{}/global/config", self.base_url))
            .header("Authorization", &self.auth_header)
            .json(&serde_json::json!({ "model": format!("{}/{}", provider, model) }))
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    /// List selectable models for the Feishu model-selection card.
    pub async fn list_models(&self, project_path: &str) -> anyhow::Result<Vec<ModelInfo>> {
        let resp = self
            .http
            .get(format!("{}/provider", self.base_url))
            .header("Authorization", &self.auth_header)
            .header("x-duoduo-directory", project_path)
            .send()
            .await?
            .error_for_status()?
            .json::<ProviderListResponse>()
            .await?;
        let mut models = Vec::new();
        for provider in resp.all {
            for (model_id, entry) in provider.models {
                let label = if entry.name.is_empty() {
                    model_id.clone()
                } else {
                    entry.name.clone()
                };
                models.push(ModelInfo {
                    provider_id: provider.id.clone(),
                    model_id,
                    display_name: format!("{}/{}", provider.id, label),
                });
            }
        }
        // Cap the card to a manageable number of buttons.
        models.truncate(12);
        Ok(models)
    }

    /// Resolve the model-level sampling temperature for `model_id` from the TS
    /// provider registry. `model_id` may be a bare model id or a
    /// `provider/model` qualified id. Returns `None` when the model is unknown
    /// or has no configured temperature, so the caller falls back to its default.
    pub async fn get_model_temperature(
        &self,
        project_path: &str,
        model_id: &str,
    ) -> anyhow::Result<Option<f32>> {
        let resp = self
            .http
            .get(format!("{}/provider", self.base_url))
            .header("Authorization", &self.auth_header)
            .header("x-duoduo-directory", project_path)
            .send()
            .await?
            .error_for_status()?
            .json::<ProviderListResponse>()
            .await?;
        for provider in resp.all {
            for (m_id, entry) in provider.models {
                if m_id == model_id || format!("{}/{}", provider.id, m_id) == model_id {
                    return Ok(entry.temperature);
                }
            }
        }
        Ok(None)
    }

    pub async fn abort_session(&self, project_path: &str, session_id: &str) -> anyhow::Result<()> {
        self.ensure_project_allowed(project_path).await?;
        self.http
            .post(format!("{}/session/{}/abort", self.base_url, session_id))
            .header("Authorization", &self.auth_header)
            .header("x-duoduo-directory", project_path)
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex, MutexGuard};

    /// Captures the most recent request seen by the mock server.
    #[derive(Clone, Default)]
    struct ReqLog {
        inner: Arc<Mutex<Option<(String, String, String, String, String)>>>,
    }

    impl ReqLog {
        fn record(&self, method: &str, uri: &str, auth: &str, dir: &str, body: &str) {
            *self.inner.lock().unwrap() = Some((
                method.to_string(),
                uri.to_string(),
                auth.to_string(),
                dir.to_string(),
                body.to_string(),
            ));
        }
        fn take(&self) -> (String, String, String, String, String) {
            self.inner.lock().unwrap().take().unwrap()
        }
    }

    /// A scripted response: (status, body).
    type Script = Arc<dyn Fn(&str, &str) -> (u16, String) + Send + Sync>;

    async fn spawn_mock<F>(log: ReqLog, script: F) -> String
    where
        F: Fn(&str, &str) -> (u16, String) + Send + Sync + 'static,
    {
        use axum::extract::Request;
        use axum::routing::any;
        use axum::Router;

        let script: Script = Arc::new(script);
        let router = Router::new().fallback(any(move |req: Request| {
            let log = log.clone();
            let script = script.clone();
            async move {
                let method = req.method().as_str().to_string();
                let uri = req.uri().to_string();
                let auth = req
                    .headers()
                    .get(http::header::AUTHORIZATION)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                let dir = req
                    .headers()
                    .get("x-duoduo-directory")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                let body = axum::body::to_bytes(req.into_body(), usize::MAX)
                    .await
                    .map(|b| String::from_utf8_lossy(&b).to_string())
                    .unwrap_or_default();
                log.record(&method, &uri, &auth, &dir, &body);
                let (status, body) = script(&uri, &body);
                axum::response::Response::builder()
                    .status(status)
                    .header(http::header::CONTENT_TYPE, "application/json")
                    .body(axum::body::Body::from(body))
                    .unwrap()
            }
        }));

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        // Wait until the server actually accepts connections so a subsequent
        // request can't race a not-yet-bound socket (which would surface as a
        // flaky "connection refused / closed" under heavy parallel test load).
        for _ in 0..100 {
            if tokio::net::TcpStream::connect(addr).await.is_ok() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        format!("http://{addr}")
    }

    /// Process-wide lock serializing tests that mutate the shared global
    /// credential store. Methods like `list_projects_from_sessions` re-read the
    /// global credentials mid-flight, so two parallel tests would corrupt each
    /// other's injected base URL. Holding the guard for the test's lifetime
    /// prevents that cross-test contamination.
    static TEST_CRED_LOCK: Mutex<()> = Mutex::new(());

    /// Inject a local mock server as the duoduo credentials and return a client
    /// plus a guard that must be held for the test's lifetime.
    fn inject(base: &str) -> (DuoduoSessionClient, MutexGuard<'static, ()>) {
        let guard = TEST_CRED_LOCK.lock().unwrap();
        crate::duoduo_sync::reset_duoduo_credentials_for_test(crate::duoduo_sync::DuoduoCredentials {
            url: base.to_string(),
            username: "duoduo".to_string(),
            password: "secret".to_string(),
        });
        let client = DuoduoSessionClient::from_injected_credentials().unwrap();
        (client, guard)
    }

    // --- create_session -------------------------------------------------

    #[tokio::test]
    async fn create_session_posts_to_session_endpoint_with_basic_auth() {
        let log = ReqLog::default();
        let base = spawn_mock(log.clone(), move |uri, _body| {
            if uri.contains("/capabilities") {
                (200, r#"{"fixedDirectory":false,"directory":""}"#.to_string())
            } else {
                assert!(uri.starts_with("/session"), "unexpected uri {uri}");
                (200, r#"{"id":"sess-1"}"#.to_string())
            }
        })
        .await;
        let (client, _guard) = inject(&base);

        let id = client.create_session("/proj", "my title").await.unwrap();
        assert_eq!(id, "sess-1");

        let (method, uri, auth, _dir, body) = log.take();
        assert_eq!(method, "POST");
        assert!(uri.starts_with("/session"));
        assert!(auth.starts_with("Basic "));
        assert!(body.contains("\"title\":\"my title\""));
    }

    #[tokio::test]
    async fn create_session_sends_directory_header() {
        let log = ReqLog::default();
        let base = spawn_mock(log.clone(), move |uri, _body| {
            if uri.contains("/capabilities") {
                (200, r#"{"fixedDirectory":false,"directory":""}"#.to_string())
            } else {
                (200, r#"{"id":"x"}"#.to_string())
            }
        })
        .await;
        let (client, _guard) = inject(&base);
        client.create_session("/abs/proj", "t").await.unwrap();
        let (_m, _u, _a, dir, _b) = log.take();
        assert_eq!(dir, "/abs/proj");
    }

    #[tokio::test]
    async fn create_session_maps_error_status_to_err() {
        let base = spawn_mock(ReqLog::default(), |_uri, _body| {
            (500, r#"{"error":"boom"}"#.to_string())
        })
        .await;
        let (client, _guard) = inject(&base);
        let err = client.create_session("/p", "t").await.unwrap_err();
        // error_for_status maps 5xx to a reqwest status error; assert it surfaces
        // as an error mentioning the failing status (not silently swallowed).
        assert!(err.to_string().contains("500") || err.to_string().to_lowercase().contains("status"));
    }

    // --- send_prompt_async ----------------------------------------------

    #[tokio::test]
    async fn send_prompt_async_returns_true_on_2xx_and_embeds_prompt() {
        let log = ReqLog::default();
        let base = spawn_mock(log.clone(), |uri, body| {
            assert!(uri.contains("/session/s-9/prompt_async"), "uri={uri}");
            assert!(body.contains("hello world"), "body={body}");
            assert!(body.contains("\"origin\":\"feishu\""), "body={body}");
            assert!(body.contains("\"promptID\":\"pid-1\""), "body={body}");
            (200, "{}".to_string())
        })
        .await;
        let (client, _guard) = inject(&base);

        let accepted = client
            .send_prompt_async("/p", "s-9", "hello world", "pid-1", None)
            .await
            .unwrap();
        assert!(accepted);
    }

    #[tokio::test]
    async fn send_prompt_async_returns_false_on_409_conflict() {
        let base = spawn_mock(ReqLog::default(), |_uri, _body| (409, "{}".to_string())).await;
        let (client, _guard) = inject(&base);
        let accepted = client
            .send_prompt_async("/p", "s-9", "x", "pid", None)
            .await
            .unwrap();
        assert!(!accepted);
    }

    #[tokio::test]
    async fn send_prompt_async_embeds_model_when_provided() {
        let log = ReqLog::default();
        let base = spawn_mock(log.clone(), |_uri, body| {
            assert!(
                body.contains("\"model\"")
                    && body.contains("providerID")
                    && body.contains("\"openai\"")
                    && body.contains("modelID")
                    && body.contains("\"gpt\""),
                "model missing: {body}"
            );
            (200, "{}".to_string())
        })
        .await;
        let (client, _guard) = inject(&base);
        client
            .send_prompt_async("/p", "s", "x", "pid", Some(("openai".into(), "gpt".into())))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn send_prompt_async_omits_model_when_none() {
        let log = ReqLog::default();
        let base = spawn_mock(log.clone(), |_uri, body| {
            assert!(!body.contains("\"model\""), "model should be absent: {body}");
            (200, "{}".to_string())
        })
        .await;
        let (client, _guard) = inject(&base);
        client.send_prompt_async("/p", "s", "x", "pid", None).await.unwrap();
    }

    // --- fetch_assistant_reply ------------------------------------------

    #[tokio::test]
    async fn fetch_assistant_reply_concatenates_latest_assistant_text() {
        let body = r#"[
            {"role":"user","parts":[{"type":"text","text":"hi"}]},
            {"role":"assistant","parts":[{"type":"text","text":"first"}]},
            {"role":"assistant","parts":[{"type":"text","text":"second"}]}
        ]"#;
        let base = spawn_mock(ReqLog::default(), |uri, _body| {
            assert!(uri.contains("/session/s-1/message"), "uri={uri}");
            (200, body.to_string())
        })
        .await;
        let (client, _guard) = inject(&base);
        let reply = client.fetch_assistant_reply("s-1").await.unwrap();
        // Walks messages in reverse, returns the FIRST assistant block found.
        assert_eq!(reply, "second");
    }

    #[tokio::test]
    async fn fetch_assistant_reply_returns_empty_when_no_assistant() {
        let body = r#"[{"role":"user","parts":[{"type":"text","text":"hi"}]}]"#;
        let base = spawn_mock(ReqLog::default(), |_uri, _body| (200, body.to_string())).await;
        let (client, _guard) = inject(&base);
        let reply = client.fetch_assistant_reply("s-1").await.unwrap();
        assert_eq!(reply, "");
    }

    // --- list_projects_from_sessions ------------------------------------

    #[tokio::test]
    async fn list_projects_uses_fixed_directory_when_capability_set() {
        let base = spawn_mock(ReqLog::default(), |uri, _body| {
            if uri.contains("/capabilities") {
                (200, r#"{"fixedDirectory":true,"directory":"/abs/fixed"}"#.to_string())
            } else {
                panic!("unexpected call to {uri}");
            }
        })
        .await;
        let (client, _guard) = inject(&base);
        let projects = client.list_projects_from_sessions().await.unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].path, "/abs/fixed");
        assert_eq!(projects[0].name, "fixed");
    }

    #[tokio::test]
    async fn list_projects_dedupes_by_path_and_sorts_by_updated_desc() {
        let sessions = r#"[
            {"directory":"/d1","title":"t1","time":{"updated":100},"project":{"name":"P1","worktree":"/d1"}},
            {"directory":"/d1","title":"t1b","time":{"updated":300},"project":{"name":"P1","worktree":"/d1"}},
            {"directory":"/d2","title":"t2","time":{"updated":200},"project":{"name":"P2","worktree":"/d2"}},
            {"directory":"","title":"t3","time":{"updated":999},"project":null}
        ]"#;
        let base = spawn_mock(ReqLog::default(), move |uri, _body| {
            if uri.contains("/capabilities") {
                (200, r#"{"fixedDirectory":false,"directory":""}"#.to_string())
            } else if uri.contains("/experimental/session") {
                (200, sessions.to_string())
            } else {
                panic!("unexpected {uri}");
            }
        })
        .await;
        let (client, _guard) = inject(&base);
        let projects = client.list_projects_from_sessions().await.unwrap();
        // /d1 deduped to the higher-updated session (300); /d2 (200); empty dropped.
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].path, "/d1");
        assert_eq!(projects[0].updated, 300);
        assert_eq!(projects[1].path, "/d2");
    }

    #[tokio::test]
    async fn list_projects_caps_at_eight() {
        let mut arr = Vec::new();
        for i in 0..20u32 {
            arr.push(format!(
                "{{\"directory\":\"/d{i}\",\"title\":\"t{i}\",\"time\":{{\"updated\":{i}}},\"project\":{{\"name\":\"P{i}\",\"worktree\":\"/d{i}\"}}}}"
            ));
        }
        let sessions = format!("[{}]", arr.join(","));
        let base = spawn_mock(ReqLog::default(), move |uri, _body| {
            if uri.contains("/capabilities") {
                (200, r#"{"fixedDirectory":false,"directory":""}"#.to_string())
            } else {
                (200, sessions.clone())
            }
        })
        .await;
        let (client, _guard) = inject(&base);
        let projects = client.list_projects_from_sessions().await.unwrap();
        assert_eq!(projects.len(), 8);
    }

    // --- list_models ----------------------------------------------------

    #[tokio::test]
    async fn list_models_parses_provider_all_and_caps_at_12() {
        // Build the provider-list JSON via serde_json (avoids hand-rolled brace
        // escaping). The response is keyed by model id -> { "name": ... }.
        let mut models_map = serde_json::Map::new();
        for i in 0..30u32 {
            models_map.insert(
                format!("m{i}"),
                serde_json::json!({ "name": format!("Model{i}") }),
            );
        }
        let body = serde_json::json!({
            "all": [{
                "id": "openai",
                "models": models_map,
            }]
        })
        .to_string();
        let base = spawn_mock(ReqLog::default(), move |uri, _body| {
            assert!(uri.contains("/provider"), "uri={uri}");
            (200, body.clone())
        })
        .await;
        let (client, _guard) = inject(&base);
        let models = client.list_models("/p").await.unwrap();
        assert_eq!(models.len(), 12, "must truncate to 12");
        // HashMap iteration order is nondeterministic, so assert the *set* of
        // model indices is 12 distinct values within 0..30 (i.e. the 30-entry
        // map was correctly truncated to 12, not silently dropping/duplicating).
        assert!(models.iter().all(|m| m.provider_id == "openai"));
        let mut indices: Vec<u32> = models
            .iter()
            .map(|m| {
                let n = m.display_name.trim_start_matches("openai/Model");
                n.parse::<u32>().expect("display_name must be openai/ModelN")
            })
            .collect();
        indices.sort();
        let unique: std::collections::HashSet<u32> = indices.iter().copied().collect();
        assert_eq!(unique.len(), 12, "truncated set must contain 12 distinct models");
        assert!(indices.iter().all(|&n| n < 30), "model index out of range");
    }

    // --- set_global_model / get_global_model ----------------------------

    #[tokio::test]
    async fn set_global_model_patches_config_with_provider_slash_model() {
        let log = ReqLog::default();
        let base = spawn_mock(log.clone(), |uri, body| {
            assert!(uri.contains("/global/config"), "uri={uri}");
            assert!(body.contains(r#""model":"openai/gpt-4""#), "body={body}");
            (200, "{}".to_string())
        })
        .await;
        let (client, _guard) = inject(&base);
        client.set_global_model("openai", "gpt-4").await.unwrap();
        let (method, _u, _a, _d, _b) = log.take();
        assert_eq!(method, "PATCH");
    }

    #[tokio::test]
    async fn get_global_model_parses_provider_model_pair() {
        let base = spawn_mock(ReqLog::default(), |_uri, _body| {
            (200, r#"{"model":"anthropic/claude"}"#.to_string())
        })
        .await;
        let (client, _guard) = inject(&base);
        let model = client.get_global_model().await.unwrap();
        assert_eq!(model, Some(("anthropic".to_string(), "claude".to_string())));
    }

    #[tokio::test]
    async fn get_global_model_returns_none_on_empty_model() {
        let base = spawn_mock(ReqLog::default(), |_uri, _body| {
            (200, r#"{"model":""}"#.to_string())
        })
        .await;
        let (client, _guard) = inject(&base);
        assert_eq!(client.get_global_model().await.unwrap(), None);
    }

    // --- abort_session --------------------------------------------------

    #[tokio::test]
    async fn abort_session_posts_to_abort_endpoint() {
        let log = ReqLog::default();
        let base = spawn_mock(log.clone(), move |uri, _body| {
            if uri.contains("/capabilities") {
                (200, r#"{"fixedDirectory":false,"directory":""}"#.to_string())
            } else {
                assert!(uri.contains("/session/s-7/abort"), "uri={uri}");
                (200, "{}".to_string())
            }
        })
        .await;
        let (client, _guard) = inject(&base);
        client.abort_session("/p", "s-7").await.unwrap();
        let (method, _u, _a, _d, _b) = log.take();
        assert_eq!(method, "POST");
    }

    // --- ensure_project_allowed (via fixed_directory) -------------------

    #[tokio::test]
    async fn project_switch_blocked_when_fixed_directory_mismatch() {
        let base = spawn_mock(ReqLog::default(), |uri, _body| {
            if uri.contains("/capabilities") {
                (200, r#"{"fixedDirectory":true,"directory":"/abs/fixed"}"#.to_string())
            } else {
                (200, "{}".to_string())
            }
        })
        .await;
        let (client, _guard) = inject(&base);
        let err = client.create_session("/other/proj", "t").await.unwrap_err();
        assert!(err.to_string().contains("固定到项目"));
    }

    #[tokio::test]
    async fn project_switch_allowed_when_fixed_directory_matches() {
        let base = spawn_mock(ReqLog::default(), |uri, _body| {
            if uri.contains("/capabilities") {
                (200, r#"{"fixedDirectory":true,"directory":"/abs/fixed"}"#.to_string())
            } else {
                (200, r#"{"id":"ok"}"#.to_string())
            }
        })
        .await;
        let (client, _guard) = inject(&base);
        // create_session hits /capabilities then /session; both handled above.
        let id = client.create_session("/abs/fixed", "t").await.unwrap();
        assert_eq!(id, "ok");
    }
}
