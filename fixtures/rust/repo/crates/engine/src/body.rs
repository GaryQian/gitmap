use std::fmt;

use serde::{Deserialize, Serialize};

use crate::units::{Length, Mass};

/// A point mass on the orbital plane.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Body {
    pub name: String,
    pub mass: Mass,
    pub position: [Length; 2],
    pub velocity: [f64; 2],
}

impl Body {
    /// A body at rest.
    pub fn new(name: &str, mass: Mass, position: [Length; 2]) -> Self {
        Body { name: name.to_string(), mass, position, velocity: [0.0, 0.0] }
    }

    pub fn distance_to(&self, other: &Body) -> Length {
        let dx = other.position[0].metres() - self.position[0].metres();
        let dy = other.position[1].metres() - self.position[1].metres();
        Length::from_metres(dx.hypot(dy))
    }

    pub fn is_finite(&self) -> bool {
        self.mass.0.is_finite() && self.position.iter().all(|p| p.metres().is_finite())
    }
}

impl fmt::Display for Body {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({:.3e} kg)", self.name, self.mass.0)
    }
}
