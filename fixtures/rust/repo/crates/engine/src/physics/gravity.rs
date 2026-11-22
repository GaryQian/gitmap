use crate::{
    body::Body,
    units::{Length, Mass, GRAVITATIONAL_CONSTANT}, // G and the quantities it relates
};

/// Magnitude of the force two bodies exert on each other, in newtons.
pub fn attraction(a: &Body, b: &Body) -> f64 {
    force(a.mass, b.mass, a.distance_to(b))
}

fn force(m1: Mass, m2: Mass, r: Length) -> f64 {
    let d = r.metres();
    if d == 0.0 {
        return 0.0;
    }
    GRAVITATIONAL_CONSTANT * m1.0 * m2.0 / (d * d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coincident_bodies_do_not_attract() {
        let here = [Length::from_metres(1.0), Length::from_metres(1.0)];
        let a = Body::new("a", Mass::kilograms(5.0), here);
        let b = Body::new("b", Mass::kilograms(7.0), here);
        assert_eq!(attraction(&a, &b), 0.0);
    }
}
