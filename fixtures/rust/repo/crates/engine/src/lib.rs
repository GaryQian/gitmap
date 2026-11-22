//! Orbit engine: bodies, units and a small n-body integrator.

mod body;
pub mod physics;
pub mod units;

pub use body::Body;

use std::fmt;

/// Version string shown by front ends.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Why a simulation could not run.
#[derive(Debug)]
pub enum EngineError {
    /// There is nothing to simulate.
    Empty,
    /// The body at this index has a mass or position that is not finite.
    NonFinite(usize),
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EngineError::Empty => write!(f, "no bodies to simulate"),
            EngineError::NonFinite(index) => write!(f, "body {index} is not finite"),
        }
    }
}

impl std::error::Error for EngineError {}
