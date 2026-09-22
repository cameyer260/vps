//! dashboard-rs library: config, shell, runtime seam, bridge, and
//! route handlers. `main.rs` is the thin binary that
//! wires them to a listener; tests target this library.

pub mod config;
pub mod runtime;
pub mod shell;
// Phase 3 (bridge): entry state + pi RPC + SSE chat stream + GC reaper.
pub mod bridge;
pub mod events;
pub mod gc;
pub mod markdown;
