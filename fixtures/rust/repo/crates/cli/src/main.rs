mod args;
mod report;

use std::process::ExitCode;

use clap::Parser;
use orbit_engine::physics::integrator::simulate;
use orbit_engine::units::{Length, Mass};
use orbit_engine::{version, Body};

use crate::args::Args;

fn main() -> ExitCode {
    let args = Args::parse();
    if args.verbose {
        eprintln!("orbit {}", version());
    }
    let mut bodies = vec![
        Body::new("earth", Mass::kilograms(5.972e24), [Length::from_metres(0.0), Length::from_metres(0.0)]),
        Body::new("moon", Mass::kilograms(7.348e22), [Length::from_metres(3.844e8), Length::from_metres(0.0)]),
    ];
    match simulate(&mut bodies, args.steps, args.dt) {
        Ok(steps) => {
            report::print_report(&bodies, &steps, args.json);
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("error: {err}");
            ExitCode::FAILURE
        }
    }
}
