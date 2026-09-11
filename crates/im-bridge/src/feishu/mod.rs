//! Feishu (Lark) WebSocket adapter.
//!
//! Implements the pbbp2 long-connection protocol reverse-engineered from
//! `@larksuiteoapi/node-sdk` (`ws-client/` source). The adapter:
//!
//! 1. Obtains WS config via `POST /callback/ws/endpoint`
//! 2. Connects to the returned WebSocket URL
//! 3. Sends pbbp2-encoded heartbeat frames at the configured interval
//! 4. Receives and dispatches event/data frames
//! 5. Reconnects on disconnect with exponential backoff

pub(crate) mod api;
mod auth;
pub mod proto;
mod validate;
pub(crate) mod ws;

pub use api::{
    has_been_welcomed, known_chat_ids, mark_welcomed, record_chat_id, FeishuApiClient,
};
pub use auth::FeishuAuthProvider;
pub use validate::validate_credentials;
pub use ws::FeishuWsClient;
