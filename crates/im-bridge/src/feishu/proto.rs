//! Feishu pbbp2 Protobuf frame encoding/decoding.
//!
//! The pbbp2 protocol types are hand-defined here using `prost::Message`
//! derive macros, matching the `.proto` definition in `proto/pbbp2.proto`.
//! This eliminates the need for `prost-build` and the `protoc` binary,
//! making the build fully cross-platform (Windows/macOS/Linux).
//!
//! Field numbers and types were reverse-engineered from
//! `@larksuiteoapi/node-sdk` source code. See `docs/pbbp2-protocol.md`
//! for the complete verification details.

pub mod pbbp2 {

    /// pbbp2 Header: a key-value pair carried in a Frame.
    ///
    /// Proto definition:
    /// ```protobuf
    /// message Header {
    ///   string key = 1;
    ///   string value = 2;
    /// }
    /// ```
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct Header {
        #[prost(string, tag = "1")]
        pub key: String,
        #[prost(string, tag = "2")]
        pub value: String,
    }

    /// pbbp2 Frame: the top-level protocol frame for Feishu WebSocket.
    ///
    /// Proto definition (from `proto/pbbp2.proto`):
    /// ```protobuf
    /// message Frame {
    ///   uint64 SeqID = 1;
    ///   uint64 LogID = 2;
    ///   int32  service = 3;
    ///   int32  method = 4;
    ///   repeated Header headers = 5;
    ///   string payloadEncoding = 6;
    ///   string payloadType = 7;
    ///   bytes  payload = 8;
    ///   string LogIDNew = 9;
    /// }
    /// ```
    ///
    /// Field numbers verified against `@larksuiteoapi/node-sdk` v1.62.2
    /// source code (`ws-client/proto-buf/pbbp2.js` encode function).
    /// See `docs/pbbp2-protocol.md` §2 for the complete verification table.
    #[derive(Clone, PartialEq, prost::Message)]
    pub struct Frame {
        /// Sequence ID (required).
        #[prost(uint64, tag = "1")]
        pub seq_id: u64,
        /// Log ID (required).
        #[prost(uint64, tag = "2")]
        pub log_id: u64,
        /// Service ID (required).
        #[prost(int32, tag = "3")]
        pub service: i32,
        /// Frame type: 0=control, 1=data (required).
        #[prost(int32, tag = "4")]
        pub method: i32,
        /// Header list (optional).
        #[prost(message, repeated, tag = "5")]
        pub headers: Vec<Header>,
        /// Payload encoding (optional, e.g. "json").
        #[prost(string, tag = "6")]
        pub payload_encoding: String,
        /// Payload type (optional, e.g. "event", "card").
        #[prost(string, tag = "7")]
        pub payload_type: String,
        /// Payload data (optional).
        #[prost(bytes = "vec", tag = "8")]
        pub payload: Vec<u8>,
        /// New-style log ID, string format (optional).
        #[prost(string, tag = "9")]
        pub log_id_new: String,
    }
}

/// Re-export the wire types so consumers (and integration tests) can build and
/// inspect frames without reaching into the private `pbbp2` submodule.
pub use pbbp2::{Frame, Header};

// ── FrameType: values for Frame.method field ──
/// Control frame (heartbeat/handshake).
pub const FRAME_TYPE_CONTROL: i32 = 0;
/// Data frame (events/callbacks).
pub const FRAME_TYPE_DATA: i32 = 1;

// ── HeaderKey: standard header key strings ──
/// Header key: frame type discriminator.
pub const HEADER_KEY_TYPE: &str = "type";
/// Header key: message ID (for multi-frame reassembly).
pub const HEADER_KEY_MESSAGE_ID: &str = "message_id";
/// Header key: total frame count in a multi-frame message.
pub const HEADER_KEY_SUM: &str = "sum";
/// Header key: frame sequence number (0-based).
pub const HEADER_KEY_SEQ: &str = "seq";
/// Header key: trace ID for observability.
pub const HEADER_KEY_TRACE_ID: &str = "trace_id";
/// Header key: business round-trip time (response).
pub const HEADER_KEY_BIZ_RT: &str = "biz_rt";
/// Header key: handshake status.
pub const HEADER_KEY_HANDSHAKE_STATUS: &str = "handshake-status";
/// Header key: handshake message.
pub const HEADER_KEY_HANDSHAKE_MSG: &str = "handshake-msg";
/// Header key: marks the final frame of a multi-frame (fragmented) message.
///
/// Sent by the server, but our reassembly merges fragments by
/// `HEADER_KEY_SEQ`/`HEADER_KEY_SUM` and never reads this header. Kept because
/// `tests/feishu_robustness.rs` uses it to build realistic server frames.
pub const HEADER_KEY_IS_LAST: &str = "is_last";

// ── MessageType: values for Header key="type" ──
/// Event message type.
pub const MESSAGE_TYPE_EVENT: &str = "event";
/// Card action callback.
pub const MESSAGE_TYPE_CARD: &str = "card";
/// Ping (client → server).
pub const MESSAGE_TYPE_PING: &str = "ping";
/// Pong (server → client).
pub const MESSAGE_TYPE_PONG: &str = "pong";

// ── ErrorCode: server response codes ──
pub const ERROR_CODE_OK: i64 = 0;
pub const ERROR_CODE_SYSTEM_BUSY: i64 = 1;
pub const ERROR_CODE_FORBIDDEN: i64 = 403;
pub const ERROR_CODE_AUTH_FAILED: i64 = 514;
pub const ERROR_CODE_INTERNAL_ERROR: i64 = 1000040343;
pub const ERROR_CODE_EXCEED_CONN_LIMIT: i64 = 1000040350;

// ── HttpStatusCode ──
pub const HTTP_STATUS_OK: i64 = 200;

/// Build a ping frame for heartbeat.
pub fn build_ping_frame(service_id: u64) -> Frame {
    Frame {
        seq_id: 0,
        log_id: 0,
        service: service_id as i32,
        method: FRAME_TYPE_CONTROL,
        headers: vec![Header {
            key: HEADER_KEY_TYPE.to_string(),
            value: MESSAGE_TYPE_PING.to_string(),
        }],
        payload_encoding: String::new(),
        payload_type: String::new(),
        payload: Vec::new(),
        log_id_new: String::new(),
    }
}

/// Encode a Frame to bytes for sending over WebSocket.
pub fn encode_frame(frame: &Frame) -> Vec<u8> {
    let mut buf = Vec::new();
    prost::Message::encode(frame, &mut buf)
        .expect("invariant: prost encoding a Frame into a Vec writer never fails");
    buf
}

/// Decode a Frame from bytes received over WebSocket.
pub fn decode_frame(data: &[u8]) -> Result<Frame, prost::DecodeError> {
    prost::Message::decode(data)
}

/// Build an ACK response frame for a fully-received data frame.
///
/// Mirrors the official SDKs (`oapi-sdk-go` `handleDataFrame` /
/// `@larksuiteoapi/node-sdk`): the incoming frame is echoed back with its
/// payload replaced by a JSON `{"code":200}` response and a `biz_rt` header
/// carrying the local processing time in milliseconds. Feishu REQUIRES this
/// ACK — without it the server treats delivery as failed, re-pushes the
/// event, and card actions show a loading-failure in the Feishu client.
pub fn build_ack_frame(received: &Frame, biz_rt_ms: u128) -> Frame {
    let mut ack = received.clone();
    ack.headers.push(Header {
        key: HEADER_KEY_BIZ_RT.to_string(),
        value: biz_rt_ms.to_string(),
    });
    ack.payload = format!("{{\"code\":{}}}", HTTP_STATUS_OK).into_bytes();
    ack
}

/// Look up a header value by key in a Frame's headers list.
pub fn get_header(frame: &Frame, key: &str) -> Option<String> {
    frame
        .headers
        .iter()
        .find(|h| h.key == key)
        .map(|h| h.value.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_frame_roundtrip() {
        let frame = build_ping_frame(123);
        let encoded = encode_frame(&frame);
        let decoded = decode_frame(&encoded).expect("decode should succeed");
        assert_eq!(decoded.seq_id, 0);
        assert_eq!(decoded.log_id, 0);
        assert_eq!(decoded.service, 123);
        assert_eq!(decoded.method, FRAME_TYPE_CONTROL);
        assert_eq!(decoded.headers.len(), 1);
        assert_eq!(decoded.headers[0].key, HEADER_KEY_TYPE);
        assert_eq!(decoded.headers[0].value, MESSAGE_TYPE_PING);
    }

    #[test]
    fn get_header_finds_value() {
        let frame = Frame {
            seq_id: 1,
            log_id: 1,
            service: 0,
            method: FRAME_TYPE_DATA,
            headers: vec![
                Header {
                    key: "type".to_string(),
                    value: "event".to_string(),
                },
                Header {
                    key: "message_id".to_string(),
                    value: "msg_123".to_string(),
                },
            ],
            payload_encoding: String::new(),
            payload_type: String::new(),
            payload: Vec::new(),
            log_id_new: String::new(),
        };
        assert_eq!(get_header(&frame, "type"), Some("event".to_string()));
        assert_eq!(get_header(&frame, "message_id"), Some("msg_123".to_string()));
        assert_eq!(get_header(&frame, "nonexistent"), None);
    }

    #[test]
    fn frame_field_numbers_match_proto() {
        // Verify that encoding produces the correct wire format by checking
        // the encoded bytes for a known frame.
        let frame = Frame {
            seq_id: 42,
            log_id: 0,
            service: 0,
            method: 0,
            headers: vec![],
            payload_encoding: String::new(),
            payload_type: String::new(),
            payload: Vec::new(),
            log_id_new: String::new(),
        };
        let encoded = encode_frame(&frame);
        // Field 1 (SeqID=42), varint encoding: tag=0x08 (field 1, wire type 0), value=42
        assert!(encoded.starts_with(&[0x08, 0x2A]),
            "Encoded frame should start with field 1 (SeqID) tag=0x08 value=42, got {:?}",
            &encoded[..4.min(encoded.len())]);
    }
}
