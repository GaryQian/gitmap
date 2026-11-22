use std::ops::{Add, Mul};

use serde::{Deserialize, Serialize};

/// Newton's constant, in m^3 kg^-1 s^-2.
pub const GRAVITATIONAL_CONSTANT: f64 = 6.674e-11;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Mass(pub f64);

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Length(f64);

impl Mass {
    pub fn kilograms(value: f64) -> Self {
        Mass(value)
    }
}

impl Length {
    pub fn from_metres(value: f64) -> Self {
        Length(value)
    }

    pub fn metres(&self) -> f64 {
        self.0
    }
}

impl Add for Length {
    type Output = Length;

    fn add(self, other: Length) -> Length {
        Length(self.0 + other.0)
    }
}

impl Mul<f64> for Mass {
    type Output = Mass;

    fn mul(self, factor: f64) -> Mass {
        Mass(self.0 * factor)
    }
}
