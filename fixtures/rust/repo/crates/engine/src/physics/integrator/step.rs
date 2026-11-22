use crate::body::Body;
use crate::units::Length;

/// One recorded time step.
#[derive(Debug, Clone, Copy)]
pub struct Step {
    pub index: usize,
    pub energy: f64,
}

/// Semi-implicit Euler: velocity first, then position.
pub fn advance(body: &mut Body, force: [f64; 2], dt: f64) {
    for axis in 0..2 {
        body.velocity[axis] += force[axis] / body.mass.0 * dt;
        body.position[axis] = body.position[axis] + Length::from_metres(body.velocity[axis] * dt);
    }
}

pub(in crate::physics) fn kinetic_energy(body: &Body) -> f64 {
    let speed_squared: f64 = body.velocity.iter().map(|v| v * v).sum();
    0.5 * body.mass.0 * speed_squared
}
