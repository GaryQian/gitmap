mod step;

use super::gravity::attraction;
use crate::body::Body;
use crate::EngineError;

pub use self::step::Step;

/// Advances every body `steps` times by `dt` seconds and records each step.
pub fn simulate(bodies: &mut [Body], steps: usize, dt: f64) -> Result<Vec<Step>, EngineError> {
    super::validate(bodies)?;
    let mut history = Vec::with_capacity(steps);
    for index in 0..steps {
        let forces = net_forces(bodies);
        for (body, force) in bodies.iter_mut().zip(forces) {
            step::advance(body, force, dt);
        }
        history.push(Step { index, energy: bodies.iter().map(step::kinetic_energy).sum() });
    }
    Ok(history)
}

fn net_forces(bodies: &[Body]) -> Vec<[f64; 2]> {
    let mut forces = vec![[0.0; 2]; bodies.len()];
    for (i, a) in bodies.iter().enumerate() {
        for b in bodies.iter().skip(i + 1) {
            let magnitude = attraction(a, b);
            let distance = a.distance_to(b).metres().max(f64::MIN_POSITIVE);
            for axis in 0..2 {
                let direction = (b.position[axis].metres() - a.position[axis].metres()) / distance;
                forces[i][axis] += magnitude * direction;
            }
        }
    }
    forces
}
