use std::path::PathBuf;

use clap::Parser;

/// Simulate a small system of bodies.
#[derive(Debug, Parser)]
#[command(name = "orbit", version)]
pub struct Args {
    /// Number of time steps.
    #[arg(long, default_value_t = 100)]
    pub steps: usize,
    /// Seconds per step.
    #[arg(long, default_value_t = 60.0)]
    pub dt: f64,
    /// Print JSON instead of a table.
    #[arg(long)]
    pub json: bool,
    #[arg(short, long)]
    pub verbose: bool,
    /// Write the report here instead of to standard output.
    #[arg(short, long)]
    pub output: Option<PathBuf>,
}
