//! dashboard-rs library: config, shell, and (in later phases) the runtime
//! seam, bridge, and route handlers. `main.rs` is the thin binary that
//! wires them to a listener; tests target this library.

pub mod config;
pub mod shell;
