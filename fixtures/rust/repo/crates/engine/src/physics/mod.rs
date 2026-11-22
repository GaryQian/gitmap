//! Forces and time stepping.

mod gravity;
pub mod integrator;

pub use gravity::attraction;

use crate::body::Body;
use crate::EngineError;

/// Rejects inputs the integrator cannot advance.
pub fn validate(bodies: &[Body]) -> Result<(), EngineError> {
    if bodies.is_empty() {
        return Err(EngineError::Empty);
    }
    match bodies.iter().position(|body| !body.is_finite()) {
        Some(index) => Err(EngineError::NonFinite(index)),
        None => Ok(()),
    }
}
