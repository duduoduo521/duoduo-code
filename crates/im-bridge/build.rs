//! Build script for im-bridge.
//!
//! No longer requires protoc! The pbbp2 proto types are hand-defined
//! in `src/feishu/proto.rs` using `prost::Message` derive macros,
//! eliminating the need for `prost-build` and the `protoc` binary.
//!
//! This makes the build fully cross-platform (Windows/macOS/Linux)
//! without requiring users to install protoc separately.

fn main() {
    // No proto compilation needed — types are hand-defined in code.
    // Tell Cargo to re-run if the proto file changes (for reference only).
    println!("cargo:rerun-if-changed=proto/pbbp2.proto");
}
