use std::io::{self, Write};

use orbit_engine::physics::integrator::Step;
use orbit_engine::Body;

/// Prints the final state, as JSON or as a table.
pub fn print_report(bodies: &[Body], steps: &[Step], json: bool) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let result = if json {
        let text = serde_json::to_string_pretty(bodies).unwrap_or_default();
        writeln!(out, "{text}")
    } else {
        write_table(&mut out, bodies, steps)
    };
    if let Err(err) = result {
        eprintln!("could not write the report: {err}");
    }
}

fn write_table(out: &mut impl Write, bodies: &[Body], steps: &[Step]) -> io::Result<()> {
    for body in bodies {
        writeln!(out, "{body:<24} x = {:>12.3e} m", body.position[0].metres())?;
    }
    if let Some(last) = steps.last() {
        writeln!(out, "kinetic energy after step {}: {:.3e} J", last.index, last.energy)?;
    }
    Ok(())
}
